/**
 * Agent-Net for a launcher without Electron (Node Host, docs/agent-net-session-plan.md 阶段 5): this device's identity on
 * the account's official Agent-Net network, its node (the core in a worker), and what the Device Link client and the
 * session layer need of it — the same contract the Desktop wires in `agentNetRuntime.ts`. Platform facts (credential
 * store, account token, worker and core files, settings) come in as ports; nothing here imports Electron
 * (docs/dev-rules/architecture-invariants.md §5).
 *
 * Scope: the official network of the signed-in account, between devices of that account. Cross-account sharing and
 * self-hosted relays stay on their existing Device Link paths on this launcher.
 */
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { AgentNetWorkerSocket, type AgentNetAppSocket, type SessionConfig, type SessionHandle } from '@cindy/agent-net';
import { identityFromSeed, publicBytes, verifyCertificate, type DeviceCertificate, type Identity } from '@cindy/agent-net-relay';
import { AgentNetClient, acceptEnrollment, createEnrollmentRequest, createTransportModeProof } from '@cindy/agent-net-relay/client';
import { acceptTransportStatement } from './agentNetTransportStatement.js';
import { agentNetStunServer } from '@cindy/agent-net-protocol';
import { AgentNetMembership } from '@cindy/agent-net';
import { readAgentNetDirectoryCache, writeAgentNetDirectoryCache } from './agentNetDirectoryCache.js';

/** One record in the launcher's credential store: the seed, and once enrolled the certificate and private keys. */
interface StoredIdentity {
  version: 1;
  seed: string;
  agentNet?: { certificate: DeviceCertificate; rootPublicKey: string; signingPrivateKey: string; transportPrivateKey: string };
}

export interface AgentNetNodePorts {
  /** The official Agent-Net service of this account's region (`agentNetApiBaseUrl`); null when the manifest has none. */
  base(): string | null;
  /** The signed-in account (the certificate subject) and this device, as the launcher verified them. */
  subject(): string | null;
  deviceId(): string | null;
  deviceName(): string;
  /** This device's 「Agent-Net (Beta)」 setting. Off (the default) means no Agent-Net at all. */
  enabled(): boolean;
  /** Still the same signed-in owner (no account change in between). */
  current(): boolean;
  /** The launcher's credential store record for `key`; values are written only there. */
  readSecret(key: string): Promise<string | null>;
  writeSecret(key: string, value: string): Promise<void>;
  /** `POST /api/agent-net/enroll` at `base` with the account's own token (the only request that carries it). */
  enroll(base: string, body: unknown): Promise<unknown>;
  fetch: typeof fetch;
  createWebSocket(url: string, options: { headers?: Record<string, string> }): Promise<unknown>;
  workerFile(): string | URL | null;
  coreModule(): Promise<WebAssembly.Module>;
  /**
   * The device ids in this account's Device Link device list (the official service), or null when it cannot be read now.
   * With it, devices removed there are refused on Agent-Net until they sign in again (packages/agent-net/src/membership.ts).
   */
  deviceLinkDeviceIds?(): Promise<readonly string[] | null>;
  /**
   * 这个账号与服务的名册缓存放在哪（agentNetDirectoryCache.ts）；不提供时不缓存。官方 Agent-Net 服务出故障时重启也能起来，
   * 直连的设备照常可用（和 Desktop 一样）。
   */
  directoryCacheFile?(): string | null;
  log: { info(message: string): void; warn(message: string): void };
}

const RENEWAL_MARGIN_MS = 24 * 60 * 60_000;

/** The credential record for this account on this region's service: one identity each, the name never the URL or account. */
function slotFor(base: string, subject: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['cindy-agent-net/node-identity/1', base, subject])).digest('hex').slice(0, 32);
  return `agent-net-${bytes}`;
}

/** Per Agent-Net service, the UDP server its /info last published (see openNodeSocket). */
const lastUdpServer = new Map<string, string>();

export function createAgentNetNode(ports: AgentNetNodePorts) {
  let socket: AgentNetAppSocket | null = null;
  let client: AgentNetClient | null = null;
  let sessionConfig: SessionConfig | null = null;
  let enrolling: Promise<AgentNetClient> | null = null;
  let rejoining: Promise<AgentNetClient> | null = null;
  /**
   * This device's own enrolled identity, kept while Agent-Net is off: like the Desktop, a device that has joined the network
   * signs every legacy link with its current mode, so peers that know it accept the relay link once it says it is off.
   */
  let member: AgentNetClient | null = null;
  /** The stored identity also after its certificate expired while off: it still signs "off" (agentNetTransportStatement.ts). */
  let statement: { identity: Identity; certificate: DeviceCertificate } | null = null;
  let loading: { slot: string; done: Promise<void> } | null = null;
  /** The latest `openSocket` call: an earlier one still opening (the connection restarted meanwhile) closes what it opened. */
  let openAttempt = 0;
  const connectedAt = new Map<string, number>();
  const assertCurrent = () => { if (!ports.current()) throw new Error('AGENT_NET_OWNER_CHANGED'); };
  /** Devices removed from the account in Device Link are refused here too; per account and service (membershipKey). */
  let membershipKey: string | null = null;
  const membership = ports.deviceLinkDeviceIds ? new AgentNetMembership({
    readDeviceLinkDeviceIds: async () => {
      const key = membershipKey;
      const ids = await ports.deviceLinkDeviceIds!();
      return key === membershipKey && ports.current() ? ids : null;
    },
    apply: (rule) => socket?.restrictPeers?.(rule),
    // Background reads only while this node is connected for the current owner.
    active: () => socket !== null && ports.current() && ports.enabled(),
    log: ports.log,
  }) : null;
  const currentMembership = (): AgentNetMembership | null => {
    if (!membership) return null;
    const key = JSON.stringify([ports.base(), ports.subject(), ports.deviceId()]);
    if (key !== membershipKey) { membership.reset(); membershipKey = key; }
    return membership;
  };

  const read = async (slot: string): Promise<StoredIdentity | null> => {
    const raw = await ports.readSecret(slot);
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredIdentity;
    if (value?.version !== 1 || typeof value.seed !== 'string') throw new Error('AGENT_NET_IDENTITY_UNREADABLE');
    return value;
  };
  const identity = (slot: string, stored: StoredIdentity): Identity => {
    const enrolled = stored.agentNet, deviceId = ports.deviceId();
    if (!deviceId) throw new Error('AGENT_NET_DEVICE_ID_REQUIRED');
    if (!enrolled) return identityFromSeed(slot, stored.seed, deviceId);
    const signingPrivateKey = createPrivateKey(enrolled.signingPrivateKey), transportPrivateKey = createPrivateKey(enrolled.transportPrivateKey);
    const c = enrolled.certificate;
    if (!verifyCertificate(enrolled.rootPublicKey, c, c.issuedAt) || c.subject !== ports.subject() || c.deviceId !== deviceId
      || c.signingKey !== publicBytes(signingPrivateKey) || c.transportKey !== publicBytes(transportPrivateKey)) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
    return { deviceId: c.deviceId, signingPrivateKey, transportPrivateKey, signingKey: c.signingKey, transportKey: c.transportKey };
  };
  const toClient = (base: string, slot: string, stored: StoredIdentity): AgentNetClient | null => {
    const enrolled = stored.agentNet;
    if (!enrolled || enrolled.certificate.expiresAt <= Date.now()) return null;
    return new AgentNetClient(base, identity(slot, stored), enrolled.certificate, enrolled.rootPublicKey, undefined, {
      fetch: ports.fetch, createWebSocket: (url, options) => ports.createWebSocket(url, options) as never });
  };

  /**
   * This device's member client on the official network: the stored one, renewed a day before expiry, or a new enrollment.
   * `rejoin` (「重新加入」, deviceRejoin.ts, as the Desktop's agentNetOfficial.ts): this device was removed from the account and
   * its stored certificate was revoked with it even if it has not expired, so it enrolls again whatever the expiry and asks the
   * service to lift the removal (`rejoin: true`); a failure never hands back the revoked certificate.
   */
  function ensureClient(options: { rejoin?: boolean } = {}): Promise<AgentNetClient> {
    const rejoin = options.rejoin === true;
    const inFlight = rejoining ?? (!rejoin ? enrolling : null);
    if (inFlight) return inFlight;
    const pendingRenewal = rejoin ? enrolling : null;
    const work = (async () => {
      assertCurrent();
      const base = ports.base(), subject = ports.subject();
      if (!base || !subject) throw new Error('AGENT_NET_UNAVAILABLE');
      const slot = slotFor(base, subject);
      if (pendingRenewal) {
        await pendingRenewal.catch(() => undefined);
        assertCurrent();
        if (ports.base() !== base || ports.subject() !== subject) throw new Error('AGENT_NET_OWNER_CHANGED');
      }
      let stored = await read(slot); assertCurrent();
      if (!stored) { stored = { version: 1, seed: randomBytes(32).toString('base64url') }; await ports.writeSecret(slot, JSON.stringify(stored)); }
      const ready = rejoin ? null : toClient(base, slot, stored);
      if (ready && ready.certificate.expiresAt - Date.now() > RENEWAL_MARGIN_MS) return ready;
      const keys = identity(slot, stored);
      const request = createEnrollmentRequest(keys, ports.deviceName().trim().slice(0, 64) || 'Cindy Host');
      let response: unknown;
      try { response = await ports.enroll(base, rejoin ? { ...request, rejoin: true } : request); }
      catch (error) { assertCurrent(); if (ready) return ready; throw error; }
      assertCurrent();
      const enrolled = acceptEnrollment(keys, response, subject, stored.agentNet?.rootPublicKey);
      const next: StoredIdentity = { ...stored, agentNet: { ...enrolled,
        signingPrivateKey: String(keys.signingPrivateKey.export({ type: 'pkcs8', format: 'pem' })),
        transportPrivateKey: String(keys.transportPrivateKey.export({ type: 'pkcs8', format: 'pem' })) } };
      await ports.writeSecret(slot, JSON.stringify(next)); assertCurrent();
      return toClient(base, slot, next)!;
    })();
    if (rejoin) rejoining = work; else enrolling = work;
    void work.then((api) => { if (ports.current()) member = api; }, () => undefined);
    void work.finally(() => {
      if (enrolling === work) enrolling = null;
      if (rejoining === work) rejoining = null;
    }).catch(() => undefined);
    return work;
  }

  /**
   * Reads the stored identity once per account, never enrolling: what `transportAttestation` signs with while Agent-Net is
   * off. A device that never joined has no record (and no peer insists on a statement from it); failures leave it unsigned.
   */
  function loadMember(): Promise<void> {
    const base = ports.base(), subject = ports.subject();
    if (!base || !subject || !ports.deviceId() || !ports.current()) return Promise.resolve();
    const slot = slotFor(base, subject);
    if (loading?.slot === slot) return loading.done;
    const attempt: { slot: string; done: Promise<void> } = { slot, done: Promise.resolve() };
    attempt.done = (async () => {
      try {
        const stored = await read(slot);
        const api = stored && ports.current() ? toClient(base, slot, stored) : null;
        if (api && !member && ports.subject() === subject) member = api;
        if (stored?.agentNet && ports.current() && ports.subject() === subject)
          statement = { identity: identity(slot, stored), certificate: stored.agentNet.certificate };
      } catch {
        // Locked or unreadable store: the next connection tries again.
        if (loading === attempt) loading = null;
        ports.log.warn('agent-net identity unavailable for the transport statement');
      }
    })();
    loading = attempt;
    return attempt.done;
  }

  /**
   * This account and service refused this device's Agent-Net identity (revoked there, e.g. after a Device Link deletion): this run
   * is as with Agent-Net off, on the Device Link relay, which decides by itself (as the Desktop's `agentNetIdentityRefused`).
   */
  let refusedFor: string | null = null;
  const refusalFor = () => JSON.stringify([ports.base(), ports.subject(), ports.deviceId()]);
  const identityRefused = () => refusedFor !== null && refusedFor === refusalFor();
  function noteIdentityRefused(reason: string): void {
    if (!identityRefused()) ports.log.warn(`agent-net refused this device (${reason}); running on Device Link until the account changes`);
    refusedFor = refusalFor();
  }
  function active(): boolean {
    return ports.enabled() && ports.current() && !!ports.base() && !!ports.subject() && !!ports.deviceId() && !identityRefused();
  }

  /**
   * Opens this device's node for the Device Link client to use as its WebSocket, or null when Agent-Net is off.
   * The relay's STUN and UDP forwarding are used when it publishes them; sessions follow `useSessions`.
   */
  async function openSocket(userId: string): Promise<AgentNetAppSocket | null> {
    try { return await openNodeSocket(userId); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!/^AGENT_NET_UPGRADE_(401|403)$/.test(message) && (error as { code?: unknown } | null)?.code !== 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL') throw error;
      noteIdentityRefused(message || 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL');
      // This attempt's credentials were taken for Agent-Net; the relay client's next attempt runs on Device Link.
      throw new Error('AGENT_NET_IDENTITY_REFUSED');
    }
  }
  async function openNodeSocket(userId: string): Promise<AgentNetAppSocket | null> {
    if (!active()) return null;
    const attempt = ++openAttempt;
    // Like the Desktop (agentNetRuntime.ts): without this a slower earlier attempt finished last, replaced the socket the
    // client was using and closed it (2026-11-17 review).
    const assertLatest = () => { assertCurrent(); if (attempt !== openAttempt) throw new Error('AGENT_NET_CONNECTION_SUPERSEDED'); };
    const api = await ensureClient(); assertLatest();
    const workerFile = ports.workerFile();
    if (!workerFile) throw new Error('AGENT_NET_WORKER_BUNDLE_MISSING');
    // Devices removed in Device Link are refused from the first directory on: read the list once first if this account has
    // none yet, alongside the relay information below (at most 3 s; without it the node connects and refuses them later).
    const members = currentMembership();
    const openedKey = membershipKey;
    /** Still this account and service (a later change resets the membership for the next one). */
    const liveMembers = () => { const now = currentMembership(); return now && membershipKey === openedKey && ports.current() ? now : null; };
    const listing = members && !members.hasDeviceList()
      ? Promise.race([members.prime(), new Promise<void>((resolve) => { (setTimeout(resolve, 3000) as { unref?: () => void }).unref?.(); })]) : null;
    const module = await ports.coreModule(); assertLatest();
    const cacheFile = ports.directoryCacheFile?.() ?? null;
    const cache = cacheFile ? await readAgentNetDirectoryCache(cacheFile, assertLatest) : { devices: [], expiresAt: 0 };
    // Its own validated certificate, so the node starts during a relay outage; never an unverified remote identity.
    if (!cache.devices.some((entry) => entry?.certificate?.deviceId === api.identity.deviceId)) {
      cache.devices.push({ certificate: api.certificate, name: '', online: false, remoteControlEnabled: false, capabilities: [] });
    }
    members?.noteDirectory(cache.devices.filter((view) => view?.certificate?.deviceId).map((view) => ({ deviceId: view.certificate.deviceId, online: false })));
    const stunServers: string[] = [];
    let relayUdpServer: string | undefined;
    let answered = false;
    try {
      const response = await ports.fetch(api.base + '/api/agent-net/info', { signal: AbortSignal.timeout(5000) });
      const server = response.ok ? agentNetStunServer(api.base, await response.json()) : null;
      answered = response.ok;
      if (server) { stunServers.push(server); relayUdpServer = server; lastUdpServer.set(api.base, server); }
      else if (answered) lastUdpServer.delete(api.base);
    } catch { /* An older relay publishes neither; the node stays on its WebSocket. */ }
    assertLatest();
    // As the Desktop (agentNetRuntime.ts): when /info cannot be read the last UDP server of this service is kept.
    const remembered = answered ? undefined : lastUdpServer.get(api.base);
    if (remembered) { stunServers.push(remembered); relayUdpServer = remembered; }
    if (listing) { await listing; assertLatest(); }
    const opened = await AgentNetWorkerSocket.open({ workerFile, client: api, assertCurrent, module, userId, stunServers, relayUdpServer,
      cachedDirectory: cache.devices, directoryExpiresAt: cache.expiresAt,
      ...(members ? { peerRule: members.rule() } : {}),
      onDirectory(directory) {
        liveMembers()?.noteDirectory(directory.map((view) => ({ deviceId: view.certificate.deviceId, online: view.online })));
        if (cacheFile && ports.current()) writeAgentNetDirectoryCache(cacheFile, directory);
      },
      log: ports.log, onPathChanged(deviceId, route) { if (route) connectedAt.set(deviceId, performance.now()); else connectedAt.delete(deviceId); } });
    try { assertLatest(); } catch (error) { opened.close(); throw error; }
    const previous = socket; socket = opened; client = api; previous?.close();
    const live = liveMembers();
    if (live) opened.restrictPeers?.(live.rule());
    if (sessionConfig) opened.useSessions?.(sessionConfig);
    // A long-running launcher renews its certificate a day ahead on the same node: existing connections keep running.
    let renewal: ReturnType<typeof setTimeout> | undefined;
    const scheduleRenewal = (expiresAt: number, retry = false) => {
      renewal = setTimeout(() => {
        if (socket !== opened) return;
        void ensureClient().then(async (next) => {
          assertCurrent(); if (socket !== opened) return;
          if (next.certificate.signature !== client?.certificate.signature) { await opened.replaceClient(next); client = next; }
          scheduleRenewal(next.certificate.expiresAt);
        }).catch(() => { if (socket === opened) scheduleRenewal(expiresAt, true); });
      }, retry ? 60_000 : Math.max(60_000, expiresAt - Date.now() - RENEWAL_MARGIN_MS));
      (renewal as { unref?: () => void }).unref?.();
    };
    scheduleRenewal(api.certificate.expiresAt);
    opened.once('close', () => { if (renewal) clearTimeout(renewal); if (socket === opened) { socket = null; connectedAt.clear(); } });
    return opened;
  }

  return {
    active,
    /** This device's member client (enrolled or renewed as needed); `openSocket` uses the same one. */
    member: (): Promise<AgentNetClient> => ensureClient(),
    /**
     * 「重新加入」 (deviceRejoin.ts): asks the official service to take this removed device back, enrolling again whatever its
     * certificate's expiry, then forgets the refusal so the next connection uses Agent-Net again. 'skipped' when there is nothing
     * to lift: Agent-Net is off and this device never enrolled on this account's service.
     */
    async rejoin(): Promise<'rejoined' | 'skipped'> {
      const base = ports.base(), subject = ports.subject();
      if (!base || !subject || !ports.deviceId()) return 'skipped';
      if (!ports.enabled() && !(await read(slotFor(base, subject)))?.agentNet) return 'skipped';
      await ensureClient({ rejoin: true });
      refusedFor = null;
      return 'rejoined';
    },
    openSocket,
    useSessions(config: SessionConfig) { sessionConfig = config; socket?.useSessions?.(config); },
    session(peer: string): SessionHandle | null { return socket?.session?.(peer) ?? null; },
    connectedAt(peer: string): number | null { return connectedAt.get(peer) ?? null; },
    /** This account's device on this node: online on Agent-Net now (connected, or online in the directory), offline, or not known. */
    agentNetPeer(peer: string): 'online' | 'offline' | null {
      if (!active() || !socket?.knowsPeer(peer)) return null;
      return socket.supports(peer) ? 'online' : 'offline';
    },
    /** Connects to it before the first link so the session exists before the first message (PortableSocket.connectSession). */
    connect(peer: string): Promise<boolean> { return socket?.connectSession?.(peer) ?? Promise.resolve(false); },
    route(peer: string) { return { path: socket?.pathTo(peer) ?? null, rttMs: socket?.peerSnapshot(peer)?.rttMs ?? null }; },
    /** Session requests to this relayed peer timed out: the socket judges whether relay UDP carries data (relayUdp.ts noteStall). */
    relayStalled(_peer: string): void { socket?.relayStalled?.(); },
    /** A peer this node has never seen in its signed directory is an older (Device Link only) device. */
    shouldUseLegacyPeer(peer: string): boolean { return socket?.knowsPeer(peer) === false; },
    shouldProbeLegacyPeer(peer: string): boolean { return !!socket?.knowsPeer(peer) && !socket.supports(peer); },
    /** Load the stored identity before the first legacy link while Agent-Net is off (see `member`). */
    prepareTransportStatement: loadMember,
    /**
     * Signed statement for a legacy link: whether this device runs Agent-Net now (peers that know it insist on it), on or
     * off alike, as the Desktop does. Only this account's unexpired certificate signs; otherwise there is no statement.
     */
    transportAttestation(peer: string, requestId: string): unknown {
      if (!ports.current()) return undefined;
      const own = (c: DeviceCertificate) => c.subject === ports.subject() && c.deviceId === ports.deviceId();
      const api = client ?? member;
      try {
        if (api && own(api.certificate) && api.certificate.expiresAt > Date.now())
          return createTransportModeProof(api.identity, peer, requestId, active());
        // Expired while Agent-Net was off (it renews only while on): still "off", signed with this device's own key; peers accept
        // only that from an expired certificate.
        const expired = api && own(api.certificate) ? api : statement && own(statement.certificate) ? statement : null;
        return expired && !active() ? createTransportModeProof(expired.identity, peer, requestId, false) : undefined;
      } catch { return undefined; }
    },
    verifyTransportAttestation(peer: string, requestId: string, proof: unknown): boolean {
      if (!socket?.knowsPeer(peer)) return true;
      try {
        const rule = membership?.rule();
        const accepted = !rule || (!rule.refused.includes(peer) && (rule.allowed === null || rule.allowed.includes(peer)));
        if (!client) return false;
        const listed = socket.certificateFor(peer);
        if (listed) return acceptTransportStatement(client.rootPublicKey, listed, socket.deviceId, requestId, proof, accepted);
        // Gone from the signed directory (revoked there): only its own "off", with the certificate it last had.
        return acceptTransportStatement(client.rootPublicKey, socket.lastKnownCertificateFor?.(peer), socket.deviceId, requestId, proof,
          accepted, { offOnly: true });
      } catch { return false; }
    },
    /** The relay closed this node as refused (4410 while connected); see `refusedFor`. */
    noteIdentityRefused,
    prefersPrimary(payload: unknown): boolean {
      const value = payload as { capabilities?: string[]; transportAttestation?: { enabled?: unknown } } | null;
      const mode = value?.transportAttestation?.enabled;
      return typeof mode === 'boolean' ? mode : value?.capabilities?.includes('agent-net-node-v2') === true;
    },
    /** Closes the node; the stored identity stays for the statement (it is this device's own record). */
    close() { socket?.close(); socket = null; client = null; connectedAt.clear(); membership?.reset(); },
  };
}
export type AgentNetNode = ReturnType<typeof createAgentNetNode>;
