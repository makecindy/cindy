import { SocketEvents } from './socketEvents.js';
import { concatBytes, decodeUtf8, keyHex, utf8 } from './portableBytes.js';
import type { PeerRule, PortableSocketOptions, SocketClient, SocketDiscovery, SocketUplink } from './socketPorts.js';
import {
  CONTROL_KINDS, MAX_FRAME_BYTES, PROTOCOL_VERSION, ROUTED_KINDS, SERVER_CAPABILITY_NOTIFY,
  SHARED_TASK_RELAY_CAPABILITY, PROVIDER_SHARE_RELAY_CAPABILITY,
  type Envelope, type HelloPayload, type PresenceSnapshot,
} from '@cindy/device-link-protocol';
import type { WsLike } from '@cindy/device-link';
import { CERT_LIFETIME_MS, delegationEndpointCertificate, delegationVisibleTo, type Delegation, type DeviceView } from '@cindy/agent-net-protocol';
import { frameMatchesDelegation, scopedFrame, delegatedPeerKey, delegatedPeerTarget, type ScopedPeerTarget } from './scopedRoutes.js';
import { DRAIN_LOW_WATER_BYTES, MAX_CHANNEL_PENDING_BYTES, type PeerChannel, type RelayRoute, type RosterEntry, type SessionWire, type Transport } from './types.js';
import { SessionPeer, type SessionConfig, type SessionRole } from './session/peer.js';
export type { SessionHandlers } from './session/peer.js';

/**
 * `since`: monotonic time this connection was adopted. `presenceWait`: our presence is held back until the peer declares
 * (or not) session support; `presenceFrames`: this peer gets presence as Device Link frames (it did not read it on a session).
 */
interface Peer { deviceId: string; key: string; channel: PeerChannel; outbound: boolean; since: number; info?: PresenceSnapshot;
  presenceWait?: ReturnType<typeof setTimeout>; presenceFrames?: boolean; }

/** Simultaneous dials settle within the transport's 3s handshake budget; a redial after this is a new peer endpoint. */
const REDIAL_TAKEOVER_MS = 10_000;
/**
 * A connection to a device of this account ended while the directory still has it online (path lost, NAT rebinding): the
 * dialing side (the lower id, as on a directory update) dials it again after this long, doubling per failed try up to
 * REDIAL_MAX_MS while it stays online. Before (2026-11-17 review) only the next call or directory update dialed: the peer
 * showed offline meanwhile, and with 「仅使用 Agent-Net」 an idle account could stay so.
 */
const REDIAL_FIRST_MS = 1_000;
const REDIAL_MAX_MS = 30_000;
/** Declared with session support between devices of one account: presence travels on the session (`presence` message). */
const SESSION_PRESENCE_FEATURE = 'presence-v1';
/**
 * How long a new connection's first presence waits for the peer to declare session support (one round trip, usually far less).
 * A peer that never declares (an older node) then gets the Device Link frame; until then it sees this node as connecting.
 */
const PRESENCE_DECLARATION_WAIT_MS = 1500;
/**
 * Phone pushes waiting while one is being delivered (one recipient at a time). Beyond this the newest is refused BACKPRESSURE.
 * 2026-11-17 review: with no queue a second push made during the first one's HTTP round trips was refused and nobody retried
 * it (the Desktop's dedupe had already counted it as sent); Device Link takes both.
 */
const NOTIFY_QUEUE_LIMIT = 32;

/** Only string device ids count; anything else in a rule from the host is ignored. */
function peerRuleOf(rule: PeerRule): { allowed: Set<string> | null; refused: Set<string> } {
  const ids = (list: readonly unknown[]) => new Set(list.filter((id): id is string => typeof id === 'string'));
  return { allowed: Array.isArray(rule.allowed) ? ids(rule.allowed) : null, refused: Array.isArray(rule.refused) ? ids(rule.refused) : new Set() };
}

/** Node timers can release the event loop; React Native timers are numeric ids. */
function unrefTimer(timer: number | { unref?: () => void }): void {
  if (typeof timer !== 'number') timer.unref?.();
}

/** A bounded length-prefixed stream parser. A malformed peer closes only its own channel. */
class Frames {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private expected: number | null = null;
  push(input: Uint8Array, consume: (frame: Envelope) => void): void {
    this.chunks.push(input.slice()); this.bytes += input.length;
    for (;;) {
      if (this.expected === null) {
        if (this.bytes < 4) return;
        const header = this.take(4);
        this.expected = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
        if (this.expected < 1 || this.expected > MAX_FRAME_BYTES) throw new Error('INVALID_FRAME_LENGTH');
      }
      if (this.bytes < this.expected) return;
      const value: unknown = JSON.parse(decodeUtf8(this.take(this.expected)));
      this.expected = null;
      if (!value || typeof value !== 'object' || (value as Envelope).v !== PROTOCOL_VERSION || typeof (value as Envelope).kind !== 'string') throw new Error('INVALID_FRAME');
      consume(value as Envelope);
    }
  }
  private take(size: number): Uint8Array {
    this.bytes -= size;
    const first = this.chunks[0];
    if (first.length >= size) {
      if (first.length === size) this.chunks.shift(); else this.chunks[0] = first.subarray(size);
      return first.subarray(0, size);
    }
    const merged = concatBytes(this.chunks);
    this.chunks = merged.length === size ? [] : [merged.subarray(size)];
    return merged.subarray(0, size);
  }
}

/** Existing DeviceLinkClient business protocol over authenticated, encrypted Rust streams. */
export class AgentNetSocket extends SocketEvents implements WsLike {
  private transport!: Transport;
  private uplink: SocketUplink | null = null;
  private receiveDatagram: ((id: string, data: Uint8Array) => void) | null = null;
  private roster = new Map<string, DeviceView>();
  /** Which members of this account's directory this node accepts (restrictPeers); null: all of them. */
  private peerRule: { allowed: Set<string> | null; refused: Set<string> } = { allowed: null, refused: new Set() };
  private delegations = new Map<string, Delegation>();
  private ownDelegation: Delegation | null = null;
  private knownV2 = new Set<string>();
  private peers = new Map<string, Peer>();
  private dialing = new Map<string, Promise<void>>();
  private readonly redials = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly redialSteps = new Map<string, number>();
  private pending = new Map<string, { frame: Envelope; bytes: number }[]>();
  private pendingBytes = 0;
  private sentRequests = new Map<string, { peer: string; at: number; frame: Envelope }>();
  private closed = false;
  private ready = false;
  private localHello: HelloPayload | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private retryMs = 500;
  private rosterValidUntil = 0;
  private lan: SocketDiscovery | null = null;
  private lanCandidates = new Map<string, { address: string; port: number }>();
  private directoryRevision = 0;
  private directoryRefresh: ReturnType<typeof setInterval> | undefined;
  private refreshingDirectory = false;
  private notificationAbort = new AbortController();
  private notifying = false;
  private notifyQueue: Envelope[] = [];
  protected constructor(private readonly options: PortableSocketOptions) { super(); }

  static async openWithBindings(options: PortableSocketOptions): Promise<AgentNetSocket> {
    const socket = new this(options);
    socket.rosterValidUntil = options.directoryExpiresAt ?? 0;
    if (options.peerRule) socket.peerRule = peerRuleOf(options.peerRule);
    // A cached online bit is not current liveness. Wait for authenticated
    // discovery instead of occupying the first cold-start dial with a dead relay.
    socket.updateDirectory((options.cachedDirectory ?? []).map(view => ({ ...view, online: false })), false);
    try { await socket.connectRelay(); }
    catch (error) {
      if (socket.closed || socket.roster.size === 0) { socket.close(); throw error; }
      socket.scheduleReconnect();
    }
    try {
      socket.transport = await options.bindings.createTransport({
        relay: { deviceId: options.client.identity.deviceId, uplink: {
          kind: 'agent-net', send: (id, data) => { if (socket.authorized(id)) socket.uplink?.send(id, data); },
          onDatagram: (receive) => { socket.receiveDatagram = receive; }, close: () => undefined,
        }, udpCredentials: () => socket.uplink?.udp ?? null },
        admit: (key) => socket.deviceForKey(key) !== undefined,
        admissionVersion: () => socket.directoryRevision,
        relayIdOf: (key) => socket.deviceForKey(key),
        admittedPeers: () => socket.peerIds().filter(id => socket.authorized(id))
          .map(id => ({ id: keyHex(socket.transportKey(id)!), relayId: id })),
        onIncoming: (channel) => socket.adopt(channel, false),
      });
      socket.uplink?.onDatagram((id, data) => socket.receiveDatagram?.(id, data));
      const dial = socket.transport.dial as { udp?: { port: number } };
      if (options.bindings.createDiscovery && options.lanDiscovery !== false && dial.udp && !options.client.delegation) {
        socket.lan = options.bindings.createDiscovery({ networkId: options.client.certificate.networkId, port: dial.udp.port,
          certificateFor: (id) => socket.authorized(id) ? socket.roster.get(id)?.certificate : undefined,
          onCandidate(id, address) {
            if (!socket.authorized(id)) return;
            socket.lanCandidates.set(id, address);
            if (socket.ready && !socket.peers.has(id)) void socket.dial(id).catch(() => undefined);
          },
        });
        socket.lan.start();
      }
      socket.directoryRefresh = setInterval(() => { void socket.refreshDirectory().catch(() => undefined); }, 6 * 60 * 60_000);
      unrefTimer(socket.directoryRefresh);
      setTimeout(() => { if (!socket.closed) socket.emit('open'); }, 0);
      return socket;
    } catch (error) { socket.close(); throw error; }
  }
  get bufferedAmount(): number {
    let bytes = this.pendingBytes;
    for (const peer of this.peers.values()) bytes += peer.channel.bufferedAmount ?? 0;
    return bytes;
  }
  /**
   * `bufferedAmount` fell back to {@link DRAIN_LOW_WATER_BYTES} or below after having been above it: an upper layer that
   * stops writing above a watermark can resume right away instead of polling. Once per crossing, not per core write:
   * per-write events cost the shared Main thread more than they saved (2026-11-14 bench, downloads 2.6x slower).
   */
  onDrain(listener: () => void): void { this.on('drain', listener); }
  private drainArmed = false;
  /**
   * Agent-Net sessions (docs/agent-net-session-plan.md §10.1), the independent upper layer that replaces Device Link
   * frames between two new nodes. Off until `useSessions` is called. A session exists while the peer's encrypted
   * connection does and the peer declared support. Between devices of one account it is keyed by the device; inside a
   * delegation (a guest admitted to a shared task or provider share) by the scoped peer the delegation names, and one-way
   * (`sessionScope`). Every message in either direction re-checks that the peer is still authorized for that same scope.
   * Device Link frames on this socket are unaffected either way.
   */
  private sessionConfig: SessionConfig | null = null;
  /** By session key (see `SessionConfig.handlers`); `deviceId` is the connection it runs on. */
  private readonly sessions = new Map<string, { peer: Peer; session: SessionPeer; deviceId: string }>();
  /** Connection (directory or delegation id) → the key of the session on it. */
  private readonly sessionKeys = new Map<string, string>();
  useSessions(config: SessionConfig): void {
    this.sessionConfig = config;
    for (const [deviceId, peer] of this.peers) this.attachSession(deviceId, peer);
  }
  /** The live session for this key, if both sides support sessions and the connection is up. */
  session(key: string): SessionPeer | null { return this.sessions.get(key)?.session ?? null; }
  /** The connection a session key's live session runs on. */
  sessionDevice(key: string): string | null { return this.sessions.get(key)?.deviceId ?? null; }
  onSession(listener: (key: string, session: SessionPeer, deviceId: string) => void): void { this.on('session', listener); }
  /**
   * Connects to the peer a session key names, for a caller that wants its session before the first message: a guest dials
   * the resource's computer on demand; a device of this account is dialed when the directory says it is online now (only
   * one side of a pair dials from the directory by itself, and a message to an unconnected peer would otherwise go out as a
   * Device Link frame before the session exists). Resolves true once the connection is up (its session follows if the peer
   * supports sessions), false if there is no such peer to dial from here, it is not online, or the dial failed. The
   * resource's side never dials a guest.
   */
  async connectSession(key: string): Promise<boolean> {
    if (this.closed || !this.sessionConfig) return false;
    const deviceId = this.sessions.get(key)?.deviceId
      ?? (this.options.client.delegation ? this.scopedPeerTarget(key)?.relayId
        : this.roster.has(key) && this.sessionScope(key) && (this.peers.has(key) || this.roster.get(key)!.online === true) ? key : undefined);
    if (!deviceId) return false;
    if (!this.peers.has(deviceId)) {
      try { await this.dial(deviceId); } catch { return false; }
    }
    return this.peers.has(deviceId);
  }
  /**
   * Whom a session on this connection is for, and which end of the control link this side may be. Between devices of one
   * account: the device, both ends. Inside a delegation: the scoped peer it names (`delegatedPeerKey`); the guest only
   * calls, the resource's computers only serve, as with scoped Device Link frames. Null: no session here (a delegation
   * without a member scope, or `delegatedOnly` and not a delegation).
   */
  private sessionScope(deviceId: string): { key: string; role: SessionRole } | null {
    if (this.options.client.delegation) {
      const own = this.ownDelegation;
      const key = own?.scope && delegationEndpointCertificate(own, deviceId) ? delegatedPeerKey(own, 'host', deviceId) : null;
      return key ? { key, role: 'call' } : null;
    }
    const delegation = this.delegations.get(deviceId);
    if (delegation) {
      const key = delegatedPeerKey(delegation, 'guest', delegation.guestDeviceId);
      return key ? { key, role: 'serve' } : null;
    }
    if (deviceId.startsWith('guest:') || this.sessionConfig?.delegatedOnly) return null;
    return { key: deviceId, role: 'both' };
  }
  private attachSession(deviceId: string, peer: Peer): void {
    const scope = this.sessionConfig ? this.sessionScope(deviceId) : null;
    if (!scope) return;
    // Between devices of one account presence travels on the session too, so nothing on the connection is a Device Link frame.
    peer.channel.declareSessions?.(scope.role === 'both' ? [SESSION_PRESENCE_FEATURE] : []);
    peer.channel.onSessionCapable?.(() => {
      const config = this.sessionConfig, wire = peer.channel.sessionWire?.();
      if (!config || !wire || this.closed || this.peers.get(deviceId) !== peer || this.sessions.has(scope.key)
        || this.sessionScope(deviceId)?.key !== scope.key) return;
      const handlers = config.handlers(scope.key);
      let session: SessionPeer;
      // Still authorized, on this connection, for the same resource and member: what `route` and `fromPeer` check for
      // every Device Link frame. A revoked, expired or changed delegation ends the session at its next message.
      const current = () => this.authorized(deviceId) && this.peers.get(deviceId) === peer && this.sessionScope(deviceId)?.key === scope.key;
      const guard = <A extends unknown[]>(handler: ((...args: A) => void | Promise<void>) | undefined) => handler && ((...args: A) => {
        if (!current()) { session.dispose('UNAUTHORIZED'); return; }
        return handler(...args);
      });
      const checked: SessionWire = {
        write: (lane, bytes) => {
          if (!current()) { queueMicrotask(() => session.dispose('UNAUTHORIZED')); throw new Error('UNAUTHORIZED'); }
          wire.write(lane, bytes);
        },
        get bufferedAmount() { return wire.bufferedAmount; },
        onData: (handler) => wire.onData(handler),
      };
      session = new SessionPeer({
        wire: checked, role: scope.role, laneFor: config.laneFor,
        onOpen: guard(handlers.onOpen), onClose: guard(handlers.onClose), onRequest: guard(handlers.onRequest),
        onPush: guard(handlers.onPush),
        // This socket keeps presence for its Device Link client: a peer's session presence becomes the same local event as its frame.
        onPresence: scope.role === 'both' ? guard((payload: unknown) => this.peerPresence(peer, payload)) : guard(handlers.onPresence),
        onBroken: (code) => {
          if (this.sessions.get(scope.key)?.session === session) this.sessions.delete(scope.key);
          if (this.sessionKeys.get(deviceId) === scope.key) this.sessionKeys.delete(deviceId);
          handlers.onBroken?.(code);
          if (code === 'UNAUTHORIZED' || code.startsWith('AGENT_NET_SESSION_')) peer.channel.close();
        },
      });
      this.sessions.set(scope.key, { peer, session, deviceId });
      this.sessionKeys.set(deviceId, scope.key);
      this.emit('session', scope.key, session, deviceId);
      // Presence held back for this peer's declaration goes now: on the session, or as a frame if the peer does not read it there.
      if (scope.role === 'both' && peer.presenceWait) {
        clearTimeout(peer.presenceWait); peer.presenceWait = undefined;
        this.sendPresence(peer);
      }
    });
  }
  get deviceId(): string { return this.options.client.identity.deviceId; }
  /** A REST response cannot overwrite a newer WebSocket directory event. */
  async refreshDirectory(): Promise<void> {
    const client = this.options.client, revision = this.directoryRevision, generation = this.generation;
    if (this.closed || !this.uplink || this.refreshingDirectory || !client.directory) return;
    this.refreshingDirectory = true;
    try {
      const devices = await client.directory(); this.options.assertCurrent?.();
      if (!this.closed && this.uplink && this.options.client === client && this.generation === generation && this.directoryRevision === revision) {
        this.updateDirectory(devices);
      }
    } finally { this.refreshingDirectory = false; }
  }
  /** Renew only the relay credential; existing authenticated direct streams keep running. */
  async replaceClient(next: SocketClient): Promise<void> {
    const previous = this.options.client;
    if (this.closed || next.base !== previous.base || next.rootPublicKey !== previous.rootPublicKey
      || next.certificate.networkId !== previous.certificate.networkId || next.certificate.subject !== previous.certificate.subject
      || next.identity.deviceId !== previous.identity.deviceId || next.identity.signingKey !== previous.identity.signingKey
      || next.identity.transportKey !== previous.identity.transportKey) throw new Error('AGENT_NET_IDENTITY_CHANGED');
    this.options.client = next;
    const old = this.uplink; this.uplink = null; old?.close();
    if (this.ready) this.acknowledgeHello();
    if (this.reconnect) { clearTimeout(this.reconnect); this.reconnect = null; }
    try { await this.connectRelay(); } catch (error) { if (!this.closed) this.scheduleReconnect(); throw error; }
  }
  supports(deviceId: string): boolean { return this.authorized(deviceId) && (this.peers.has(deviceId) || this.roster.get(deviceId)?.online === true); }
  /** A previously certified V2 peer must not silently downgrade when its relay session disappears. */
  knowsPeer(deviceId: string): boolean { return this.knownV2.has(deviceId); }
  certificateFor(deviceId: string) { return this.roster.get(deviceId)?.certificate; }
  scopedPeerTarget(peer: string): ScopedPeerTarget | null {
    if (this.options.client.delegation) {
      const own = this.ownDelegation, target = own && delegatedPeerTarget(own, peer, 'guest');
      return target && this.authorized(target.relayId) ? target : null;
    }
    for (const [id, delegation] of this.delegations) {
      const target = delegatedPeerTarget(delegation, peer, 'host');
      if (target && this.authorized(id)) return target;
    }
    return null;
  }
  /** `deviceId`: a device, or a session key (its session's connection). */
  pathTo(deviceId: string): 'direct' | 'relay' | null { return this.peers.get(this.sessionDevice(deviceId) ?? deviceId)?.channel.path?.() ?? null; }
  /** A local dial can be in progress even when the cached directory marks the peer offline. */
  isDialing(deviceId: string): boolean { return this.dialing.has(deviceId) && this.authorized(deviceId); }
  peerSnapshot(deviceId: string): { path: 'direct' | 'relay'; rttMs: number | null } | null {
    const channel = this.peers.get(this.sessionDevice(deviceId) ?? deviceId)?.channel, path = channel?.path?.();
    if (!channel || !path) return null;
    const rtt = channel.stats?.()?.srttUs;
    return { path, rttMs: typeof rtt === 'number' && rtt > 0 ? rtt / 1000 : null };
  }
  async dial(deviceId: string): Promise<void> {
    if (this.closed || this.peers.has(deviceId)) return;
    const existing = this.dialing.get(deviceId); if (existing) return existing;
    const key = this.transportKey(deviceId);
    if (!key || !this.authorized(deviceId)) throw new Error('UNAUTHORIZED_PEER');
    const lan = this.lanCandidates.get(deviceId);
    const entry: RosterEntry = { id: keyHex(key), dial: { relayId: deviceId, ...(lan ? { udp: lan, preferUdp: true } : {}) } };
    const connect = async () => {
      try { return await this.transport.connect(entry); }
      catch (error) {
        if (!lan || !this.uplink || !this.authorized(deviceId) || keyHex(this.transportKey(deviceId)!) !== entry.id) throw error;
        // A remembered LAN address may belong to the previous network. Retire
        // only that candidate and retry this peer through its authenticated relay.
        if (this.lanCandidates.get(deviceId) === lan) this.lanCandidates.delete(deviceId);
        return this.transport.connect({ id: entry.id, dial: { relayId: deviceId } });
      }
    };
    const dialing = connect().then((channel) => this.adopt(channel, true));
    this.dialing.set(deviceId, dialing);
    try { await dialing; } finally { if (this.dialing.get(deviceId) === dialing) this.dialing.delete(deviceId); }
  }
  /** See REDIAL_FIRST_MS. Only devices of this account the directory has online; delegations dial on demand. */
  private scheduleRedial(deviceId: string): void {
    if (this.closed || this.redials.has(deviceId) || this.deviceId >= deviceId) return;
    if (!this.roster.get(deviceId)?.online || !this.authorized(deviceId)) return;
    const step = this.redialSteps.get(deviceId) ?? 0;
    this.redialSteps.set(deviceId, step + 1);
    const delay = Math.min(REDIAL_MAX_MS, REDIAL_FIRST_MS * 2 ** step) * (0.8 + Math.random() * 0.4);
    const timer = setTimeout(() => {
      this.redials.delete(deviceId);
      if (this.closed || this.peers.has(deviceId) || !this.roster.get(deviceId)?.online || !this.authorized(deviceId)) return;
      void this.dial(deviceId).catch(() => this.scheduleRedial(deviceId));
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.redials.set(deviceId, timer);
  }
  private authorized(deviceId: string): boolean {
    const delegate = this.delegations.get(deviceId);
    if (delegate) return !this.closed && Date.now() < this.rosterValidUntil
      && delegationVisibleTo(delegate, this.options.client.identity) && this.delegationValid(delegate);
    const own = this.ownDelegation, endpoint = own && delegationEndpointCertificate(own, deviceId);
    if (this.options.client.delegation && (!own?.scope || !endpoint || !this.delegationValid(own))) return false;
    const view = this.roster.get(deviceId), c = view?.certificate;
    return !this.closed && Date.now() < this.rosterValidUntil && !!c && c.deviceId !== this.deviceId && this.memberAccepted(deviceId)
      && this.verifiedUntil(c, () => this.options.bindings.verifyCertificate(this.options.client.rootPublicKey, c), () => c.expiresAt)
      && (!endpoint || endpoint.signingKey === c.signingKey && endpoint.transportKey === c.transportKey)
      && c.networkId === this.options.client.certificate.networkId && c.subject === this.options.client.certificate.subject;
  }
  /**
   * Signature checks are cached per certificate / delegation object. `authorized` runs for every datagram and every chunk
   * read (one Ed25519 verify is ~50–100 µs, which capped loopback throughput); roster and grant objects are only replaced
   * on directory updates, and a verified object stays valid until its own expiry, after which it is checked again.
   * Only successes are cached, so a not-yet-valid certificate is re-checked.
   */
  private readonly verified = new WeakMap<object, number>();
  private verifiedUntil(value: object, check: () => boolean, until: () => number): boolean {
    const cached = this.verified.get(value);
    if (cached !== undefined && Date.now() < cached) return true;
    if (!check()) return false;
    this.verified.set(value, until());
    return true;
  }
  private delegationValid(d: Delegation): boolean {
    return this.verifiedUntil(d, () => !!this.options.bindings.verifyDelegation?.(this.options.client.rootPublicKey, d),
      () => Math.min(d.expiresAt, d.issuerCertificate.expiresAt));
  }
  private deviceForKey(hex: string): string | undefined {
    for (const id of this.peerIds()) if (this.authorized(id) && keyHex(this.transportKey(id)!) === hex) return id;
    return undefined;
  }
  private peerIds(): string[] { return [...this.roster.keys(), ...this.delegations.keys()]; }
  private transportKey(id: string): string | undefined {
    return this.delegations.get(id)?.guestTransportKey ?? this.roster.get(id)?.certificate.transportKey;
  }
  private updateDirectory(directory: DeviceView[], live = true, grants?: Delegation[]): void {
    this.directoryRevision++;
    if (live) this.rosterValidUntil = Date.now() + CERT_LIFETIME_MS;
    const next = new Map<string, DeviceView>();
    for (const view of directory) {
      if (!view || typeof view !== 'object') continue;
      const c = view.certificate;
      if (!this.options.bindings.verifyCertificate(this.options.client.rootPublicKey, c, c?.issuedAt) || c.networkId !== this.options.client.certificate.networkId
        || c.subject !== this.options.client.certificate.subject) continue;
      next.set(c.deviceId, view);
      this.knownV2.add(c.deviceId);
    }
    this.roster = next;
    if (grants) {
      this.delegations.clear();
      if (this.options.client.delegation) this.ownDelegation = grants.find(d => d.scope
        && delegationVisibleTo(d, this.options.client.identity, this.options.client.delegation)
        && this.options.bindings.verifyDelegation?.(this.options.client.rootPublicKey, d)) ?? null;
      if (this.options.scoped && !this.options.client.delegation) for (const d of grants) {
        if (d.scope && d.networkId === this.options.client.certificate.networkId
          && delegationVisibleTo(d, this.options.client.identity)
          && this.options.bindings.verifyDelegation?.(this.options.client.rootPublicKey, d)) this.delegations.set('guest:' + d.id, d);
      }
      // Resource channels must have distinct transport keys. Ambiguity cannot
      // turn one resource's Noise connection into another resource or a member.
      const keys = new Map<string, string[]>();
      for (const id of this.peerIds()) { const k = this.transportKey(id)!; keys.set(k, [...(keys.get(k) ?? []), id]); }
      for (const ids of keys.values()) if (ids.length > 1) for (const id of ids) this.delegations.delete(id);
      this.options.onDelegations?.(this.options.client.delegation ? this.ownDelegation ? [this.ownDelegation] : [] : [...this.delegations.values()]);
    }
    for (const [id, peer] of this.peers) if (peer.info && next.has(id)) {
      const view = next.get(id)!;
      peer.info = { ...peer.info, app: view.app ?? peer.info.app,
        deviceName: view.name, selfName: view.selfName ?? peer.info.selfName };
      if (this.ready) this.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: peer.info });
    }
    this.dropUnauthorizedPeers();
    if (live) this.options.onDirectory?.([...next.values()]);
    this.dialRoster();
  }
  private dropUnauthorizedPeers(): void {
    for (const id of this.lanCandidates.keys()) if (!this.authorized(id)) this.lanCandidates.delete(id);
    for (const [id, peer] of this.peers) if (!this.authorized(id) || keyHex(this.transportKey(id)!) !== peer.key) {
      this.peers.delete(id); peer.channel.close({ drain: false }); this.presence(id, false);
    }
    // Frames still waiting for a dial to a member no longer accepted fail now, as a send to it would; kept, they were sent
    // once it was let back in, long after the caller had given up on them (2026-11-17 review).
    for (const [id, queue] of [...this.pending]) if (!this.authorized(id)) {
      this.pending.delete(id);
      for (const item of queue) { this.pendingBytes -= item.bytes; this.reject(item.frame, 'DEVICE_OFFLINE'); }
    }
  }
  private dialRoster(): void {
    if (this.ready) for (const [id, view] of this.roster) if (!this.peers.has(id)) {
      this.presence(id, false);
      if (view.online && this.deviceId < id && this.memberAccepted(id)) void this.dial(id).catch(() => undefined);
    }
  }
  private memberAccepted(deviceId: string): boolean {
    return !this.peerRule.refused.has(deviceId) && (this.peerRule.allowed === null || this.peerRule.allowed.has(deviceId));
  }
  /** See Transport.networkChanged (the Desktop's network watcher, through the worker). */
  networkChanged(): void { if (!this.closed) this.transport?.networkChanged?.(); }
  /** See Transport.relayRoute (the worker reports it to the Desktop with each status snapshot). */
  relayRoute(): RelayRoute | null { return this.closed ? null : this.transport?.relayRoute?.() ?? null; }
  /**
   * Which members of this account's directory to accept although their certificates are valid: the host's own membership
   * rule on top of the relay's (the Desktop accepts only devices in the account's Device Link device list, so a device
   * removed there is refused until it signs in again). `allowed` null accepts every member except `refused`. The rule
   * applies as each directory arrives, so a refused device is never dialed or accepted, not even briefly; connections open
   * now that it refuses are closed, and members let back in are dialed again if they are online. Delegated (cross-account)
   * peers are not affected.
   */
  restrictPeers(rule: PeerRule): void {
    const next = peerRuleOf(rule);
    const same = (a: Set<string> | null, b: Set<string> | null) => a === b || (!!a && !!b && a.size === b.size && [...a].every((id) => b.has(id)));
    if (same(next.allowed, this.peerRule.allowed) && same(next.refused, this.peerRule.refused)) return;
    this.peerRule = next;
    // Admission changed: the transport forgets handshakes it refused under the old rule (admissionVersion), so a member
    // let back in connects now instead of after the remembered refusal expires.
    this.directoryRevision++;
    this.dropUnauthorizedPeers();
    this.dialRoster();
  }
  private async connectRelay(): Promise<void> {
    const generation = ++this.generation;
    let uplink: SocketUplink;
    try { uplink = await this.options.client.connect(); }
    catch (error) {
      if (/^AGENT_NET_UPGRADE_(401|403)$/.test(error instanceof Error ? error.message : '')) this.close(4410);
      throw error;
    }
    if (this.closed || generation !== this.generation) { uplink.close(); return; }
    this.uplink = uplink; this.retryMs = 500;
    this.updateDirectory(uplink.devices, true, uplink.delegations ?? []);
    this.options.onDelegationRequests?.(uplink.delegationRequests ?? []);
    uplink.onDatagram((id, data) => this.receiveDatagram?.(id, data));
    uplink.on('directory', () => {
      this.updateDirectory(uplink.devices, true, uplink.delegations ?? []);
      this.options.onDelegationRequests?.(uplink.delegationRequests ?? []);
    });
    uplink.once('close', (code: number) => {
      if (this.uplink !== uplink || this.closed) return;
      this.uplink = null;
      if ([4410, 4401, 4403].includes(code)) { this.close(4410); return; }
      this.acknowledgeHello();
      // Existing direct connections remain alive; loss of one relay does not tear down the app socket.
      this.scheduleReconnect();
    });
    if (this.localHello && !this.options.client.delegation) uplink.presence(this.localHello.remoteControlEnabled, this.localHello.capabilities ?? [], this.localHello);
    if (this.ready) this.acknowledgeHello();
  }
  /** DeviceLinkClient accepts repeated acknowledgements to update capabilities
   * on the same application socket, without resetting authenticated peers. */
  private acknowledgeHello(): void {
    this.deliver({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
      serverProtocolVersion: PROTOCOL_VERSION, deviceId: this.deviceId, userId: this.options.userId,
      capabilities: [
        ...(this.uplink?.notifications && this.options.bindings.notify ? [SERVER_CAPABILITY_NOTIFY] : []),
        ...(this.options.scoped || this.options.client.delegation?.scope ? [SHARED_TASK_RELAY_CAPABILITY, PROVIDER_SHARE_RELAY_CAPABILITY] : []),
      ],
    } });
  }
  private scheduleReconnect(): void {
    if (this.closed || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      void this.connectRelay().catch(() => this.scheduleReconnect());
    }, this.retryMs);
    unrefTimer(this.reconnect); this.retryMs = Math.min(15_000, this.retryMs * 2);
  }
  send(text: string): void {
    if (this.closed) throw new Error('AGENT_NET_SOCKET_CLOSED');
    if (utf8(text).length > MAX_FRAME_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    const frame = JSON.parse(text) as Envelope;
    if (frame.v !== PROTOCOL_VERSION) throw new Error('VERSION_MISMATCH');
    if (!this.ready) {
      if (frame.kind !== 'hello') return;
      this.localHello = frame.payload as HelloPayload; this.ready = true;
      if (!this.options.client.delegation) this.uplink?.presence(this.localHello.remoteControlEnabled, this.localHello.capabilities ?? [], this.localHello);
      this.acknowledgeHello();
      for (const [id, view] of this.roster) if (id !== this.deviceId) {
        this.presence(id, false);
        if (view.online && this.deviceId < id) void this.dial(id).catch(() => undefined);
      }
      for (const peer of this.peers.values()) {
        if (peer.info) this.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: peer.info });
        this.sendPresence(peer);
      }
      for (const id of this.lanCandidates.keys()) if (!this.peers.has(id)) void this.dial(id).catch(() => undefined);
      return;
    }
    if (frame.kind === 'ping') { this.deliver({ v: PROTOCOL_VERSION, kind: 'pong' }); return; }
    if (frame.kind === 'presence-set') {
      this.localHello = { ...this.localHello!, ...(frame.payload as object) };
      if (!this.options.client.delegation) this.uplink?.presence(this.localHello.remoteControlEnabled, this.localHello.capabilities ?? [], this.localHello);
      for (const peer of this.peers.values()) this.sendPresence(peer);
      return;
    }
    if (frame.kind === 'notify') {
      if (this.notifyQueue.length >= NOTIFY_QUEUE_LIMIT) { this.reject(frame, 'BACKPRESSURE'); return; }
      this.notifyQueue.push(frame);
      if (!this.notifying) void this.drainNotifications();
      return;
    }
    if (!ROUTED_KINDS.has(frame.kind)) return;
    this.route(frame);
  }
  /** Delivers queued pushes in order, one at a time (the relay's push pool is shared by every account). */
  private async drainNotifications(): Promise<void> {
    this.notifying = true;
    try {
      while (!this.closed && this.notifyQueue.length > 0) await this.notify(this.notifyQueue.shift()!);
    } finally { this.notifying = false; }
  }
  private async notify(frame: Envelope): Promise<void> {
    if (!this.uplink?.notifications || !this.options.bindings.notify) return;
    try {
      const payload = frame.payload as import('@cindy/device-link-protocol').NotifyPayload;
      if (!payload || !['session-done', 'session-error', 'session-needs-reply'].includes(payload.category)
        || typeof payload.title !== 'string' || typeof payload.deepLink !== 'string' || payload.deepLink.length > 512
        || typeof payload.collapseId !== 'string') throw new Error('INVALID_NOTIFICATION');
      const recipients = [...this.roster.values()].filter(v => v.notificationKey && this.authorized(v.certificate.deviceId)
        && (!payload.targetDeviceId || v.certificate.deviceId === payload.targetDeviceId));
      // Bound work and use sequential delivery; one account cannot monopolize the relay's push pool.
      let failed = false;
      for (const recipient of recipients.slice(0, 256)) {
        this.options.assertCurrent?.();
        if (this.closed || this.notificationAbort.signal.aborted) return;
        try { await this.options.bindings.notify(recipient, payload, this.notificationAbort.signal, this.options.client); }
        catch { failed = true; }
      }
      if (failed && !this.closed) this.reject(frame, 'NOTIFICATION_DELIVERY_FAILED');
    } catch {
      if (!this.closed) this.reject(frame, 'NOTIFICATION_DELIVERY_FAILED');
    }
  }
  private route(frame: Envelope): void {
    let id = frame.dst;
    const own = this.ownDelegation;
    if (this.options.client.delegation) {
      const projected = own && scopedFrame(own, frame, 'guest', frame.dst);
      if (!projected) { this.reject(frame, 'FORBIDDEN'); return; }
      frame = projected; id = projected.dst;
    } else if (frame.sharedTask !== undefined || frame.providerShare !== undefined) {
      const match = [...this.delegations].find(([, d]) => this.authorized('guest:' + d.id) && frameMatchesDelegation(d, frame));
      const projected = match && scopedFrame(match[1], frame, 'host', this.deviceId);
      if (!match || !projected) { this.reject(frame, 'FORBIDDEN'); return; }
      id = match[0]; frame = projected;
    }
    if (!id || !this.authorized(id)) { this.reject(frame, 'DEVICE_OFFLINE'); return; }
    if (frame.id && ['invoke', 'link-open'].includes(frame.kind)) {
      for (const [request, item] of this.sentRequests) if (performance.now() - item.at > 15 * 60_000) this.sentRequests.delete(request);
      if (this.sentRequests.size >= 10_000) { this.reject(frame, 'BACKPRESSURE'); return; }
      this.sentRequests.set(frame.id, { peer: id, at: performance.now(), frame });
    }
    const peer = this.peers.get(id); if (peer) { this.write(peer, frame); return; }
    const bytes = utf8(JSON.stringify(frame)).length;
    const queue = this.pending.get(id) ?? [];
    if (queue.length >= 64 || this.bufferedAmount + bytes > MAX_CHANNEL_PENDING_BYTES) { this.reject(frame, 'BACKPRESSURE'); return; }
    queue.push({ frame, bytes }); this.pending.set(id, queue); this.pendingBytes += bytes;
    void this.dial(id).catch(() => {
      for (const item of this.pending.get(id) ?? []) { this.pendingBytes -= item.bytes; this.reject(item.frame, 'DEVICE_OFFLINE'); }
      this.pending.delete(id);
    });
  }
  private reject(frame: Envelope, code: string): void {
    if (frame.id && ['invoke', 'link-open'].includes(frame.kind)) this.sentRequests.delete(frame.id);
    this.deliver({ v: PROTOCOL_VERSION, kind: 'relay-error', ...(frame.id ? { id: frame.id } : {}),
      ...(frame.sharedTask ? { sharedTask: frame.sharedTask } : {}), ...(frame.providerShare ? { providerShare: frame.providerShare } : {}),
      payload: { code, message: code, ...(frame.dst ? { dst: frame.dst } : {}) } } as Envelope);
  }
  private adopt(channel: PeerChannel, outbound: boolean): void {
    const deviceId = this.deviceForKey(channel.remoteId);
    if (this.closed || !deviceId) { channel.close(); return; }
    const previous = this.peers.get(deviceId);
    const preferredOutbound = this.deviceId < deviceId;
    // While opposite-direction dials are settling, both peers must choose the same channel.
    // A later inbound redial indicates the remote no longer holds its end of the previous channel.
    const now = performance.now();
    const peerRedialed = previous && !outbound && now - previous.since >= REDIAL_TAKEOVER_MS;
    if (previous && previous.outbound !== outbound && outbound !== preferredOutbound && !peerRedialed) {
      channel.close({ drain: false });
      return;
    }
    const peer: Peer = { deviceId, key: channel.remoteId, channel, outbound, since: now };
    this.peers.set(deviceId, peer); previous?.channel.close();
    const frames = new Frames();
    channel.onData((bytes) => {
      // The replaced, authenticated channel still drains already-written RPCs.
      // Dropping its first link-open strands the caller without a link-accept.
      // Recheck the current key/authorization; retired channels cannot refresh
      // presence or revive a revoked/rotated identity.
      const current = this.peers.get(deviceId);
      if (!current || !this.authorized(deviceId)
        || current !== peer && this.deviceForKey(peer.key) !== deviceId) { channel.close(); return; }
      try { frames.push(bytes, (frame) => {
        if (this.peers.get(deviceId) !== peer && frame.kind === 'presence-changed') return;
        this.fromPeer(peer, frame);
      }); } catch { channel.close(); }
    });
    channel.onClose(() => {
      const key = this.sessionKeys.get(deviceId), attached = key === undefined ? undefined : this.sessions.get(key);
      if (attached?.peer === peer) attached.session.dispose('DEVICE_OFFLINE');
      if (this.peers.get(deviceId) !== peer) return;
      this.peers.delete(deviceId); this.presence(deviceId, false); this.options.onPathChanged?.(deviceId, null);
      // A connection that lasted starts the backoff over; one that keeps dropping right away does not.
      if (performance.now() - peer.since >= REDIAL_MAX_MS) this.redialSteps.delete(deviceId);
      this.scheduleRedial(deviceId);
    });
    channel.onDrain?.(() => {
      if (this.peers.get(deviceId) !== peer || !this.drainArmed || this.bufferedAmount > DRAIN_LOW_WATER_BYTES) return;
      this.drainArmed = false;
      this.emit('drain');
    });
    // A replaced connection took its session with it (its onClose); this one gets a fresh session once the peer declares support.
    this.attachSession(deviceId, peer);
    this.sendPresence(peer);
    for (const item of this.pending.get(deviceId) ?? []) { this.pendingBytes -= item.bytes; this.write(peer, item.frame); }
    this.pending.delete(deviceId); this.options.onPathChanged?.(deviceId, channel.path?.() ?? null);
  }
  /**
   * Where this node's presence goes to a peer: on its session when both declared `SESSION_PRESENCE_FEATURE` (then nothing
   * on this connection is a Device Link frame), otherwise as the Device Link `presence-changed` frame. A peer that may still
   * declare sessions is waited for (`wait`) instead of being sent the frame first.
   */
  private presenceRoute(peer: Peer): 'session' | 'frame' | 'wait' {
    if (peer.presenceFrames || !this.sessionConfig || !peer.channel.declareSessions || this.sessionScope(peer.deviceId)?.role !== 'both') return 'frame';
    const key = this.sessionKeys.get(peer.deviceId), attached = key === undefined ? undefined : this.sessions.get(key);
    if (attached?.peer === peer) return peer.channel.sessionFeatures?.().includes(SESSION_PRESENCE_FEATURE) ? 'session' : 'frame';
    return 'wait';
  }
  private sendPresence(peer: Peer): void {
    const route = this.presenceRoute(peer);
    if (route === 'wait') {
      if (peer.presenceWait) return;
      // An older peer never declares sessions: after the wait it gets the frame, and every later update too.
      peer.presenceWait = setTimeout(() => {
        peer.presenceWait = undefined;
        if (this.closed || this.peers.get(peer.deviceId) !== peer) return;
        if (this.presenceRoute(peer) === 'wait') peer.presenceFrames = true;
        this.sendPresence(peer);
      }, PRESENCE_DECLARATION_WAIT_MS);
      unrefTimer(peer.presenceWait);
      return;
    }
    if (route === 'session') {
      try { this.sessions.get(this.sessionKeys.get(peer.deviceId)!)!.session.presence(this.info()); }
      catch { /* The session is closing; its connection goes with it. */ }
      return;
    }
    this.write(peer, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: this.info() });
  }
  /** A peer's own presence, from its Device Link frame or its session; names come from the signed directory. */
  private peerPresence(peer: Peer, value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const reported = value as PresenceSnapshot, view = this.roster.get(peer.deviceId);
    peer.info = { ...reported, deviceName: view?.name ?? reported.deviceName, selfName: reported.selfName ?? reported.deviceName,
      deviceId: peer.deviceId, online: true, lastSeenAt: Date.now() };
    this.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: peer.info });
  }
  private write(peer: Peer, frame: Envelope): void {
    const d = this.options.client.delegation ? this.ownDelegation : this.delegations.get(peer.deviceId);
    if (this.options.client.delegation && !d) return;
    if (d) {
      const projected = scopedFrame(d, frame, this.options.client.delegation ? 'guest' : 'host', this.options.client.delegation ? peer.deviceId : this.deviceId);
      if (!projected) return;
      frame = projected;
    }
    const body = utf8(JSON.stringify(frame));
    if (body.length > MAX_FRAME_BYTES) { this.reject(frame, 'PAYLOAD_TOO_LARGE'); return; }
    if (this.bufferedAmount + body.length + 4 > MAX_CHANNEL_PENDING_BYTES) {
      if (frame.id) this.sentRequests.delete(frame.id);
      this.reject(frame, 'BACKPRESSURE'); return;
    }
    const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, body.length, false);
    try { peer.channel.send(concatBytes([prefix, body])); if (this.bufferedAmount > DRAIN_LOW_WATER_BYTES) this.drainArmed = true; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BACKPRESSURE')) throw error;
      if (frame.id) this.sentRequests.delete(frame.id);
      this.reject(frame, 'BACKPRESSURE');
    }
  }
  private info(): PresenceSnapshot {
    return { ...this.localHello, deviceId: this.deviceId, deviceName: this.localHello?.deviceName ?? '',
      platform: this.localHello?.platform ?? '', appVersion: this.localHello?.appVersion ?? '', online: true,
      remoteControlEnabled: this.localHello?.remoteControlEnabled ?? false, busy: this.localHello?.busy ?? false, lastSeenAt: Date.now() };
  }
  private presence(deviceId: string, online: boolean): void {
    if (this.options.client.delegation || this.delegations.has(deviceId) || deviceId.startsWith('guest:')) return;
    if (deviceId === this.deviceId) return;
    const view = this.roster.get(deviceId);
    this.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: { deviceId, deviceName: view?.name ?? '', selfName: view?.selfName,
      online, remoteControlEnabled: online && (view?.remoteControlEnabled ?? false), platform: view?.platform ?? '', app: view?.app,
      appVersion: view?.appVersion ?? '', busy: online && !!view?.busy, lastSeenAt: view?.lastSeenAt ?? Date.now() } });
  }
  private fromPeer(peer: Peer, frame: Envelope): void {
    const d = this.options.client.delegation ? this.ownDelegation : this.delegations.get(peer.deviceId);
    if (this.options.client.delegation && !d) return;
    if (d && frame.kind === 'presence-changed') return;
    if (frame.kind === 'presence-changed') {
      const reported = frame.payload as PresenceSnapshot, view = this.roster.get(peer.deviceId);
      peer.info = { ...reported, app: reported.app ?? view?.app ?? peer.info?.app,
        deviceName: view?.name ?? reported.deviceName, selfName: reported.selfName ?? reported.deviceName,
        deviceId: peer.deviceId, online: true, lastSeenAt: Date.now() };
      this.deliver({ ...frame, payload: peer.info });
      return;
    }
    if (frame.kind === 'relay-error') {
      const request = frame.id && this.sentRequests.get(frame.id);
      if (!request || request.peer !== peer.deviceId) return;
      this.deliver({ ...frame, sharedTask: request.frame.sharedTask, providerShare: request.frame.providerShare,
        src: peer.deviceId, payload: { ...(frame.payload as object), dst: request.frame.dst } }); return;
    }
    if (d) {
      const projected = scopedFrame(d, frame, this.options.client.delegation ? 'host' : 'guest', this.options.client.delegation ? peer.deviceId : this.deviceId);
      if (!projected) return;
      if (frame.id && ['invoke-result', 'link-accept'].includes(frame.kind)) this.sentRequests.delete(frame.id);
      this.deliver(projected); return;
    }
    if (frame.sharedTask !== undefined || frame.providerShare !== undefined) return;
    if (!ROUTED_KINDS.has(frame.kind) || frame.dst !== this.deviceId) return;
    if (CONTROL_KINDS.has(frame.kind) && !this.localHello?.remoteControlEnabled) {
      this.write(peer, { v: PROTOCOL_VERSION, kind: 'relay-error', id: frame.id, payload: {
        code: 'REMOTE_DISABLED', message: 'REMOTE_DISABLED', dst: this.deviceId,
      } } as Envelope); return;
    }
    if (frame.id && ['invoke-result', 'link-accept'].includes(frame.kind)) this.sentRequests.delete(frame.id);
    this.deliver({ ...frame, src: peer.deviceId });
  }
  private deliver(frame: Envelope): void {
    if (!this.closed && this.ready) this.emit('message', { toString: () => JSON.stringify(frame) });
  }
  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true; this.generation++;
    this.notificationAbort.abort(); this.notifyQueue = [];
    for (const timer of this.redials.values()) clearTimeout(timer);
    this.redials.clear();
    this.lan?.close(); this.lan = null; this.lanCandidates.clear();
    if (this.directoryRefresh) clearInterval(this.directoryRefresh); this.directoryRefresh = undefined;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null; this.uplink?.close(); this.uplink = null;
    for (const peer of this.peers.values()) { if (peer.presenceWait) clearTimeout(peer.presenceWait); peer.channel.close(); }
    this.peers.clear(); this.pending.clear(); this.pendingBytes = 0; this.sentRequests.clear();
    // 关闭包发出去以后才报告关闭：worker 里的连接收到关闭事件后线程就会被结束，早了包就发不出去，直连的对端要等约 30 秒才知道。
    const transportClosed = this.transport?.close().catch(() => undefined) ?? Promise.resolve();
    void transportClosed.then(() => this.emit('close', code, ''));
  }
  terminate(): void { this.close(1006); }
}
