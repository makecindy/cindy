/**
 * SSH access CONTROLLER (decisions 2026-11-26, docs/dev-rules/protocol-compatibility/device-link-ssh-access.md): this
 * desktop's side of "my other devices can SSH into that computer". When a same-account desktop TARGET announces that
 * SSH access is on, this computer enrolls its dedicated key there (dedicatedKey.ts), reads the endpoint and keeps one
 * host for it in 远程连接 → SSH 远程主机 and the terminal alias `ssh cindy-<name>` (~/.ssh/cindy.conf), with the
 * device's host keys pinned for both (~/.ssh/cindy_known_hosts and Cindy's own host-key store). Desktop only; the
 * device link, the SSH host list and the key generator arrive through ports (assembly: sshAccessController.desktop.ts).
 *
 * - Triggers: the device's announce push, the person's 「添加到 SSH 远程主机」, and bounded retries. No relay polling: the
 *   steady state costs nothing on the relay. An announce whose revision equals the one the host was last brought up
 *   to date with (and whose `authorized` matches this computer's current key) needs no call at all.
 * - One operation per device at a time; a newer trigger waits and runs once afterwards. Busy, backpressure and
 *   timeouts retry after 30 s, 2 min and 10 min, then wait for the next announce. Calls run at background priority.
 * - Every step is tied to the owner scope and a generation captured at the start: an account switch or the device link
 *   stopping drops the work in flight, and the next owner's record is read from its own file.
 * - A device answering CHANNEL_NOT_ALLOWED (or lacking background links) "needs a Cindy update": it is not called
 *   again until its app version changes. Version numbers are never used to guess the capability.
 * - This computer's own 「控制它」 switch for a device being off means no enrollment there (decision 2).
 * - Deleting the host in the SSH list (or its block in cindy.conf) is final: it is never added back automatically; the
 *   enrollment stays and 「添加到 SSH 远程主机」 brings the host back.
 * - The alias follows the device's name (decision 2026-11-28): when the device is renamed in the device list, the
 *   host moves to `cindy-<new name>` (chooseDeviceAlias when that is taken) without a call to the device; the pinned
 *   HostKeyAlias does not change. The old alias stops working. A deleted host stays deleted, and a host that remote
 *   sessions still use keeps its alias until they are gone.
 * - A device turning access off, revoking this computer or leaving the account marks the host unavailable; nothing the
 *   person can see is deleted, and the next good status makes it available again.
 */
import {
  parseSshAccessAnnounce,
  parseSshAccessStatus,
  sshAccessErrorCode,
  type SshAccessAnnounce,
  type SshAccessParsedBlock,
  type SshAccessRequest,
  type SshAccessStatus,
} from '@cindy/device-link';
import type { OpenSshKeyPair } from '@cindy/maker-remote-ssh';
import type { SshDeviceHostView } from '../../shared/sshAccess.js';
import { createDedicatedKey, loadDedicatedKey, type DedicatedKey } from './dedicatedKey.js';
import { DEVICE_KNOWN_HOSTS_SETTING, chooseDeviceAlias, deviceHostKeyAlias } from './deviceHostNames.js';
import { KnownHostsFileError, updateCindyKnownHosts } from './knownHostsFile.js';
import { sshKeyFingerprint } from './sshAccessRecord.js';
import {
  SSH_DEVICE_ACCESS_MAX_TARGETS,
  emptySshDeviceTarget,
  readSshDeviceAccessRecord,
  updateSshDeviceAccessRecord,
  type SshDeviceAccessRecord,
  type SshDeviceEndpointRecord,
  type SshDeviceTargetRecord,
} from './sshDeviceAccessRecord.js';

/** Transient failures retry after these delays, then wait for the device's next announce. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const KEY_COMMENT = 'cindy-ssh-access';
/** The order Cindy's ssh2 client offers host key types: the first one the device has is the one to pin. */
const HOST_KEY_PREFERENCE = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];

export interface SshAccessControllerPeer {
  /** A same-account desktop: not a phone, not a shared-task or provider-share peer, not this computer. */
  desktop: boolean;
  /** Its name in the device list, for the alias and the host's display name. */
  name?: string;
}

/** One host for one of the person's devices, written through the SSH host list (remote-ssh/index.ts). */
export interface DeviceHostSpec {
  alias: string;
  displayName: string;
  /** The display name Cindy set before; the host's own name follows a rename only while it still equals this. */
  previousDisplayName: string | null;
  hostname: string;
  port: number;
  user: string;
  identityFile: string;
  hostKeyAlias: string;
  userKnownHostsFile: string;
  /** `SHA256:…` of the host key Cindy's ssh2 client negotiates first, pinned under `hostKeyAlias`. */
  hostKeyFingerprint: string;
}

/** `missing`: the host should be there and is not (the person deleted it). `alias-taken`: one of their own hosts. */
export type DeviceHostUpsertOutcome = 'created' | 'updated' | 'unchanged' | 'missing' | 'alias-taken';
/** `missing`: gone or no longer this device's. `alias-taken`: another host has it. `in-use`: sessions use the old alias. */
export type DeviceHostRenameOutcome = 'renamed' | 'missing' | 'alias-taken' | 'in-use';

type InvokeResult = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export interface SshAccessControllerPorts {
  /** The committed owner's scope, or null while signed out or during an owner transition. */
  ownerScope(): string | null;
  /** `owners/<owner>/ssh-device-access.json` of that owner, or null. */
  recordPath(): string | null;
  /** `owners/<owner>/ssh-access` (the dedicated key's directory), or null. */
  keyDir(): string | null;
  /** This computer's device id on the device link, or null before it is known. */
  selfDeviceId(): string | null;
  homeDir(): string;
  peer(deviceId: string): SshAccessControllerPeer | null;
  /** This computer's own 「控制它」 switch for that device is off. */
  controlDisabled(deviceId: string): boolean;
  /** `device-link:ssh-access:v1` in the background; the invoke result, or a thrown transport error. */
  invoke(deviceId: string, request: SshAccessRequest): Promise<InvokeResult>;
  /** Bounded local SSH banner probe; no relay request. Host keys are still verified when connecting. */
  probeAddress(host: string, port: number): Promise<boolean>;
  /**
   * Every alias in the SSH host list (any file), for picking a free one, with the HostKeyAlias of hosts Cindy
   * pins in its own file (null for the others).
   */
  hostAliases(): Promise<ReadonlyMap<string, string | null>>;
  upsertHost(spec: DeviceHostSpec, options: { expectPresent: boolean }): Promise<DeviceHostUpsertOutcome>;
  /** Moves the host from `fromAlias` to `spec.alias` (same HostKeyAlias and pin); never reported as the person's deletion. */
  renameHost(fromAlias: string, spec: DeviceHostSpec): Promise<DeviceHostRenameOutcome>;
  generateKeyPair(comment: string): Promise<OpenSshKeyPair>;
  /** Local UI: the device hosts' state may have changed. */
  onChanged?(): void;
  now?(): number;
  random?(): number;
  log: { info(message: string): void; warn(message: string): void };
}

/** `rename`: the device's name changed; the host follows it from what is recorded, without calling the device. */
type Trigger = { kind: 'announce'; announce: SshAccessAnnounce } | { kind: 'refresh' } | { kind: 'rename' };
/** How a failed call is handled: recorded on the device (`needs-update`, `off`, `revoked`, `refused`), shown
 * (`control-off`), retried (`transient`) or left for the device's next announce (`offline`, `write-failed`). */
export type SshAccessCallFailure =
  | 'needs-update' | 'off' | 'revoked' | 'control-off' | 'offline' | 'transient' | 'write-failed' | 'refused';
type Failure = SshAccessCallFailure;
interface Captured { scope: string; generation: number }

class AccountChangedError extends Error {
  constructor() {
    super('account changed');
    this.name = 'AccountChangedError';
  }
}

/** Errors thrown by the device link (the target was never reached, or refused at admission). */
export function classifySshAccessThrown(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('[DEVICE_LINK_CONTROL_DISABLED]')) return 'control-off';
  if (message.includes('[UNSUPPORTED_CAPABILITY]')) return 'needs-update';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'CHANNEL_NOT_ALLOWED') return 'needs-update';
  if (code === 'ACCESS_REVOKED') return 'revoked';
  if (code === 'REMOTE_DISABLED') return 'off';
  if (code === 'DEVICE_OFFLINE') return 'offline';
  return 'transient';
}

/** An error the target's dispatcher answered with. */
export function classifySshAccessResult(error: { code: string; message: string }): Failure {
  if (error.code === 'CHANNEL_NOT_ALLOWED') return 'needs-update';
  if (error.code === 'ACCESS_REVOKED') return 'revoked';
  if (error.code === 'REMOTE_DISABLED') return 'off';
  switch (sshAccessErrorCode(error.message)) {
    case 'SSH_ACCESS_DISABLED': return 'off';
    case 'SSH_ACCESS_WRITE_FAILED': return 'write-failed';
    case 'SSH_ACCESS_KEY_IN_USE':
    case 'SSH_ACCESS_INVALID': return 'refused';
    default: return 'transient';
  }
}

function pinnedHostKey(hostKeys: readonly string[]): string | null {
  for (const type of HOST_KEY_PREFERENCE) {
    const key = hostKeys.find((line) => line.startsWith(`${type} `));
    if (key) return key;
  }
  return null;
}

export type SshAccessController = ReturnType<typeof createSshAccessController>;

export function createSshAccessController(ports: SshAccessControllerPorts) {
  const now = () => ports.now?.() ?? Date.now();
  let active = false;
  let scope: string | null = null;
  let generation = 0;
  let record: SshDeviceAccessRecord | null = null;
  let recordUnreadable = false;
  let recordLoad: Promise<SshDeviceAccessRecord | null> | null = null;
  let keyReady: Promise<DedicatedKey> | null = null;
  const running = new Map<string, Promise<void>>();
  const pending = new Map<string, Trigger>();
  const retries = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null }>();
  const lastAnnounce = new Map<string, SshAccessAnnounce>();
  const controlOff = new Set<string>();
  const versions = new Map<string, string>();
  const backgroundTasks = new Set<Promise<unknown>>();

  function changed(): void {
    try { ports.onChanged?.(); } catch { /* UI refresh is best effort */ }
  }

  function clearRetries(): void {
    for (const entry of retries.values()) if (entry.timer) clearTimeout(entry.timer);
    retries.clear();
  }

  /** Switches to the current owner: everything cached for the previous one is forgotten. */
  function adoptScope(): string | null {
    const next = ports.ownerScope();
    if (next === scope) return scope;
    scope = next;
    generation += 1;
    record = null;
    recordUnreadable = false;
    recordLoad = null;
    keyReady = null;
    pending.clear();
    clearRetries();
    lastAnnounce.clear();
    controlOff.clear();
    versions.clear();
    return scope;
  }

  function capture(): Captured | null {
    if (!active) return null;
    const current = adoptScope();
    return current === null ? null : { scope: current, generation };
  }

  function isCurrent(captured: Captured): boolean {
    return active && captured.generation === generation && ports.ownerScope() === captured.scope;
  }

  function assertCurrent(captured: Captured): void {
    if (!isCurrent(captured)) throw new AccountChangedError();
  }

  async function loadRecord(captured: Captured): Promise<SshDeviceAccessRecord | null> {
    if (record) return record;
    if (recordUnreadable) return null;
    recordLoad ??= (async () => {
      const file = ports.recordPath();
      if (!file) return null;
      const read = await readSshDeviceAccessRecord(file);
      if (!isCurrent(captured)) return null;
      if (read.status !== 'ready') {
        recordUnreadable = true;
        ports.log.warn('ssh-access controller record is unreadable; leaving device hosts as they are');
        return null;
      }
      record = read.record;
      return record;
    })().finally(() => { recordLoad = null; });
    const loaded = await recordLoad;
    assertCurrent(captured);
    return loaded;
  }

  async function mutate(captured: Captured, apply: (current: SshDeviceAccessRecord) => SshDeviceAccessRecord | null): Promise<SshDeviceAccessRecord> {
    const file = ports.recordPath();
    if (!file) throw new AccountChangedError();
    const next = await updateSshDeviceAccessRecord(file, apply, () => assertCurrent(captured));
    assertCurrent(captured);
    record = next;
    changed();
    return next;
  }

  /** Changes one device's entry from its value on disk; `create` adds it when missing. */
  function patchTarget(
    captured: Captured,
    deviceId: string,
    patch: (current: SshDeviceTargetRecord) => Partial<SshDeviceTargetRecord> | null,
    create = false,
  ): Promise<SshDeviceAccessRecord> {
    return mutate(captured, (current) => {
      const existing = current.targets[deviceId];
      if (!existing && (!create || Object.keys(current.targets).length >= SSH_DEVICE_ACCESS_MAX_TARGETS)) return null;
      const base = existing ?? emptySshDeviceTarget(now());
      const change = patch(base);
      if (!change && existing) return null;
      return { ...current, targets: { ...current.targets, [deviceId]: { ...base, ...change, updatedAt: now() } } };
    });
  }

  /** The dedicated key, made once per owner and again when the record says it was made for another device. */
  function ensureKey(captured: Captured, forDevice: string): Promise<DedicatedKey> {
    keyReady ??= (async () => {
      const dir = ports.keyDir();
      const self = ports.selfDeviceId();
      if (!dir || !self) throw new AccountChangedError();
      let key = await loadDedicatedKey(dir);
      assertCurrent(captured);
      const madeFor = record?.keyDeviceId ?? null;
      const replaced = !!key || Object.values(record?.targets ?? {}).some((target) => target.enrolledFingerprint);
      if (!key || (madeFor !== null && madeFor !== self)) {
        // No key yet, or the profile was copied from another computer: one fingerprint belongs to one device.
        key = await createDedicatedKey(dir, (comment) => ports.generateKeyPair(comment), KEY_COMMENT);
        ports.log.info(`ssh-access controller created its dedicated key ${key.fingerprint}`);
        if (replaced) repairAfterNewKey(forDevice);
      }
      assertCurrent(captured);
      if (madeFor !== self) await mutate(captured, (current) => ({ ...current, keyDeviceId: self }));
      return key;
    })();
    const ready = keyReady;
    void ready.catch(() => { if (keyReady === ready) keyReady = null; });
    return ready;
  }

  /** Listed hosts use the key file that just changed: each of their devices enrolls the new key once. */
  function repairAfterNewKey(except: string): void {
    for (const [deviceId, target] of Object.entries(record?.targets ?? {})) {
      if (deviceId !== except && target.hostAdded && !target.userDeleted) {
        queueMicrotask(() => schedule(deviceId, { kind: 'refresh' }));
      }
    }
  }

  function resetRetries(deviceId: string): void {
    const entry = retries.get(deviceId);
    if (entry?.timer) clearTimeout(entry.timer);
    retries.delete(deviceId);
  }

  function scheduleRetry(deviceId: string): void {
    const entry = retries.get(deviceId) ?? { attempts: 0, timer: null };
    if (entry.timer) return;
    if (entry.attempts >= RETRY_DELAYS_MS.length) {
      ports.log.info(`ssh-access controller waits for ${deviceId.slice(0, 8)} to announce again`);
      return;
    }
    const delay = RETRY_DELAYS_MS[entry.attempts]! * (0.9 + 0.2 * (ports.random?.() ?? Math.random()));
    entry.attempts += 1;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      schedule(deviceId, { kind: 'refresh' });
    }, delay);
    (entry.timer as { unref?: () => void }).unref?.();
    retries.set(deviceId, entry);
  }

  async function handleFailure(captured: Captured, deviceId: string, failure: Failure): Promise<void> {
    switch (failure) {
      case 'needs-update':
        await patchTarget(captured, deviceId, () => ({ needsUpdateVersion: versions.get(deviceId) ?? 'unknown', revision: null }), true);
        return;
      case 'off':
      case 'revoked':
        await patchTarget(captured, deviceId, () => ({ status: failure, blocked: null, revision: null }));
        return;
      case 'control-off':
        controlOff.add(deviceId);
        changed();
        return;
      case 'write-failed':
        // The device saved the key and retries writing its file; it announces once the key is in.
        await patchTarget(captured, deviceId, () => ({ status: 'pending', revision: null }));
        return;
      case 'refused':
        ports.log.warn(`ssh-access controller: ${deviceId.slice(0, 8)} refused this computer's key or request`);
        await patchTarget(captured, deviceId, () => ({ status: 'error', revision: null }));
        return;
      case 'transient':
        scheduleRetry(deviceId);
        return;
      case 'offline':
        return;
    }
  }

  /** One call; null after a failure (already recorded or scheduled). */
  async function call(captured: Captured, deviceId: string, request: SshAccessRequest): Promise<SshAccessStatus<SshAccessParsedBlock> | null> {
    let result: InvokeResult;
    try {
      result = await ports.invoke(deviceId, request);
    } catch (error) {
      assertCurrent(captured);
      await handleFailure(captured, deviceId, classifySshAccessThrown(error));
      return null;
    }
    assertCurrent(captured);
    if (!result.ok) {
      await handleFailure(captured, deviceId, classifySshAccessResult(result.error));
      return null;
    }
    const status = parseSshAccessStatus(result.result);
    if (!status) {
      await handleFailure(captured, deviceId, 'refused');
      return null;
    }
    return status;
  }

  function enrollRequest(key: DedicatedKey): SshAccessRequest {
    const random = Math.floor((ports.random?.() ?? Math.random()) * 2 ** 48).toString(36);
    return { action: 'enroll', requestId: `enroll-${now().toString(36)}-${random}`.slice(0, 64), publicKey: key.publicKey };
  }

  /** Brings the host in line with an authorized, unblocked status (never re-adding one the person deleted). */
  async function placeHost(captured: Captured, deviceId: string, status: SshAccessStatus<SshAccessParsedBlock>, key: DedicatedKey): Promise<void> {
    const endpoint = status.endpoint!;
    const hostKeyAlias = deviceHostKeyAlias(deviceId);
    const hostKey = pinnedHostKey(endpoint.hostKeys);
    const reachable = await Promise.all(endpoint.addresses.map(async (address) =>
      (await ports.probeAddress(address.host, endpoint.port)) ? address.host : null));
    assertCurrent(captured);
    const hostname = reachable.find((host): host is string => host !== null);
    if (!hostKey || !hostname) {
      await patchTarget(captured, deviceId, () => ({ status: 'blocked', blocked: 'UNKNOWN', revision: null, enrolledFingerprint: key.fingerprint }));
      if (hostKey && !hostname) scheduleRetry(deviceId);
      return;
    }
    const facts = { user: endpoint.user, port: endpoint.port, hostname, hostKeys: [...endpoint.hostKeys] };
    const ready = { status: 'ready' as const, blocked: null, revision: status.revision, enrolledFingerprint: key.fingerprint, endpoint: facts, needsUpdateVersion: null };
    const target = record?.targets[deviceId];
    if (!target || target.userDeleted) {
      await patchTarget(captured, deviceId, () => ready, true);
      return;
    }
    try {
      await updateCindyKnownHosts(ports.homeDir(), [{ hostKeyAlias, hostKeys: facts.hostKeys }]);
    } catch (error) {
      // The terminal alias cannot verify the device until this is fixed; Cindy's own connection still can.
      if (!(error instanceof KnownHostsFileError)) throw error;
      ports.log.warn(`ssh-access controller could not update cindy_known_hosts: ${error.message}`);
    }
    assertCurrent(captured);
    await writeHost(captured, deviceId, facts, hostKey, ready, key);
  }

  /** The device's name in the device list, or null while it is not known. */
  function peerName(deviceId: string): string | null {
    return ports.peer(deviceId)?.name?.trim() || null;
  }

  /** A listed host whose device has a name Cindy has not given the host yet. */
  function nameStale(deviceId: string, target: SshDeviceTargetRecord): boolean {
    const name = peerName(deviceId);
    return target.hostAdded && !target.userDeleted && name !== null && name !== target.displayName;
  }

  /** The device was renamed: rewrite its listed host from the recorded endpoint (no call to the device). */
  async function followRename(captured: Captured, deviceId: string, target: SshDeviceTargetRecord, key: DedicatedKey): Promise<void> {
    const hostKey = target.endpoint ? pinnedHostKey(target.endpoint.hostKeys) : null;
    if (!target.endpoint || !hostKey || target.status !== 'ready' || target.enrolledFingerprint !== key.fingerprint) return;
    await writeHost(captured, deviceId, target.endpoint, hostKey, {}, key);
  }

  /**
   * Writes the listed host of a device whose key is enrolled and whose endpoint is known. The alias follows the
   * device's name: a new name moves the host to the alias chooseDeviceAlias gives it (the pin stays).
   */
  async function writeHost(
    captured: Captured,
    deviceId: string,
    facts: SshDeviceEndpointRecord,
    hostKey: string,
    ready: Partial<SshDeviceTargetRecord>,
    key: DedicatedKey,
  ): Promise<void> {
    const hostKeyAlias = deviceHostKeyAlias(deviceId);
    let target = record?.targets[deviceId];
    if (!target || target.userDeleted) return;
    const name = peerName(deviceId);
    const others = () => new Set(Object.entries(record?.targets ?? {})
      .filter(([id, entry]) => id !== deviceId && entry.alias).map(([, entry]) => entry.alias!));
    const spec = (alias: string): DeviceHostSpec => ({
      alias,
      displayName: name ?? alias,
      previousDisplayName: target!.displayName,
      hostname: facts.hostname,
      port: facts.port,
      user: facts.user,
      identityFile: key.privateKeyPath,
      hostKeyAlias,
      userKnownHostsFile: DEVICE_KNOWN_HOSTS_SETTING,
      hostKeyFingerprint: sshKeyFingerprint(hostKey),
    });
    let alias = target.alias;
    if (!alias) {
      const known = await ports.hostAliases();
      // A host Cindy already keeps for this device (an earlier record, another profile) is reused, not duplicated.
      alias = [...known].find(([, pinned]) => pinned === hostKeyAlias)?.[0]
        ?? chooseDeviceAlias(name, deviceId, new Set([...known.keys(), ...others()]));
    } else if (target.hostAdded && name) {
      const taken = new Set([...(await ports.hostAliases()).keys(), ...others()]);
      taken.delete(alias);
      assertCurrent(captured);
      const desired = chooseDeviceAlias(name, deviceId, taken);
      if (desired !== alias) {
        const moved = await ports.renameHost(alias, spec(desired));
        assertCurrent(captured);
        if (moved === 'renamed') {
          ports.log.info(`ssh-access controller: the host for ${deviceId.slice(0, 8)} follows the device's new name`);
          alias = desired;
          // The host exists only under the new alias now; record it before anything else can fail.
          await patchTarget(captured, deviceId, () => ({ alias: desired }));
        } else if (moved === 'in-use') {
          ports.log.info(`ssh-access controller: remote sessions still use the host for ${deviceId.slice(0, 8)}; keeping its alias`);
        }
        // `missing` is found again by the upsert below and recorded as the person's deletion; `alias-taken` keeps it.
      }
    }
    assertCurrent(captured);
    target = record?.targets[deviceId] ?? target;
    let outcome = await ports.upsertHost(spec(alias), { expectPresent: target.hostAdded });
    if (outcome === 'alias-taken' && !target.hostAdded) {
      // One of the person's own hosts has that name now: take another free one.
      alias = chooseDeviceAlias(name, deviceId, new Set([...(await ports.hostAliases()).keys(), ...others(), alias]));
      outcome = await ports.upsertHost(spec(alias), { expectPresent: false });
    }
    assertCurrent(captured);
    if (outcome === 'missing' || outcome === 'alias-taken') {
      ports.log.info(`ssh-access controller: the host for ${deviceId.slice(0, 8)} was deleted by the person; not adding it back`);
      await patchTarget(captured, deviceId, () => ({ ...ready, userDeleted: true, hostAdded: false }));
      return;
    }
    await patchTarget(captured, deviceId, () => ({ ...ready, alias, hostAdded: true, displayName: name ?? alias }));
  }

  async function processTarget(deviceId: string, trigger: Trigger, captured: Captured): Promise<void> {
    const loaded = await loadRecord(captured);
    if (!loaded || !ports.peer(deviceId)?.desktop) return;
    const announce = trigger.kind === 'announce' ? trigger.announce : null;
    let target: SshDeviceTargetRecord | undefined = loaded.targets[deviceId];
    if (trigger.kind === 'rename') {
      if (!target || !nameStale(deviceId, target) || target.needsUpdateVersion || ports.controlDisabled(deviceId)) return;
      await followRename(captured, deviceId, target, await ensureKey(captured, deviceId));
      return;
    }
    if (announce) lastAnnounce.set(deviceId, announce);
    if (target?.needsUpdateVersion) {
      // An announce proves the channel exists now; a new app version may have it too.
      const version = versions.get(deviceId);
      if (!announce && (!version || version === target.needsUpdateVersion)) return;
      await patchTarget(captured, deviceId, () => ({ needsUpdateVersion: null }));
    }
    if (announce && !announce.enabled) {
      if (target && target.status !== 'off') await patchTarget(captured, deviceId, () => ({ status: 'off', blocked: null, revision: null }));
      return;
    }
    if (!target && !announce) return;
    if (target?.userDeleted && announce) {
      // Never re-added automatically: only remember that the device offers access again.
      if (target.status !== 'pending' && target.status !== 'ready') await patchTarget(captured, deviceId, () => ({ status: 'pending' }));
      return;
    }
    if (ports.controlDisabled(deviceId)) {
      if (!controlOff.has(deviceId)) { controlOff.add(deviceId); changed(); }
      return;
    }
    if (controlOff.delete(deviceId)) changed();
    if (!target) target = (await patchTarget(captured, deviceId, () => ({}), true)).targets[deviceId];
    if (!target) return;
    const key = await ensureKey(captured, deviceId);
    const stale = target.enrolledFingerprint !== key.fingerprint;
    if (announce && announce.authorized && !stale && announce.revision === target.revision
      && target.status === 'ready' && target.hostAdded) {
      if (nameStale(deviceId, target)) await followRename(captured, deviceId, target, key);
      return;
    }
    // The device does not hold this computer's current key: enroll, which replaces this computer's line only.
    let enrolled = !!announce && (!announce.authorized || stale);
    let status = await call(captured, deviceId, enrolled ? enrollRequest(key) : { action: 'status' });
    if (!status) return;
    if (!enrolled && status.enabled && !status.blocked && (!status.authorized || stale)) {
      enrolled = true;
      status = await call(captured, deviceId, enrollRequest(key));
      if (!status) return;
    }
    const confirmed = enrolled && status.authorized ? { enrolledFingerprint: key.fingerprint } : {};
    if (!status.enabled) {
      resetRetries(deviceId);
      await patchTarget(captured, deviceId, () => ({ status: 'off', blocked: null, revision: null }));
    } else if (status.blocked) {
      resetRetries(deviceId);
      await patchTarget(captured, deviceId, () => ({ status: 'blocked', blocked: status!.blocked, revision: null, ...confirmed }));
    } else if (!status.authorized) {
      resetRetries(deviceId);
      // The device keeps the key and announces once its authorized-keys file holds it.
      await patchTarget(captured, deviceId, () => ({ status: 'pending', revision: null }));
    } else if (!status.endpoint) {
      resetRetries(deviceId);
      await patchTarget(captured, deviceId, () => ({ status: 'blocked', blocked: 'UNKNOWN', revision: null, ...confirmed }));
    } else {
      await placeHost(captured, deviceId, status, key);
      if (record?.targets[deviceId]?.status === 'ready') resetRetries(deviceId);
    }
  }

  function schedule(deviceId: string, trigger: Trigger): void {
    if (running.has(deviceId)) {
      // Every other trigger also brings the name up to date; a rename must not replace one of them.
      if (trigger.kind !== 'rename' || !pending.has(deviceId)) pending.set(deviceId, trigger);
      return;
    }
    const captured = capture();
    if (!captured) return;
    const run = processTarget(deviceId, trigger, captured)
      .catch((error: unknown) => {
        if (error instanceof AccountChangedError) return;
        ports.log.warn(`ssh-access controller (${deviceId.slice(0, 8)}) failed: ${error instanceof Error ? error.message : String(error)}`);
        if (isCurrent(captured)) scheduleRetry(deviceId);
      })
      .finally(() => {
        running.delete(deviceId);
        const next = pending.get(deviceId);
        pending.delete(deviceId);
        if (next && isCurrent(captured)) schedule(deviceId, next);
      });
    running.set(deviceId, run);
  }

  function view(deviceId: string, target: SshDeviceTargetRecord): SshDeviceHostView {
    const unavailable = target.status === 'off' || target.status === 'blocked' || target.status === 'revoked' || target.status === 'removed';
    const state: SshDeviceHostView['state'] = target.needsUpdateVersion ? 'needs-update'
      : target.userDeleted ? 'user-deleted'
        : controlOff.has(deviceId) ? 'control-off'
          : unavailable ? 'unavailable'
            : target.status === 'ready' && target.hostAdded ? 'ready'
              : target.status === 'error' ? 'error' : 'pending';
    return {
      deviceId,
      alias: target.alias,
      hostId: target.hostAdded ? target.alias : null,
      state,
      reason: state === 'unavailable' ? target.status as NonNullable<SshDeviceHostView['reason']> : null,
      blocked: state === 'unavailable' && target.status === 'blocked' ? target.blocked : null,
    };
  }

  async function readState(): Promise<SshDeviceHostView[]> {
    const captured = capture();
    if (!captured) return [];
    try {
      const loaded = await loadRecord(captured);
      return loaded ? Object.entries(loaded.targets).map(([deviceId, target]) => view(deviceId, target)) : [];
    } catch (error) {
      if (error instanceof AccountChangedError) return [];
      throw error;
    }
  }

  /** Runs a record change outside a device's queue; account changes and busy records are only logged. */
  function background(task: (captured: Captured) => Promise<unknown>): void {
    const captured = capture();
    if (!captured) return;
    const run = (async () => {
      if (await loadRecord(captured)) await task(captured);
    })().catch((error: unknown) => {
      if (!(error instanceof AccountChangedError)) {
        ports.log.warn(`ssh-access controller record update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).finally(() => { backgroundTasks.delete(run); });
    backgroundTasks.add(run);
  }

  return {
    /** The device link is up for the signed-in owner: load the record so the SSH list can label device hosts. */
    activate(): void {
      active = true;
      background(async () => changed());
    },
    /** The device link stopped (sign-out, lost ownership, quit): drop work in flight; files stay as they are. */
    deactivate(): void {
      active = false;
      generation += 1;
      pending.clear();
      clearRetries();
      controlOff.clear();
      lastAnnounce.clear();
      keyReady = null;
    },
    /** `device-link:ssh-access:announce` from a peer (the caller checked it is a same-account desktop). */
    receiveAnnounce(deviceId: string, payload: unknown): void {
      const announce = parseSshAccessAnnounce(payload);
      if (!active || !announce || !ports.peer(deviceId)?.desktop) return;
      resetRetries(deviceId);
      schedule(deviceId, { kind: 'announce', announce });
    },
    /**
     * The app version a peer reports (presence). A device marked "needs a Cindy update" is asked once more when its
     * version changes, and not before.
     */
    notePeerVersion(deviceId: string, version: string | undefined): void {
      if (!active || !version || versions.get(deviceId) === version) return;
      versions.set(deviceId, version);
      const marked = record?.targets[deviceId]?.needsUpdateVersion;
      if (marked && marked !== version) schedule(deviceId, { kind: 'refresh' });
    },
    /** The device's name in the device list may have changed: its listed host and alias follow it. */
    peerRenamed(deviceId: string): void {
      const target = record?.targets[deviceId];
      if (active && target && nameStale(deviceId, target)) schedule(deviceId, { kind: 'rename' });
    },
    /** A complete device list: devices that left the account are unavailable, ones that came back wait for them. */
    noteDeviceList(deviceIds: readonly string[]): void {
      const present = new Set(deviceIds);
      background(async (captured) => {
        for (const [deviceId, target] of Object.entries(record?.targets ?? {})) {
          const gone = !present.has(deviceId);
          if (gone && target.status !== 'removed') {
            await patchTarget(captured, deviceId, () => ({ status: 'removed', blocked: null, revision: null }));
          } else if (!gone && target.status === 'removed') {
            await patchTarget(captured, deviceId, () => ({ status: 'pending' }));
          }
        }
      });
    },
    /** The device closed this computer's link as revoked. */
    revokedBy(deviceId: string): void {
      background(async (captured) => {
        if (record?.targets[deviceId] && record.targets[deviceId]!.status !== 'revoked') {
          await patchTarget(captured, deviceId, () => ({ status: 'revoked', blocked: null, revision: null }));
        }
      });
    },
    /** This computer's own settings changed: a device whose 「控制它」 came back on gets its last announce again. */
    settingsChanged(): void {
      if (!active) return;
      for (const deviceId of [...controlOff]) {
        if (ports.controlDisabled(deviceId)) continue;
        controlOff.delete(deviceId);
        changed();
        const announce = lastAnnounce.get(deviceId);
        schedule(deviceId, announce ? { kind: 'announce', announce } : { kind: 'refresh' });
      }
    },
    /** The person deleted a host in the SSH list: if it is a device host, never add it back automatically. */
    hostRemovedByUser(hostId: string): void {
      background(async (captured) => {
        const entry = Object.entries(record?.targets ?? {}).find(([, target]) => target.alias === hostId && target.hostAdded);
        if (entry) await patchTarget(captured, entry[0], () => ({ userDeleted: true, hostAdded: false }));
      });
    },
    /** 「添加到 SSH 远程主机」 on a device whose host the person deleted. */
    async restoreHost(deviceId: string): Promise<SshDeviceHostView[]> {
      const captured = capture();
      if (!captured) return [];
      const loaded = await loadRecord(captured);
      if (loaded?.targets[deviceId]?.userDeleted) {
        await patchTarget(captured, deviceId, () => ({ userDeleted: false, hostAdded: false, revision: null }));
        resetRetries(deviceId);
        schedule(deviceId, { kind: 'refresh' });
      }
      return readState();
    },
    readState,
    /** The SSH list's label for a host: which device it belongs to and whether it can be used now. */
    deviceHostFor(hostId: string): { deviceId: string; available: boolean } | null {
      for (const [deviceId, target] of Object.entries(record?.targets ?? {})) {
        if (target.alias === hostId && target.hostAdded) {
          return { deviceId, available: target.status === 'ready' && !target.needsUpdateVersion && !controlOff.has(deviceId) };
        }
      }
      return null;
    },
    /** Test and shutdown helper: resolves once every queued device operation and record update has finished. */
    async idle(): Promise<void> {
      while (running.size || backgroundTasks.size) await Promise.allSettled([...running.values(), ...backgroundTasks]);
    },
  };
}
