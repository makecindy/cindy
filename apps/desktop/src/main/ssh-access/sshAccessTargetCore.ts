/**
 * SSH access TARGET: "allow my other devices to SSH into this computer" (decisions 2026-11-26,
 * docs/dev-rules/protocol-compatibility/device-link-ssh-access.md). Shared by the desktop (sshAccessTarget.desktop.ts)
 * and the Node Host (apps/host/src/ssh-access.ts); platform facts arrive through ports, no Electron imports.
 *
 * - Source of truth: the per-owner record `owners/<owner>/ssh-access.json` (sshAccessRecord.ts). The authorized-keys
 *   file (authorizedKeysFile.ts) is derived from it on every change and on start, and holds only keys that are allowed
 *   right now: the effective setting (the person's override, else on for Cindy cloud guests and off elsewhere) and the
 *   remote-control master switch are both on, and device keys belong to devices that are neither revoked nor removed
 *   from the account. Otherwise the file holds nothing; the record keeps every key for when access comes back.
 * - Keys that leave the file lose their SSH sessions (sessionTerminator.ts), except when a device withdraws or replaces
 *   its own key. Sessions whose key cannot be determined are only reported.
 * - Membership: device keys of devices no longer in the account's device list are dropped. The list is read through
 *   the same scheduler and throttle as Agent-Net's membership (AgentNetMembership: at most one read in flight, ≥10 s
 *   apart, every 5 min ±20 % while needed) and only while access is on and at least one device key exists.
 * - Announce: each online desktop peer gets `device-link:ssh-access:announce` when this target starts or the peer comes
 *   online, and when the revision or that peer's authorization changes. Nothing is sent while access is off, except one
 *   `enabled: false` to a peer that may still believe it is on (it has a key here, or was told it was on).
 * - All work runs in one queue and is tied to the owner scope captured at its start; an account switch mid-way fails
 *   the operation and the next reconcile applies the new owner's record (the old owner's keys leave the file).
 */
import { createHash } from 'node:crypto';
import { AgentNetMembership } from '@cindy/agent-net';
import {
  SSH_ACCESS_MAX_ADDRESSES,
  SSH_ACCESS_MAX_HOST_KEYS,
  SSH_ACCESS_VERSION,
  parseSshAccessRequest,
  parseSshEd25519PublicKey,
  type SshAccessAddress,
  type SshAccessAnnounce,
  type SshAccessBlock,
  type SshAccessEndpoint,
  type SshAccessErrorCode,
  type SshAccessStatus,
} from '@cindy/device-link';
import type { SshAccessLocalState, SshAccessSessionCleanup } from '../../shared/sshAccess.js';
import {
  AuthorizedKeysError,
  authorizedKeysTarget,
  readAuthorizedKeys,
  removeHeldCloudGuestFile,
  renderAuthorizedKeys,
  writeAuthorizedKeys,
  type AuthorizedKeyLine,
} from './authorizedKeysFile.js';
import type { SessionTerminator } from './sessionTerminator.js';
import {
  SSH_ACCESS_MAX_DEVICES,
  SSH_ACCESS_MAX_MANUAL_KEYS,
  SshAccessRecordError,
  isSshAccessDeviceId,
  normalizeSshKeyLabel,
  readSshAccessRecord,
  sshKeyFingerprint,
  updateSshAccessRecord,
  type SshAccessRecord,
} from './sshAccessRecord.js';

/** Re-probe sshd and re-hash the public state at most this often for status reads. */
const STATUS_TTL_MS = 30_000;
/** A blocked local sshd is probed again without making a server request. */
const SSHD_REPROBE_MS = 30_000;
/** Addresses and host keys are re-read after this long (and on a network change). */
const ENDPOINT_TTL_MS = 5 * 60_000;
/** Bursts (a settings write plus a status refresh) become one push per peer. */
const ANNOUNCE_DEBOUNCE_MS = 1_000;
/** The first write after start waits this long at most for the device list (cloud boot gate, item 12). */
const START_MEMBERSHIP_WAIT_MS = 10_000;
/** A failed derived-file write is retried after these delays, then every 10 minutes until it succeeds. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const WRITE_ATTEMPTS = 3;
const ED25519_IN_TEXT = /ssh-ed25519[ \t]+(AAAAC3NzaC1lZDI1NTE5AAAAI[A-P][A-Za-z0-9+/]{42})(?![A-Za-z0-9+/=])/g;

export interface SshAccessSettings {
  remoteControlEnabled: boolean;
  revokedControllers: readonly string[];
  /** The person's choice; absent = follow the default. */
  sshAccessEnabled?: boolean;
}

export interface SshEndpointFacts {
  user: string;
  port: number;
  lanAddresses: SshAccessAddress[];
  mdnsName: string | null;
  hostKeys: string[];
}

export interface SshAccessTargetPorts {
  platform: NodeJS.Platform | string;
  homeDir(): string;
  /** Stable per Cindy profile on this machine; names this profile's block in the authorized-keys file. */
  profileKey: string;
  /** The committed owner's scope, or null while signed out or during an owner transition. */
  ownerScope(): string | null;
  /** `owners/<owner>/ssh-access.json` of that owner, or null. */
  recordPath(): string | null;
  /** The managed pod/container cloud instance is never a target. */
  managedCloudInstance(): boolean;
  detectCloudGuest(): Promise<boolean>;
  readSettings(): SshAccessSettings;
  /** Stores (`boolean`) or deletes (`undefined`) the person's choice in device-link settings. */
  writeEnabledOverride(value: boolean | undefined): Promise<void>;
  /** Online, same-account desktop peers (not phones, not shared-task or provider-share guests, not this device). */
  onlineDesktopPeers(): readonly string[];
  sendAnnounce(deviceId: string, payload: SshAccessAnnounce): void;
  /** The existing per-device revoke path (「撤销访问权限」). */
  revokeDevice(deviceId: string): Promise<void>;
  deviceName?(deviceId: string): string | undefined;
  /** The account's device ids from the device directory; null when it cannot be read now. */
  readDeviceDirectory(): Promise<readonly string[] | null>;
  /** False while another process owns writes for this profile (the Host while a desktop uses it). */
  canWrite?(): boolean;
  probeSshd(port: number): Promise<boolean>;
  readEndpointFacts(): Promise<SshEndpointFacts>;
  /** Cloud guests only: the instance's public IPv4. */
  readPublicIpv4(): Promise<string | null>;
  terminator: SessionTerminator;
  /** Local UI: the state returned by `readLocal` may have changed. */
  onChanged?(): void;
  now?(): number;
  random?(): number;
  log: { info(message: string): void; warn(message: string): void };
}

/** Thrown with the wire error code; the dispatcher and the local IPC map it. */
export class SshAccessTargetError extends Error {
  constructor(readonly code: SshAccessErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'SshAccessTargetError';
  }
}

/**
 * Adding a public key while SSH_ACCESS_MAX_MANUAL_KEYS added keys are already allowed. Still SSH_ACCESS_UNAVAILABLE for
 * callers that only know the wire codes (the Host command line); the settings IPC tells the person the limit was
 * reached, where "try again later" would never help.
 */
export class SshAccessKeyLimitError extends SshAccessTargetError {
  constructor() {
    super('SSH_ACCESS_UNAVAILABLE', `too many keys: at most ${SSH_ACCESS_MAX_MANUAL_KEYS} added public keys`);
    this.name = 'SshAccessKeyLimitError';
  }
}

interface PublicState {
  enabled: boolean;
  blocked: SshAccessBlock | null;
  endpoint: SshAccessEndpoint | null;
  revision: number;
  at: number;
}

interface WriteOutcome {
  /** Public keys that left the file and are not authorized by any other line. */
  lost: string[];
}

export type SshAccessTarget = ReturnType<typeof createSshAccessTarget>;

export function createSshAccessTarget(ports: SshAccessTargetPorts) {
  const now = () => ports.now?.() ?? Date.now();
  const writable = () => ports.canWrite?.() ?? true;
  const supported = () => (ports.platform === 'darwin' || ports.platform === 'linux') && !ports.managedCloudInstance();

  let active = false;
  /** The owner scope whose record is applied to the file; null before the first reconcile. */
  let scope: string | null = null;
  let record: SshAccessRecord | null = null;
  let recordUnreadable = false;
  /** Keys in this profile's block after the last successful write (for `authorized`). */
  let derived = new Set<string>();
  let fileBlocked = false;
  let cloudGuest: boolean | null = null;
  let cloudGuestDetection: Promise<boolean> | null = null;
  let publicState: PublicState | null = null;
  let endpointCache: { facts: SshEndpointFacts; publicIpv4: string | null; at: number } | null = null;
  /** Last payload sent per peer in this process; cleared when the peer comes online again. */
  const sent = new Map<string, string>();
  const toldEnabled = new Set<string>();
  let announceTargets: Set<string> | 'all' | null = null;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let sshdProbeTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  let membershipPrimed = false;
  /** The cloud image's held file stays held until its first device directory check succeeds. */
  let cloudBootGatePending = false;
  let settingsKey: string | null = null;
  let lastCleanup: SshAccessSessionCleanup | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const membership = new AgentNetMembership({
    readDeviceLinkDeviceIds: () => ports.readDeviceDirectory(),
    // A changed list may drop device keys; reconcile in the queue.
    apply: () => { if (active && scope !== null) void reconcile('membership').catch(() => undefined); },
    active: () => active && membershipNeeded(),
    now: ports.now,
    random: ports.random,
    log: { info: (message) => ports.log.info(message.replace('agent-net membership', 'ssh-access membership')) },
  });

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function fail(code: SshAccessErrorCode, message: string): never {
    throw new SshAccessTargetError(code, message);
  }

  function assertScope(captured: string | null): asserts captured is string {
    if (!active || captured === null || ports.ownerScope() !== captured) fail('SSH_ACCESS_UNAVAILABLE', 'account changed');
  }

  function defaultSetting(): boolean {
    return cloudGuest === true;
  }

  function enabledFor(settings: SshAccessSettings): boolean {
    return supported() && scope !== null && settings.remoteControlEnabled && (settings.sshAccessEnabled ?? defaultSetting());
  }

  function membershipNeeded(): boolean {
    return enabledFor(ports.readSettings()) && !!record && Object.keys(record.devices).length > 0;
  }

  function deviceAllowed(deviceId: string, settings: SshAccessSettings): boolean {
    if (settings.revokedControllers.includes(deviceId)) return false;
    if (cloudGuest && !membership.hasDeviceList()) return false;
    const rule = membership.rule();
    return !rule.refused.includes(deviceId) && (rule.allowed === null || rule.allowed.includes(deviceId));
  }

  function manualComment(label: string): string {
    const slug = label.replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return `cindy-manual:${slug || 'key'}`;
  }

  function linesFor(settings: SshAccessSettings): AuthorizedKeyLine[] {
    if (!record || !enabledFor(settings)) return [];
    const devices = Object.entries(record.devices)
      .filter(([deviceId]) => deviceAllowed(deviceId, settings))
      .sort(([a, left], [b, right]) => left.enrolledAt - right.enrolledAt || a.localeCompare(b))
      .map(([deviceId, key]) => ({ publicKey: key.publicKey, comment: `cindy-device:${deviceId}` }));
    return [...devices, ...record.manualKeys.map((key) => ({ publicKey: key.publicKey, comment: manualComment(key.label) }))];
  }

  function keysIn(content: string | null): Set<string> {
    return new Set([...(content ?? '').matchAll(ED25519_IN_TEXT)].map((match) => `ssh-ed25519 ${match[1]}`));
  }

  function changed(): void {
    try { ports.onChanged?.(); } catch { /* UI refresh is best effort */ }
  }

  function scheduleRetry(): void {
    if (retryTimer || !active) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)]!;
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void reconcile('retry').catch(() => undefined);
    }, delay);
    (retryTimer as { unref?: () => void }).unref?.();
  }

  async function detectCloudGuest(): Promise<boolean> {
    if (cloudGuest !== null) return cloudGuest;
    cloudGuestDetection ??= (supported() ? ports.detectCloudGuest() : Promise.resolve(false)).catch(() => false);
    cloudGuest = await cloudGuestDetection;
    return cloudGuest;
  }

  /** Imports the keys of a hand-maintained cloud guest file as manual keys before Cindy takes the file over. */
  async function importHandMaintainedKeys(file: string, keys: ReadonlyArray<{ publicKey: string }>, captured: string): Promise<void> {
    record = await updateSshAccessRecord(file, (current) => {
      const known = new Set([...Object.values(current.devices), ...current.manualKeys].map((key) => key.fingerprint));
      const added = keys.map((key) => ({ publicKey: key.publicKey, fingerprint: sshKeyFingerprint(key.publicKey) }))
        .filter((key, index, all) => !known.has(key.fingerprint) && all.findIndex((other) => other.fingerprint === key.fingerprint) === index);
      if (!added.length) return null;
      if (current.manualKeys.length + added.length > SSH_ACCESS_MAX_MANUAL_KEYS) throw new AuthorizedKeysError('UNSUPPORTED', 'too many keys to import');
      return { ...current, manualKeys: [...current.manualKeys, ...added.map((key) => ({ ...key, label: 'imported', addedAt: now() }))] };
    }, () => assertScope(captured));
    ports.log.info(`ssh-access imported ${keys.length} key(s) from the hand-maintained cloud authorized keys file`);
  }

  /** Brings this profile's block in line with the record. `exempt` keys leave without ending their sessions. */
  async function writeDerived(captured: string, exempt: ReadonlySet<string> = new Set()): Promise<WriteOutcome> {
    const file = ports.recordPath() ?? fail('SSH_ACCESS_UNAVAILABLE', 'no account record');
    const target = authorizedKeysTarget(ports.homeDir(), cloudGuest ? 'cloud-guest' : 'user');
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const settings = ports.readSettings();
      const enabled = enabledFor(settings);
      let snapshot;
      try {
        snapshot = await readAuthorizedKeys(target, ports.profileKey);
        assertScope(captured);
        let takeOver = false;
        if (snapshot.unmanaged) {
          // Someone maintains this file by hand: leave it alone until access is on, and never take over lines that
          // cannot become manual keys (other key types, options).
          if (!enabled) { fileBlocked = false; derived = new Set(); return { lost: [] }; }
          if (snapshot.unimportable > 0) throw new AuthorizedKeysError('UNSUPPORTED', 'hand-maintained keys Cindy cannot import');
          await importHandMaintainedKeys(file, snapshot.importable, captured);
          takeOver = true;
        }
        const lines = linesFor(settings);
        const next = renderAuthorizedKeys(snapshot, lines, { takeOver });
        if (next !== null) await writeAuthorizedKeys(snapshot, next);
        assertScope(captured);
        const previous = derived;
        derived = new Set(lines.map((line) => line.publicKey));
        fileBlocked = false;
        retryIndex = 0;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        noteAuthorizationChanges(previous, derived);
        const remaining = keysIn(next ?? snapshot.content);
        return { lost: snapshot.current.filter((key) => !remaining.has(key) && !exempt.has(key)) };
      } catch (error) {
        if (error instanceof AuthorizedKeysError && error.code === 'CONFLICT' && attempt < WRITE_ATTEMPTS - 1) continue;
        if (error instanceof AuthorizedKeysError && error.code === 'UNSUPPORTED') {
          if (!fileBlocked) ports.log.warn(`ssh-access cannot manage ${target.kind} authorized keys: ${error.message}`);
          fileBlocked = true;
          derived = new Set();
          return { lost: [] };
        }
        if (error instanceof SshAccessTargetError) throw error;
        ports.log.warn(`ssh-access authorized keys write failed: ${error instanceof Error ? error.message : String(error)}`);
        scheduleRetry();
        fail('SSH_ACCESS_WRITE_FAILED', 'authorized keys could not be written');
      }
    }
    scheduleRetry();
    return fail('SSH_ACCESS_WRITE_FAILED', 'authorized keys kept changing');
  }

  async function endSessions(keys: readonly string[]): Promise<SshAccessSessionCleanup | null> {
    if (!keys.length) return null;
    const fingerprints = new Set(keys.map(sshKeyFingerprint));
    try {
      const report = await ports.terminator.terminateFingerprints(fingerprints);
      lastCleanup = { at: now(), ...report };
      if (report.terminated || report.unmapped) {
        ports.log.info(`ssh-access ended ${report.terminated} session(s) of ${keys.length} removed key(s); ${report.unmapped} unmapped`);
      }
    } catch (error) {
      ports.log.warn(`ssh-access session cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      lastCleanup = { at: now(), supported: true, terminated: 0, unmapped: 0 };
    }
    changed();
    return lastCleanup;
  }

  async function endpointFacts(): Promise<{ facts: SshEndpointFacts; publicIpv4: string | null }> {
    if (endpointCache && now() - endpointCache.at < ENDPOINT_TTL_MS) return endpointCache;
    const [facts, publicIpv4] = await Promise.all([ports.readEndpointFacts(), cloudGuest ? ports.readPublicIpv4() : null]);
    endpointCache = { facts, publicIpv4, at: now() };
    return endpointCache;
  }

  function endpointOf(facts: SshEndpointFacts, publicIpv4: string | null): SshAccessEndpoint {
    const addresses: SshAccessAddress[] = [];
    const add = (address: SshAccessAddress) => {
      if (addresses.length < SSH_ACCESS_MAX_ADDRESSES && !addresses.some((known) => known.host === address.host)) addresses.push(address);
    };
    if (publicIpv4) add({ kind: 'public', host: publicIpv4 });
    const lan = facts.lanAddresses.filter((address) => address.kind === 'lan');
    for (const address of lan.filter((row) => !row.host.includes(':'))) add(address);
    if (facts.mdnsName) add({ kind: 'mdns', host: facts.mdnsName });
    for (const address of lan.filter((row) => row.host.includes(':'))) add(address);
    return { user: facts.user, port: facts.port, addresses, hostKeys: facts.hostKeys.slice(0, SSH_ACCESS_MAX_HOST_KEYS) };
  }

  function revisionOf(state: Omit<PublicState, 'revision' | 'at'>): number {
    const digest = createHash('sha256').update(JSON.stringify([state.enabled, state.blocked, state.endpoint])).digest('hex');
    return Number.parseInt(digest.slice(0, 12), 16);
  }

  async function refreshPublic(force = false): Promise<PublicState> {
    if (!force && publicState && now() - publicState.at < STATUS_TTL_MS) return publicState;
    const enabled = enabledFor(ports.readSettings());
    let blocked: SshAccessBlock | null = null;
    let endpoint: SshAccessEndpoint | null = null;
    if (!supported()) blocked = 'PLATFORM_UNSUPPORTED';
    else if (enabled && fileBlocked) blocked = 'AUTHORIZED_KEYS_UNSUPPORTED';
    else if (enabled) {
      const unreachable: SshAccessBlock = ports.platform === 'darwin' ? 'REMOTE_LOGIN_OFF' : 'SSHD_UNREACHABLE';
      try {
        const { facts, publicIpv4 } = await endpointFacts();
        if (!(await ports.probeSshd(facts.port))) blocked = unreachable;
        else endpoint = endpointOf(facts, publicIpv4);
      } catch (error) {
        // Unreadable machine facts (no passwd entry, interfaces unavailable) leave nothing a peer could connect to.
        ports.log.warn(`ssh-access could not read this machine's SSH endpoint: ${error instanceof Error ? error.message : String(error)}`);
        blocked = unreachable;
      }
    }
    const previous = publicState?.revision;
    publicState = { enabled, blocked, endpoint, revision: revisionOf({ enabled, blocked, endpoint }), at: now() };
    if (blocked === 'SSHD_UNREACHABLE' || blocked === 'REMOTE_LOGIN_OFF') {
      if (!sshdProbeTimer && active) {
        const captured = scope;
        sshdProbeTimer = setTimeout(() => {
          sshdProbeTimer = null;
          if (active && captured !== null && scope === captured && ports.ownerScope() === captured) {
            void serial(() => refreshPublic(true)).catch(() => undefined);
          }
        }, SSHD_REPROBE_MS);
        (sshdProbeTimer as { unref?: () => void }).unref?.();
      }
    } else if (sshdProbeTimer) {
      clearTimeout(sshdProbeTimer);
      sshdProbeTimer = null;
    }
    if (previous !== publicState.revision) {
      scheduleAnnounce('all');
      changed();
    }
    return publicState;
  }

  function authorizedFor(deviceId: string): boolean {
    const key = record?.devices[deviceId]?.publicKey;
    return !!key && !!publicState?.enabled && derived.has(key);
  }

  function noteAuthorizationChanges(previous: ReadonlySet<string>, next: ReadonlySet<string>): void {
    for (const [deviceId, key] of Object.entries(record?.devices ?? {})) {
      if (previous.has(key.publicKey) !== next.has(key.publicKey)) scheduleAnnounce([deviceId]);
    }
  }

  function scheduleAnnounce(targets: readonly string[] | 'all'): void {
    if (!active) return;
    if (targets === 'all' || announceTargets === 'all') announceTargets = 'all';
    else announceTargets = new Set([...(announceTargets ?? []), ...targets]);
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      announceTimer = null;
      const pending = announceTargets;
      announceTargets = null;
      const peers = new Set(ports.onlineDesktopPeers());
      for (const deviceId of pending === 'all' ? peers : pending ?? []) if (peers.has(deviceId)) announceTo(deviceId);
    }, ANNOUNCE_DEBOUNCE_MS);
    (announceTimer as { unref?: () => void }).unref?.();
  }

  function announceTo(deviceId: string): void {
    const state = publicState;
    if (!active || !state || scope === null || ports.readSettings().revokedControllers.includes(deviceId)) return;
    // Access off: only a peer that may still believe it is on hears about it (no traffic for everyone else).
    if (!state.enabled && !toldEnabled.has(deviceId) && !record?.devices[deviceId]) return;
    const payload: SshAccessAnnounce = { version: SSH_ACCESS_VERSION, enabled: state.enabled, revision: state.revision, authorized: authorizedFor(deviceId) };
    const key = JSON.stringify(payload);
    if (sent.get(deviceId) === key) return;
    try {
      ports.sendAnnounce(deviceId, payload);
      sent.set(deviceId, key);
      if (state.enabled) toldEnabled.add(deviceId);
      else toldEnabled.delete(deviceId);
    } catch (error) {
      ports.log.warn(`ssh-access announce to ${deviceId.slice(0, 8)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Device-list reads run (on the shared schedule) exactly while some device key could be in the file. */
  function ensureMembership(): void {
    if (!membershipNeeded()) { membershipPrimed = false; return; }
    if (membershipPrimed) return;
    membershipPrimed = true;
    void membership.prime();
  }

  /** Switches to the current owner: forget everything cached for the previous one. */
  function adoptScope(): string | null {
    const next = ports.ownerScope();
    if (next === scope) return scope;
    scope = next;
    record = null;
    recordUnreadable = false;
    publicState = null;
    sent.clear();
    toldEnabled.clear();
    membership.reset();
    membershipPrimed = false;
    return scope;
  }

  /**
   * One pass: read the record, drop revoked and removed devices, rewrite the file, refresh the public state.
   * `startup` waits (bounded) for the device list before the first write and then clears the cloud boot gate.
   */
  async function reconcileNow(options: { startup?: boolean; exempt?: ReadonlySet<string> } = {}): Promise<WriteOutcome> {
    if (!active) return { lost: [] };
    const captured = adoptScope();
    const file = ports.recordPath();
    if (captured === null || !file) return { lost: [] };
    if (!supported()) {
      await refreshPublic(true);
      return { lost: [] };
    }
    const read = await readSshAccessRecord(file);
    assertScope(captured);
    if (read.status !== 'ready') {
      if (!recordUnreadable) ports.log.warn('ssh-access record is unreadable; leaving the authorized keys file unchanged');
      recordUnreadable = true;
      record = null;
      changed();
      return { lost: [] };
    }
    recordUnreadable = false;
    record = read.record;
    const settings = ports.readSettings();
    settingsKey = settingsKeyOf(settings);
    if (options.startup && membershipNeeded() && !membership.hasDeviceList()) {
      membershipPrimed = true;
      await Promise.race([membership.prime(), new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, START_MEMBERSHIP_WAIT_MS);
        (timer as { unref?: () => void }).unref?.();
      })]);
      assertScope(captured);
    }
    if (!writable()) {
      await refreshPublic(true);
      return { lost: [] };
    }
    // An unavailable directory is not evidence that these devices left the account. Keep their record entries so a
    // later successful read can restore only those still listed; the derived cloud file remains fail closed meanwhile.
    const stale = Object.keys(record.devices).filter((deviceId) =>
      ports.readSettings().revokedControllers.includes(deviceId)
      || (membership.hasDeviceList() && !deviceAllowed(deviceId, ports.readSettings())));
    if (stale.length) {
      record = await updateSshAccessRecord(file, (current) => {
        const devices = { ...current.devices };
        for (const deviceId of stale) delete devices[deviceId];
        return { ...current, devices };
      }, () => assertScope(captured));
      ports.log.info(`ssh-access dropped ${stale.length} key(s) of revoked or removed devices`);
    }
    const outcome = await writeDerived(captured, options.exempt);
    if (cloudBootGatePending && (!membershipNeeded() || membership.hasDeviceList()) && !fileBlocked) {
      await removeHeldCloudGuestFile(ports.homeDir())
        .then((removed) => { if (removed) ports.log.info('ssh-access released the cloud boot gate'); cloudBootGatePending = false; })
        .catch((error: unknown) => ports.log.warn(`ssh-access could not remove the held authorized keys file: ${String(error)}`));
    }
    ensureMembership();
    await refreshPublic(true);
    changed();
    return outcome;
  }

  /** A reconcile pass inside the queue; sessions of keys that left end in the background unless awaited. */
  async function runReconcile(reason: string, options: { startup?: boolean; exempt?: ReadonlySet<string>; awaitSessions?: boolean } = {}): Promise<SshAccessSessionCleanup | null> {
    try {
      const outcome = await reconcileNow(options);
      const cleanup = endSessions(outcome.lost);
      return options.awaitSessions ? await cleanup : null;
    } catch (error) {
      if (!(error instanceof SshAccessTargetError)) {
        ports.log.warn(`ssh-access reconcile (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`);
        scheduleRetry();
      }
      throw error;
    }
  }

  function reconcile(reason: string, options: { startup?: boolean; exempt?: ReadonlySet<string>; awaitSessions?: boolean } = {}): Promise<SshAccessSessionCleanup | null> {
    return serial(() => runReconcile(reason, options));
  }

  function settingsKeyOf(settings: SshAccessSettings): string {
    return JSON.stringify([settings.remoteControlEnabled, settings.sshAccessEnabled ?? null, [...settings.revokedControllers].sort()]);
  }

  async function statusFor(controller: string): Promise<SshAccessStatus> {
    const state = await refreshPublic();
    return {
      version: SSH_ACCESS_VERSION,
      enabled: state.enabled,
      blocked: state.blocked,
      authorized: authorizedFor(controller),
      revision: state.revision,
      endpoint: state.endpoint,
    };
  }

  /** The reply already tells the caller; skip the identical push. */
  function noteReplied(controller: string, status: SshAccessStatus): void {
    sent.set(controller, JSON.stringify({ version: SSH_ACCESS_VERSION, enabled: status.enabled, revision: status.revision, authorized: status.authorized }));
    if (status.enabled) toldEnabled.add(controller);
  }

  async function mutateRecord(captured: string, mutate: (current: SshAccessRecord) => SshAccessRecord | null): Promise<void> {
    if (!supported()) fail('SSH_ACCESS_UNAVAILABLE', 'SSH access is not supported on this computer');
    if (!writable()) fail('SSH_ACCESS_UNAVAILABLE', 'this profile is in use by another Cindy process');
    if (recordUnreadable) fail('SSH_ACCESS_UNAVAILABLE', 'the SSH access record is unreadable');
    const file = ports.recordPath() ?? fail('SSH_ACCESS_UNAVAILABLE', 'no account record');
    try {
      record = await updateSshAccessRecord(file, mutate, () => assertScope(captured));
    } catch (error) {
      if (error instanceof SshAccessTargetError) throw error;
      if (error instanceof SshAccessRecordError) fail('SSH_ACCESS_UNAVAILABLE', error.message);
      fail('SSH_ACCESS_WRITE_FAILED', 'the SSH access record could not be written');
    }
  }

  function fingerprintOwner(current: SshAccessRecord, fingerprint: string): string | null {
    for (const [deviceId, key] of Object.entries(current.devices)) if (key.fingerprint === fingerprint) return `device:${deviceId}`;
    return current.manualKeys.some((key) => key.fingerprint === fingerprint) ? 'manual' : null;
  }

  /** Inside the queue: the current owner's record is loaded and applied (a failed file write is retried later). */
  async function ensureReady(): Promise<string> {
    if (!active) fail('SSH_ACCESS_UNAVAILABLE', 'not running');
    const captured = ports.ownerScope() ?? fail('SSH_ACCESS_UNAVAILABLE', 'not signed in');
    if (captured !== scope || (!record && !recordUnreadable)) {
      await runReconcile('first-use').catch((error: unknown) => {
        if (!(error instanceof SshAccessTargetError) || error.code !== 'SSH_ACCESS_WRITE_FAILED') throw error;
      });
    }
    assertScope(captured);
    return captured;
  }

  async function localState(): Promise<SshAccessLocalState> {
    const settings = ports.readSettings();
    const state = await refreshPublic();
    return {
      supported: supported(),
      remoteControlEnabled: settings.remoteControlEnabled,
      setting: settings.sshAccessEnabled ?? defaultSetting(),
      defaultSetting: defaultSetting(),
      customized: settings.sshAccessEnabled !== undefined,
      cloudGuest: cloudGuest === true,
      enabled: state.enabled,
      blocked: state.blocked,
      endpoint: state.endpoint,
      devices: Object.entries(record?.devices ?? {})
        .sort(([a, left], [b, right]) => left.enrolledAt - right.enrolledAt || a.localeCompare(b))
        .map(([deviceId, key]) => ({
          deviceId,
          ...(ports.deviceName?.(deviceId) ? { deviceName: ports.deviceName(deviceId)! } : {}),
          fingerprint: key.fingerprint,
          enrolledAt: key.enrolledAt,
          active: state.enabled && derived.has(key.publicKey),
        })),
      manualKeys: (record?.manualKeys ?? []).map((key) => ({
        fingerprint: key.fingerprint, label: key.label, addedAt: key.addedAt, active: state.enabled && derived.has(key.publicKey),
      })),
      recordUnreadable,
      lastSessionCleanup: lastCleanup,
      endsDeviceSessions: ports.terminator.endsKeySessions,
    };
  }

  async function handleRemoteRequest(controller: string, raw: unknown): Promise<SshAccessStatus> {
    const request = parseSshAccessRequest(raw) ?? fail('SSH_ACCESS_INVALID', 'invalid request');
    const captured = await ensureReady();
    if (request.action !== 'status' && !isSshAccessDeviceId(controller)) fail('SSH_ACCESS_INVALID', 'invalid device');
    if (request.action === 'withdraw') {
      let withdrawn: string | undefined;
      await mutateRecord(captured, (current) => {
        withdrawn = current.devices[controller]?.publicKey;
        if (!withdrawn) return null;
        const devices = { ...current.devices };
        delete devices[controller];
        return { ...current, devices };
      });
      // A device withdrawing its own key keeps its open sessions.
      await writeDerived(captured, new Set(withdrawn ? [withdrawn] : []));
    } else if (request.action === 'enroll') {
      if (!enabledFor(ports.readSettings())) fail('SSH_ACCESS_DISABLED', 'SSH access is off on this computer');
      const publicKey = request.publicKey;
      const fingerprint = sshKeyFingerprint(publicKey);
      let replaced: string | undefined;
      await mutateRecord(captured, (current) => {
        const owner = fingerprintOwner(current, fingerprint);
        if (owner && owner !== `device:${controller}`) fail('SSH_ACCESS_KEY_IN_USE', 'this key belongs to another device or a manual key');
        if (current.devices[controller]?.publicKey === publicKey) return null;
        if (!current.devices[controller] && Object.keys(current.devices).length >= SSH_ACCESS_MAX_DEVICES) {
          fail('SSH_ACCESS_UNAVAILABLE', 'too many devices');
        }
        replaced = current.devices[controller]?.publicKey;
        return { ...current, devices: { ...current.devices, [controller]: { publicKey, fingerprint, enrolledAt: now() } } };
      });
      // Replacing one's own key is not losing access.
      ensureMembership();
      if (cloudGuest && !membership.hasDeviceList()) await membership.prime();
      await writeDerived(captured, new Set(replaced ? [replaced] : []));
    }
    const status = await statusFor(controller);
    noteReplied(controller, status);
    if (request.action !== 'status') changed();
    return status;
  }

  return {
    /** Starts (or resumes) for the signed-in owner: reconcile, clear the cloud boot gate, announce. */
    async activate(): Promise<void> {
      active = true;
      await detectCloudGuest();
      cloudBootGatePending = cloudGuest === true;
      await reconcile('activate', { startup: true }).catch(() => undefined);
      scheduleAnnounce('all');
    },
    /** The device link stopped (sign-out, lost ownership, quit). Files are left as they are. */
    deactivate(): void {
      active = false;
      if (announceTimer) { clearTimeout(announceTimer); announceTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (sshdProbeTimer) { clearTimeout(sshdProbeTimer); sshdProbeTimer = null; }
      announceTargets = null;
      sent.clear();
      membership.reset();
      membershipPrimed = false;
    },
    /**
     * The person signed out: this profile's block is emptied (the record stays with that owner) and the sessions of the
     * keys that left end. Runs even though the device link is already stopped.
     */
    signedOut(): Promise<void> {
      return serial(async () => {
        if (!supported() || !writable() || scope === null) return;
        const target = authorizedKeysTarget(ports.homeDir(), cloudGuest ? 'cloud-guest' : 'user');
        try {
          const snapshot = await readAuthorizedKeys(target, ports.profileKey);
          const next = renderAuthorizedKeys(snapshot, []);
          if (next !== null) await writeAuthorizedKeys(snapshot, next);
          const remaining = keysIn(next ?? snapshot.content);
          derived = new Set();
          scope = null;
          record = null;
          await endSessions(snapshot.current.filter((key) => !remaining.has(key)));
        } catch (error) {
          ports.log.warn(`ssh-access sign-out cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },
    /** Device-link settings may have changed (master switch, revocations, the SSH access choice). */
    settingsChanged(): void {
      if (!active || settingsKey === settingsKeyOf(ports.readSettings())) return;
      void reconcile('settings').catch(() => undefined);
    },
    peerOnline(deviceId: string): void {
      if (!active) return;
      sent.delete(deviceId);
      scheduleAnnounce([deviceId]);
    },
    networkChanged(): void {
      if (!active) return;
      endpointCache = null;
      void serial(() => refreshPublic(true)).catch(() => undefined);
    },
    /** A device-list read done elsewhere; saves a read here (AgentNetMembership.noteDeviceList). */
    noteDeviceList(deviceIds: readonly string[], startedAt: number): void {
      if (active && scope !== null) membership.noteDeviceList(deviceIds, startedAt);
    },
    /** device-link:ssh-access:v1 from an admitted same-account desktop (dispatch.ts). */
    handleRemote(controller: string, raw: unknown): Promise<SshAccessStatus> {
      return serial(() => handleRemoteRequest(controller, raw));
    },
    readLocal(): Promise<SshAccessLocalState> {
      return serial(async () => { await ensureReady(); return localState(); });
    },
    /** `null` restores the default (the stored choice is deleted). */
    async setEnabled(enabled: boolean | null): Promise<SshAccessLocalState> {
      await serial(async () => {
        await ensureReady();
        if (!writable()) fail('SSH_ACCESS_UNAVAILABLE', 'this profile is in use by another Cindy process');
        await ports.writeEnabledOverride(enabled === null ? undefined : enabled);
      });
      await reconcile('setting');
      return serial(localState);
    },
    addManualKey(text: string, label?: string): Promise<{ state: SshAccessLocalState; fingerprint: string }> {
      return serial(async () => {
        const captured = await ensureReady();
        const key = parseSshEd25519PublicKey(text)
          ?? fail('SSH_ACCESS_INVALID', 'only a single ssh-ed25519 public key line without options is accepted');
        const fingerprint = sshKeyFingerprint(key.publicKey);
        await mutateRecord(captured, (current) => {
          if (fingerprintOwner(current, fingerprint)) fail('SSH_ACCESS_KEY_IN_USE', 'this key is already allowed');
          if (current.manualKeys.length >= SSH_ACCESS_MAX_MANUAL_KEYS) throw new SshAccessKeyLimitError();
          return { ...current, manualKeys: [...current.manualKeys, {
            publicKey: key.publicKey, fingerprint, label: normalizeSshKeyLabel(label) || normalizeSshKeyLabel(key.comment), addedAt: now(),
          }] };
        });
        await writeDerived(captured);
        return { state: await localState(), fingerprint };
      });
    },
    removeManualKey(fingerprint: string): Promise<SshAccessLocalState> {
      return serial(async () => {
        const captured = await ensureReady();
        await mutateRecord(captured, (current) => (current.manualKeys.some((key) => key.fingerprint === fingerprint)
          ? { ...current, manualKeys: current.manualKeys.filter((key) => key.fingerprint !== fingerprint) } : null));
        const outcome = await writeDerived(captured);
        await endSessions(outcome.lost);
        return localState();
      });
    },
    /** 「移除」 on a device row = revoke that device's remote access; its key leaves with it. */
    removeDevice(deviceId: string): Promise<{ state: SshAccessLocalState; revoked: boolean; sessions: SshAccessSessionCleanup | null }> {
      return serial(async () => {
        if (!isSshAccessDeviceId(deviceId)) fail('SSH_ACCESS_INVALID', 'invalid device');
        await ensureReady();
        const wasRevoked = ports.readSettings().revokedControllers.includes(deviceId);
        // The revocation's own settings notification queues a reconcile behind this task; it finds nothing left to do.
        if (!wasRevoked) await ports.revokeDevice(deviceId);
        const sessions = await runReconcile('remove-device', { awaitSessions: true });
        return { state: await localState(), revoked: !wasRevoked, sessions };
      });
    },
    /** Ends every SSH session of this OS user (confirmed by the person); not limited to Cindy keys. */
    endAllSessions(): Promise<{ state: SshAccessLocalState; sessions: SshAccessSessionCleanup }> {
      return serial(async () => {
        await ensureReady();
        const report = await ports.terminator.terminateAll();
        lastCleanup = { at: now(), ...report };
        changed();
        return { state: await localState(), sessions: lastCleanup };
      });
    },
  };
}
