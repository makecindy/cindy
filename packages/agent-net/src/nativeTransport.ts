import {
  AGENT_NET_SESSION_V1, ChannelEvents, DRAIN_LOW_WATER_BYTES, MAX_EARLY_SESSION_BYTES, SESSION_LANE_KINDS, SESSION_LANE_PRIORITY,
  type PeerChannel, type RosterEntry, type SessionLaneName, type SessionWire, type Transport, type TransportOptions,
} from './types.js';
import { concatBytes, decodeUtf8, fromBase64Url, keyHex, toBase64Url, utf8 } from './portableBytes.js';

export interface NativeEnginePort {
  command<T = unknown>(command: Record<string, unknown>): Promise<T>;
  /**
   * `native-wait` binaries: resolves true as soon as the engine has something to read with `poll`, false after `maxMs`.
   * Meanwhile the engine receives, acknowledges and runs its timers by itself (see `NativeTransport.rest`).
   */
  wait?(maxMs: number): Promise<boolean>;
  destroy(): Promise<void>;
  assertCurrent?(): void;
}
interface Address { address: string; port: number; }
interface NativeState {
  id: number; established: boolean; dead: boolean; closedByPeer: boolean; unacked: boolean; remoteKey: string;
  path?: Address | { link: number };
  events: { kind: 'open' | 'finish'; stream: number }[];
  data: { stream: number; data: string }[];
  rttUs: number; sent: number; received: number; rotations: number;
  /** [stream, bytes still in the core's send buffer] for the streams this side opened (`stream-buffered` builds). */
  buffered?: [number, number][];
}
interface Poll { packets: { link: number; data: string }[]; connections: NativeState[]; mapped?: Address[]; relayUdp?: boolean; }
interface NativeIdentity { deviceId: string; transportKey: string; udpPort: number | null; features?: string[]; }
interface Waiting { resolve(channel: PeerChannel): void; reject(error: Error): void; deadline: number; }
/** This side's local addresses for its candidates: a fixed list, or read again on every network change. */
export type NativeAddresses = string[] | (() => Promise<string[]>);
const MAX_PENDING = 16 * 1024 * 1024;
const MAX_CANDIDATES = 16;
/** Same as the Desktop driver (transport.ts): at most this many STUN servers are asked. */
const MAX_STUN_SERVERS = 4;
const DATA = 0x44;
const CONTROL = 0x43;
const LANE_BY_KIND = new Map<number, SessionLaneName>(Object.entries(SESSION_LANE_KINDS).map(([lane, kind]) => [kind, lane as SessionLaneName]));
/** Per poll and outgoing stream, at most this many native writes of `WRITE_CHUNK` bytes. */
const WRITES_PER_STREAM = 8;
const WRITE_CHUNK = 65_536;
/**
 * The engine is polled every FAST_POLL_MS while anything moves (stream data or events, bytes waiting here, in the core or
 * unacknowledged, a handshake or a dial) and every IDLE_POLL_MS once nothing has for ACTIVE_WINDOW_MS; writing, a dial, a
 * relayed datagram or a network change polls at once. A poll is a bridge round trip with every connection's state as
 * JSON on the phone's JS thread: with nothing to move, polls every 8 ms still took a quarter of it, 7–18% every 50 ms,
 * 0–4% without polls (2026-11-20 A/B on a phone, with the admission lookups of `AgentNetSocket.keys`).
 */
const FAST_POLL_MS = 8;
const IDLE_POLL_MS = 50;
const ACTIVE_WINDOW_MS = 1_000;
/**
 * `native-wait` binaries: with nothing to write, the engine is left waiting this long at a time. When it comes back empty
 * JS only looks at what it mirrors into the engine (the admitted peers' revision, the relay's UDP credentials) and polls
 * when one changed, and otherwise once per IDLE_FULL_POLL_MS for round trips, paths and admission that lapses with time.
 */
const IDLE_WAIT_MS = 250;
const IDLE_FULL_POLL_MS = 1_000;
const ADMISSION_RECHECK_MS = 1_000;
/**
 * A dial over the relay made while the relay's UDP path is still coming up waits for it, at most this long after the path
 * was last set up. A handshake sent over the relay WebSocket in that window got no answer and went again at the core's
 * 200 ms retransmission: every start and every reconnect of a phone spent 230–240 ms on its first dials, and the same
 * handshake sent once the path was up was answered in 30–45 ms (2026-11-21). Nothing waits for a relay that issued no UDP
 * credentials or a binary without relay UDP; where UDP is blocked the dial goes over the WebSocket when the time is up.
 */
const RELAY_UDP_DIAL_WAIT_MS = 200;
const now = () => performance.now();

/**
 * Native Rust owns UDP, cryptography and reliable packet state; JS owns the existing authenticated stream protocol and
 * the session lanes on it. Every native poll mirrors revocation before reading or transmitting another packet.
 *
 * Builds report what they add over the first native release in `identity().features`; nothing here uses a feature the
 * installed binary does not report, so newer JS keeps working on an older binary (without them):
 * - `stream-buffered`: the core's send buffer per stream, counted in the session backlog as the Desktop does.
 * - `stun`: this port's address outside the NAT, announced to peers as a candidate.
 * - `relay-udp-v2`: datagrams relayed through the Agent-Net relay go over UDP (docs/dev-rules/protocol-compatibility/agent-net-udp-relay.md).
 * - `native-wait`: the engine waits for packets and its timers on a native thread and wakes JS when there is something to
 *   read. Without it JS polls on timers: React Native runs timers on the display's frames, so every step of a request (hand
 *   it to the engine, pick up the answer) waited for the next frame; requests took 30–60 ms longer than over Device Link and
 *   an idle app kept the JS thread 9–22% busy (2026-11-20, docs/agent-net-session-plan.md 10.2 v2-4).
 * Session lanes need only streams, so they work on every native build.
 */
export class NativeTransport implements Transport {
  readonly id: string;
  readonly dial: { udp?: Address };
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The delay the pending poll was scheduled with. */
  private timerDelay = 0;
  /** Poll fast until then (a new transport starts out connecting). */
  private activeUntil = now() + ACTIVE_WINDOW_MS;
  /** `native-wait`: the engine wakes JS; no timers. Turned off if a wait ever fails (the timers take over). */
  private waits = false;
  /** A poll is running; `again`: something happened meanwhile, so one more follows it. */
  private polling = false;
  private again = false;
  /** The wait whose return decides the next step; a later one supersedes it. */
  private waitRound = 0;
  private polledAt = 0;
  /** When a wake last polled at once (see `wake`). */
  private wokeAt = Number.NEGATIVE_INFINITY;
  /** The socket's admission revision the engine last got, and when the admitted peers were last worked out. */
  private mirroredVersion: number | undefined;
  private admissionAt = Number.NEGATIVE_INFINITY;
  private channels = new Map<number, NativeChannel>();
  private waiting = new Map<number, Waiting>();
  private readonly remoteKeys = new Map<number, { raw: string; hex: string }>();
  private links = new Map<string, number>();
  private deviceForLink = new Map<number, string>();
  private lastAdmission = '';
  private nextLink = 0;
  private pendingBytes = 0;
  private readonly features: Set<string>;
  private localAddresses: string[];
  private mapped: Address[] = [];
  private candidateList: Address[] = [];
  /** The relay UDP credentials last given to the engine (`undefined`: none given yet). */
  private relayCredentials: object | null | undefined = undefined;
  private relayUdpUp = false;
  /**
   * The credentials `relayUdpUp` is about and when they were first seen here, and the dials waiting for their path
   * (RELAY_UDP_DIAL_WAIT_MS). New credentials (the relay reconnected) start over: the path of the previous ones being up
   * says nothing about theirs.
   */
  private relayUdpFor: object | null = null;
  private relayUdpSince = now();
  private relayUdpWaiters: Array<() => void> = [];
  private relayUdpServer: string | undefined;
  private refreshingAddresses = false;
  private constructor(
    private readonly engine: NativeEnginePort,
    private readonly options: TransportOptions,
    private readonly identity: NativeIdentity,
    addresses: string[],
    private readonly readAddresses: (() => Promise<string[]>) | null,
    readonly enhanced: boolean,
  ) {
    this.id = keyHex(identity.transportKey);
    this.dial = identity.udpPort ? { udp: { address: '0.0.0.0', port: identity.udpPort } } : {};
    this.features = new Set(Array.isArray(identity.features) ? identity.features : []);
    this.waits = enhanced && this.features.has('native-wait') && typeof engine.wait === 'function';
    this.relayUdpServer = options.relayUdpServer;
    this.localAddresses = addresses;
    this.candidateList = this.computeCandidates();
    options.relay?.uplink.onDatagram((deviceId, bytes) => {
      if (this.closed) return;
      const link = this.links.get(deviceId);
      if (!link) return;
      void this.call({ op: 'datagram', from: { link }, data: toBase64Url(bytes) }).catch(() => undefined);
      this.wake();
    });
  }
  static async create(engine: NativeEnginePort, options: TransportOptions, addresses: NativeAddresses = [], enhanced = true): Promise<NativeTransport> {
    if (!options.admittedPeers) throw new Error('NATIVE_PEER_LIST_REQUIRED');
    try {
      const identity = await engine.command<NativeIdentity>({ op: 'identity' });
      const read = typeof addresses === 'function' ? addresses : null;
      const initial = typeof addresses === 'function' ? await addresses().catch((): string[] => []) : addresses;
      const transport = new NativeTransport(engine, options, identity, initial, enhanced ? read : null, enhanced);
      await transport.synchronizeAdmission();
      await transport.startStun();
      if (transport.waits) transport.drive(); else transport.schedule();
      return transport;
    } catch (error) { await engine.destroy().catch(() => undefined); throw error; }
  }
  async call<T = unknown>(command: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error('NATIVE_TRANSPORT_CLOSED');
    this.engine.assertCurrent?.();
    const result = await this.engine.command<T>(command);
    this.engine.assertCurrent?.();
    if (this.closed) throw new Error('NATIVE_TRANSPORT_CLOSED');
    return result;
  }
  supports(feature: string): boolean { return this.features.has(feature); }
  /** Relayed datagrams go over UDP right now (both directions acknowledged by the relay). */
  get relayOverUdp(): boolean { return this.relayUdpUp; }
  /** Local addresses and STUN answers, public first, as the Desktop driver orders them. */
  candidates(): Address[] { return this.candidateList; }
  private computeCandidates(): Address[] {
    const port = this.identity.udpPort;
    if (!port) return [];
    const local = this.localAddresses.filter(address => address.length <= 128).map(address => ({ address, port }));
    if (!this.enhanced) return local.slice(0, MAX_CANDIDATES);
    const seen = new Set<string>();
    return [...local, ...this.mapped]
      .filter(candidate => { const key = `${candidate.address}:${candidate.port}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => Number(isPrivate(a.address)) - Number(isPrivate(b.address))).slice(0, MAX_CANDIDATES);
  }
  private updateCandidates(): void {
    const next = this.computeCandidates();
    if (JSON.stringify(next) === JSON.stringify(this.candidateList)) return;
    this.candidateList = next;
    for (const channel of this.channels.values()) channel.announceCandidates();
  }
  async configureUdpServer(server: string): Promise<void> {
    if (this.closed || !this.enhanced) return;
    this.relayUdpServer = server;
    // The next poll hands the engine the relay's UDP credentials: now, not when the engine next has something for JS.
    this.wake();
    await this.startStun([server]);
  }
  private async startStun(servers = (this.options.stunServers ?? []).slice(0, MAX_STUN_SERVERS)): Promise<void> {
    if (!servers.length || !this.identity.udpPort || !this.supports('stun')) return;
    await this.call({ op: 'stun', servers }).catch(() => undefined);
  }
  /**
   * The relay's UDP path follows the relay WebSocket's session: new credentials on every reconnect, none when it offered
   * none (an older relay, plain http). Until the relay acknowledges a registration, datagrams stay on the WebSocket.
   */
  private async synchronizeRelayUdp(): Promise<void> {
    const server = this.relayUdpServer, read = this.options.relay?.udpCredentials;
    if (!server || !read || !this.identity.udpPort || !this.supports('relay-udp-v2')) return;
    const credentials = read() ?? null;
    this.noteRelayCredentials(credentials);
    if (credentials === this.relayCredentials) return;
    this.relayCredentials = credentials;
    await this.call({ op: 'relayUdp', server, ...(credentials
      ? { session: toBase64Url(credentials.session), key: toBase64Url(credentials.key) } : { session: null }) });
  }
  private noteRelayCredentials(credentials: object | null): void {
    if (credentials === this.relayUdpFor) return;
    this.relayUdpFor = credentials; this.relayUdpUp = false; this.relayUdpSince = now();
  }
  /** See RELAY_UDP_DIAL_WAIT_MS. Resolves at once when the path is up, cannot come up, or has had its time. */
  private relayUdpSettled(): Promise<void> {
    const credentials = this.options.relay?.udpCredentials?.() ?? null;
    if (!credentials || this.closed || !this.enhanced || !this.identity.udpPort || !this.supports('relay-udp-v2')) return Promise.resolve();
    this.noteRelayCredentials(credentials);
    const remaining = this.relayUdpSince + RELAY_UDP_DIAL_WAIT_MS - now();
    if (this.relayUdpUp || remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.relayUdpWaiters = this.relayUdpWaiters.filter(waiter => waiter !== done);
        resolve();
      };
      const timer = setTimeout(done, remaining);
      this.relayUdpWaiters.push(done);
      // The credentials reach the engine in a poll, and so does the news that the path is up.
      this.wake();
    });
  }
  private linkFor(deviceId: string): number {
    const existing = this.links.get(deviceId);
    if (existing) return existing;
    if (this.links.size >= 4096) throw new Error('NATIVE_PEER_ADDRESS_LIMIT');
    const link = ++this.nextLink;
    this.links.set(deviceId, link); this.deviceForLink.set(link, deviceId);
    return link;
  }
  private async synchronizeAdmission(): Promise<void> {
    const version = this.options.admissionVersion?.();
    const entries = this.options.admittedPeers!().map(peer => {
      if (!/^[a-f0-9]{64}$/.test(peer.id) || !this.options.admit(peer.id)) throw new Error('INVALID_NATIVE_PEER');
      const key = Uint8Array.from(peer.id.match(/../g)!, part => parseInt(part, 16));
      // `relayId` tags the peer in relay UDP packets; builds without relay UDP ignore it.
      return { key: toBase64Url(key), link: this.linkFor(peer.relayId), ...(this.enhanced ? { relayId: peer.relayId } : {}) };
    }).sort((a, b) => a.link - b.link);
    const serialized = JSON.stringify(entries);
    if (serialized !== this.lastAdmission) {
      await this.call({ op: 'admit', peers: entries });
      this.lastAdmission = serialized;
    }
    this.admissionAt = now();
    this.mirroredVersion = version;
  }
  async connect(entry: RosterEntry): Promise<PeerChannel> {
    if (!this.options.admit(entry.id)) throw new Error('UNAUTHORIZED_PEER');
    await this.synchronizeAdmission();
    const dial = entry.dial as { relayId?: string; udp?: Address; preferUdp?: boolean };
    const expected = this.options.relayIdOf?.(entry.id);
    if (!expected || dial.relayId !== expected) throw new Error('PEER_ADDRESS_MISMATCH');
    const address = dial.preferUdp && dial.udp ? dial.udp : { link: this.linkFor(expected) };
    if ('link' in address) await this.relayUdpSettled();
    const key = toBase64Url(Uint8Array.from(entry.id.match(/../g)!, part => parseInt(part, 16)));
    const id = await this.call<number>({ op: 'connect', key, address });
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('NATIVE_TRANSPORT_CLOSED')); return; }
      this.waiting.set(id, { resolve, reject, deadline: now() + 3_000 });
      this.wake();
    });
  }
  /**
   * The phone changed networks: connections send from the new address now (the peer follows), STUN asks again, and the
   * local addresses are read again for the candidates.
   */
  networkChanged(): void {
    if (this.closed || !this.enhanced) return;
    void this.call({ op: 'migrate' }).catch(() => undefined);
    // Everything in flight goes again from the new address: poll for it now.
    this.wake();
    if (!this.readAddresses || this.refreshingAddresses) return;
    this.refreshingAddresses = true;
    void this.readAddresses().then(addresses => {
      if (this.closed) return;
      this.localAddresses = addresses;
      this.updateCandidates();
    }).catch(() => undefined).finally(() => { this.refreshingAddresses = false; });
  }
  reserve(bytes: number): void {
    if (this.pendingBytes + bytes > MAX_PENDING) throw new Error('NATIVE_TRANSPORT_BACKPRESSURE');
    this.pendingBytes += bytes;
  }
  release(bytes: number): void { this.pendingBytes = Math.max(0, this.pendingBytes - bytes); }
  private schedule(delay = now() < this.activeUntil ? FAST_POLL_MS : IDLE_POLL_MS): void {
    if (this.closed || this.timer || this.polling) return;
    this.timerDelay = delay;
    this.timer = setTimeout(() => { this.timer = null; this.drive(); }, delay);
  }
  /**
   * Something to move: poll now. React Native runs timers on the display's frames, so a zero timer was up to a frame late
   * (7–20 ms measured, 2026-11-21) and a request sat in JS that long before the engine saw it. On timers (binaries without
   * `native-wait`), a wake within FAST_POLL_MS of the previous one keeps that rhythm instead, so a run of writes does not
   * poll per write.
   */
  wake(): void {
    this.activeUntil = now() + ACTIVE_WINDOW_MS;
    if (this.closed) return;
    if (!this.waits && !this.polling && now() - this.wokeAt < FAST_POLL_MS) {
      if (this.timer && this.timerDelay > FAST_POLL_MS) { clearTimeout(this.timer); this.timer = null; }
      this.schedule(FAST_POLL_MS);
      return;
    }
    this.wokeAt = now();
    this.drive();
  }
  /** The roster or the peer rule changed: mirror it into the engine now rather than at the next poll. */
  admissionChanged(): void { this.wake(); }
  /**
   * Poll now. During a poll a wake is noted and one more poll follows it; after that the engine is left waiting (`rest`), or on
   * timers the next poll is scheduled.
   */
  private drive(): void {
    if (this.closed) return;
    if (this.polling) { this.again = true; return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.polling = true;
    void (async () => {
      try {
        await this.writeFirst();
        await this.poll();
        if (this.again && !this.closed) { this.again = false; await this.writeFirst(); await this.poll(); }
      } catch { this.polling = false; await this.close(); return; }
      this.polling = false;
      this.again = false;
      if (this.waits) this.rest(); else this.schedule();
    })();
  }
  /**
   * Bytes waiting here go to the engine before the poll, not after it. The engine sends on the write itself; a poll is a
   * bridge round trip and then a pass over every connection, and a request used to wait for both before it was written:
   * with seven computers connected, about 10 ms on a phone whose cores had clocked down (2026-11-21, 2.6 ms for the round
   * trip and 6 ms for the pass), on a line whose round trip was 4 ms. Only while the socket has not reported a change to
   * what JS mirrors into the engine, and only to a peer admitted right now (`admit` reads the clock): after a change the
   * poll hands the engine the admitted peers first, as it always did. The once-a-second look for admission that lapsed
   * with time (ADMISSION_RECHECK_MS) does not hold a write back: it took 8–17 ms with 26 devices in the account, and a
   * request that came when it was due waited for all of it.
   */
  private async writeFirst(): Promise<void> {
    if (this.options.admissionVersion?.() === undefined || this.mirrorChanged()) return;
    for (const channel of [...this.channels.values()]) {
      if (!channel.moving || !this.options.admit(channel.remoteId)) continue;
      try { await channel.flush(); }
      catch { channel.close({ drain: false }); this.engine.assertCurrent?.(); }
    }
  }
  /**
   * `native-wait`: leave the engine to itself until it has something for JS. With bytes still to hand to it (or a dial, a
   * close draining) JS comes back after FAST_POLL_MS at the latest, as the timers did; otherwise after IDLE_WAIT_MS, and
   * then polls only if something it mirrors changed or the last poll is IDLE_FULL_POLL_MS old.
   */
  private rest(): void {
    if (this.closed) return;
    const round = ++this.waitRound;
    const busy = this.waiting.size > 0 || [...this.channels.values()].some(channel => channel.moving);
    void this.engine.wait!(busy ? FAST_POLL_MS : IDLE_WAIT_MS).then((work) => {
      if (this.closed) return;
      // A superseded wait that found something still counts: the engine has it ready and its newer wait may be asleep.
      if (work) { this.drive(); return; }
      if (round !== this.waitRound) return;
      if (busy || this.mirrorChanged() || now() - this.polledAt >= IDLE_FULL_POLL_MS) this.drive(); else this.rest();
    }, () => {
      if (this.closed || !this.waits) return;
      // The binary said it can wait and cannot: keep the connection on the timers.
      this.waits = false;
      this.schedule(0);
    });
  }
  /** A connection's remote key in hex. It never changes for a connection, and every poll reports every connection. */
  private remoteKey(state: NativeState): string {
    const known = this.remoteKeys.get(state.id);
    if (known?.raw === state.remoteKey) return known.hex;
    const hex = keyHex(state.remoteKey);
    this.remoteKeys.set(state.id, { raw: state.remoteKey, hex });
    return hex;
  }
  private mirrorChanged(): boolean {
    return this.options.admissionVersion?.() !== this.mirroredVersion
      || (this.options.relay?.udpCredentials?.() ?? null) !== (this.relayCredentials ?? null);
  }
  private async poll(): Promise<void> {
    this.polledAt = now();
    // The admitted peers are worked out again when the socket says its roster or rule changed, and once per
    // ADMISSION_RECHECK_MS for what lapses with time (a certificate, a grant). Working them out on every poll took about
    // 8 ms of the phone's JS thread with 28 devices in the account (2026-11-21), more than the poll itself.
    const version = this.options.admissionVersion?.();
    if (version === undefined || version !== this.mirroredVersion || this.polledAt - this.admissionAt >= ADMISSION_RECHECK_MS) {
      await this.synchronizeAdmission();
    }
    await this.synchronizeRelayUdp();
    // Native commands can complete while this poll is awaiting bridge I/O or
    // initializing/flushing another channel. Its snapshot cannot establish that
    // a dial registered after it started has disappeared.
    const waitingAtPoll = new Map(this.waiting);
    const result = await this.call<Poll>({ op: 'poll' });
    for (const packet of result.packets) {
      const deviceId = this.deviceForLink.get(packet.link);
      if (deviceId) this.options.relay?.uplink.send(deviceId, fromBase64Url(packet.data));
    }
    // What the engine reports is about the credentials it was given; newer ones seen meanwhile are not up yet.
    this.relayUdpUp = result.relayUdp === true && this.relayUdpFor === this.relayCredentials;
    if (this.relayUdpUp) for (const done of [...this.relayUdpWaiters]) done();
    if (Array.isArray(result.mapped)) {
      const mapped = result.mapped.filter(value => value && typeof value.address === 'string' && value.address.length <= 128
        && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535).slice(0, MAX_STUN_SERVERS);
      if (JSON.stringify(mapped) !== JSON.stringify(this.mapped)) { this.mapped = mapped; this.updateCandidates(); }
    }
    const alive = new Set(result.connections.map(connection => connection.id));
    for (const id of this.remoteKeys.keys()) if (!alive.has(id)) this.remoteKeys.delete(id);
    for (const state of result.connections) {
      let channel = this.channels.get(state.id);
      const key = this.remoteKey(state);
      if (state.dead || state.closedByPeer || !this.options.admit(key)) {
        channel?.close({ drain: false });
        this.waiting.get(state.id)?.reject(new Error('NATIVE_CONNECTION_CLOSED'));
        this.waiting.delete(state.id);
        if (!channel) void this.call({ op: 'close', id: state.id }).catch(() => undefined);
        continue;
      }
      try {
        if (!channel && state.established) {
          channel = new NativeChannel(this, state.id, key);
          this.channels.set(state.id, channel);
          await channel.initialize();
          const waiting = this.waiting.get(state.id);
          if (waiting) {
            // Initializing this or another channel can outlive the dial's budget.
            if (now() >= waiting.deadline) throw new Error('NATIVE_CONNECT_TIMEOUT');
            this.waiting.delete(state.id); waiting.resolve(channel);
          }
          else this.options.onIncoming(channel);
        }
        // A connection with nothing to hand to the engine is done here: `flush` would find nothing, at the price of a
        // dozen promise turns, for every connection on every poll.
        if (channel) { channel.receive(state); if (channel.moving) await channel.flush(); }
      } catch (error) {
        channel?.close({ drain: false });
        this.waiting.get(state.id)?.reject(error instanceof Error ? error : new Error('NATIVE_CONNECTION_CLOSED'));
        this.waiting.delete(state.id);
        this.engine.assertCurrent?.();
      }
    }
    for (const [id, channel] of this.channels) if (!alive.has(id)) channel.close({ drain: false });
    for (const [id, waiting] of this.waiting) if (now() >= waiting.deadline || (waitingAtPoll.get(id) === waiting && !alive.has(id))) {
      this.waiting.delete(id); waiting.reject(new Error('NATIVE_CONNECT_TIMEOUT'));
      void this.call({ op: 'close', id }).catch(() => undefined);
    }
    // Keepalives and acknowledgements of nothing do not count: they need no fast reply.
    if (this.waiting.size > 0 || [...this.channels.values()].some(channel => channel.moving)
      || result.connections.some(state => !state.established || state.unacked || state.data.length > 0 || state.events.length > 0
        || state.buffered?.some(([, bytes]) => bytes > 0))) this.activeUntil = now() + ACTIVE_WINDOW_MS;
  }
  detach(id: number): void {
    this.channels.delete(id);
    if (!this.closed) void this.call({ op: 'close', id }).catch(() => undefined);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const ids = [...this.channels.keys(), ...this.waiting.keys()];
    for (const pending of this.waiting.values()) pending.reject(new Error('NATIVE_TRANSPORT_CLOSED'));
    this.waiting.clear();
    for (const done of [...this.relayUdpWaiters]) done();
    for (const channel of [...this.channels.values()]) channel.close({ drain: false });
    this.channels.clear();
    if (this.enhanced && ids.length) {
      // The socket has already closed its WebSocket. Flush native UDP close packets
      // while the engine is current, then destroy it.
      try {
        this.engine.assertCurrent?.();
        for (const id of ids) await this.engine.command({ op: 'close', id });
        await this.engine.command({ op: 'poll' });
      } catch { /* Another account or a failed engine: nothing more may be sent. */ }
    }
    await this.engine.destroy();
  }
}

/** One outgoing stream: bytes queued in JS until the engine takes them, and what the engine still holds of it. */
class Outgoing {
  stream: number | null = null;
  items: { bytes: Uint8Array; offset: number }[] = [];
  queued = 0;
  /** Bytes in the core's send buffer for this stream at the last poll (0 on builds without `stream-buffered`). */
  core = 0;
  constructor(readonly priority: 'interactive' | 'normal' | 'background', readonly reserved: boolean) {}
  push(bytes: Uint8Array): void { this.items.push({ bytes, offset: 0 }); this.queued += bytes.length; }
}

class NativeChannel implements PeerChannel {
  private events = new ChannelEvents();
  private readonly data = new Outgoing('normal', true);
  private readonly control = new Outgoing('interactive', false);
  /** Session lanes, opened on first use after the peer declared session support (as the Desktop's CoreChannel). */
  private lanes: Record<SessionLaneName, Outgoing> | null = null;
  private streams = new Map<number, { kind: number | null; text: string }>();
  private state: NativeState | null = null;
  private candidates: Address[] = [];
  private candidateCursor = 0;
  private nextProbe = 0;
  private disposed = false;
  private closeDeadline = 0;
  private finished = false;
  private sessionCapable = false;
  private sessionsDeclared = false;
  private peerSessionFeatures: string[] = [];
  private readonly sessionCapableHandlers: Array<() => void> = [];
  private sessionHandler: ((lane: SessionLaneName, bytes: Uint8Array) => void) | null = null;
  private earlySession: Array<[SessionLaneName, Uint8Array]> = [];
  private earlySessionBytes = 0;
  private readonly drainHandlers: Array<() => void> = [];
  constructor(private owner: NativeTransport, private id: number, readonly remoteId: string) {}
  async initialize(): Promise<void> {
    this.data.stream = await this.owner.call<number>({ op: 'openStream', id: this.id });
    await this.owner.call({ op: 'write', id: this.id, stream: this.data.stream, data: toBase64Url(Uint8Array.of(DATA)) });
    this.control.stream = await this.owner.call<number>({ op: 'openStream', id: this.id, priority: 'interactive' });
    const bytes = concatBytes([Uint8Array.of(CONTROL), utf8(JSON.stringify({ candidates: this.owner.candidates() }) + '\n')]);
    await this.owner.call({ op: 'write', id: this.id, stream: this.control.stream, data: toBase64Url(bytes) });
  }
  /** This side's candidates changed (STUN answered, another network): tell the peer, as the Desktop re-announces. */
  announceCandidates(): void {
    if (this.events.closed || !this.owner.candidates().length) return;
    this.control.push(utf8(JSON.stringify({ candidates: this.owner.candidates() }) + '\n'));
    this.owner.wake();
  }
  send(bytes: Uint8Array): void {
    if (this.events.closed) throw new Error('NATIVE_CONNECTION_CLOSED');
    this.owner.reserve(bytes.length);
    this.data.push(bytes.slice());
    this.owner.wake();
  }
  get bufferedAmount(): number { return this.data.queued + this.control.queued; }
  /** Bytes still waiting here for the engine, or a close still draining: the transport keeps polling fast. */
  get moving(): boolean {
    return !this.disposed && (this.closeDeadline > 0 || this.data.queued > 0 || this.control.queued > 0
      || (this.lanes !== null && (this.lanes.control.queued > 0 || this.lanes.normal.queued > 0 || this.lanes.background.queued > 0)));
  }
  onDrain(handler: () => void): void { this.drainHandlers.push(handler); }

  /** See CoreChannel.declareSessions (transport.ts): once per connection, on the control stream older nodes read only for candidates. */
  declareSessions(features: readonly string[] = []): void {
    if (!this.owner.enhanced || this.sessionsDeclared || this.events.closed) return;
    this.sessionsDeclared = true;
    this.control.push(utf8(`${JSON.stringify({ session: [AGENT_NET_SESSION_V1, ...features] })}\n`));
    this.owner.wake();
  }
  sessionFeatures(): readonly string[] { return this.peerSessionFeatures; }
  onSessionCapable(handler: () => void): void { if (this.sessionCapable) handler(); else this.sessionCapableHandlers.push(handler); }
  sessionWire(): SessionWire | null {
    if (!this.sessionCapable || this.events.closed) return null;
    if (!this.lanes) {
      const open = (lane: SessionLaneName) => {
        const outgoing = new Outgoing(SESSION_LANE_PRIORITY[lane], false);
        outgoing.push(Uint8Array.of(SESSION_LANE_KINDS[lane]));
        return outgoing;
      };
      this.lanes = { control: open('control'), normal: open('normal'), background: open('background') };
    }
    const lanes = this.lanes;
    return {
      write: (lane, bytes) => { if (!this.events.closed) { lanes[lane].push(bytes); this.owner.wake(); } },
      // As the Desktop (transport.ts): control and normal lanes count what the core still buffers, so a slow line pushes
      // back before a megabyte of pushes queues ahead of interactive replies; the background lane (file blocks) counts
      // only what waits here, so a download does not hold back task text.
      get bufferedAmount() {
        return lanes.control.queued + lanes.control.core + lanes.normal.queued + lanes.normal.core + lanes.background.queued;
      },
      onData: (handler) => {
        this.sessionHandler = handler;
        for (const [lane, bytes] of this.earlySession.splice(0)) handler(lane, bytes);
        this.earlySessionBytes = 0;
      },
    };
  }
  private sessionData(lane: SessionLaneName, bytes: Uint8Array): void {
    if (this.sessionHandler) { this.sessionHandler(lane, bytes); return; }
    this.earlySessionBytes += bytes.length;
    if (this.earlySessionBytes > MAX_EARLY_SESSION_BYTES) { this.close({ drain: false }); return; }
    this.earlySession.push([lane, bytes.slice()]);
  }

  /** Hands queued bytes to the engine: control first, then the interactive lane, normal traffic, and the background lane last. */
  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.closeDeadline && now() >= this.closeDeadline) { this.dispose(); return; }
    const before = this.bufferedAmount;
    const order = this.owner.enhanced ? [this.control, ...(this.lanes ? [this.lanes.control, this.lanes.normal] : []), this.data, ...(this.lanes ? [this.lanes.background] : [])] : [this.data];
    for (const outgoing of order) { if (this.disposed) return; if (outgoing.items.length) await this.flushStream(outgoing); }
    if (this.owner.enhanced && before > DRAIN_LOW_WATER_BYTES && this.bufferedAmount <= DRAIN_LOW_WATER_BYTES) for (const handler of this.drainHandlers) handler();
    if (this.closeDeadline && !this.finished && order.every(outgoing => !outgoing.items.length)) {
      this.finished = true;
      // As CoreChannel.close: every stream this side opened ends, so the peer sees this side leave.
      for (const outgoing of order) if (outgoing.stream !== null) await this.owner.call({ op: 'finish', id: this.id, stream: outgoing.stream });
    }
  }
  private async flushStream(outgoing: Outgoing): Promise<void> {
    if (!outgoing.items.length) return;
    if (outgoing.stream === null) outgoing.stream = await this.owner.call<number>({ op: 'openStream', id: this.id, priority: outgoing.priority });
    for (let turn = 0; turn < WRITES_PER_STREAM && outgoing.items.length && !this.disposed; turn++) {
      const item = outgoing.items[0], part = item.bytes.subarray(item.offset, item.offset + WRITE_CHUNK);
      const written = await this.owner.call<number>({ op: 'write', id: this.id, stream: outgoing.stream, data: toBase64Url(part) });
      if (!Number.isInteger(written) || written < 0 || written > part.length) throw new Error('INVALID_NATIVE_WRITE');
      if (!written) break;
      item.offset += written; outgoing.queued -= written;
      if (outgoing.reserved) this.owner.release(written);
      if (item.offset === item.bytes.length) outgoing.items.shift();
    }
  }
  receive(state: NativeState): void {
    this.state = state;
    if (Array.isArray(state.buffered)) {
      const core = new Map(state.buffered);
      for (const outgoing of [this.data, this.control, ...(this.lanes ? Object.values(this.lanes) : [])]) {
        outgoing.core = outgoing.stream === null ? 0 : core.get(outgoing.stream) ?? 0;
      }
    }
    // Retired channels cannot send, but already-written peer frames may arrive
    // after a replacement handshake. Keep receive alive for the bounded drain;
    // local send ACK completion alone says nothing about incoming bytes.
    if (this.disposed) return;
    if (this.closeDeadline && now() >= this.closeDeadline) { this.dispose(); return; }
    for (const event of state.events) if (event.kind === 'open') {
      if (this.streams.size >= 128) { this.close({ drain: false }); return; }
      this.streams.set(event.stream, { kind: null, text: '' });
    }
    for (const chunk of state.data) {
      const stream = this.streams.get(chunk.stream);
      if (!stream) { this.close({ drain: false }); return; }
      let data = fromBase64Url(chunk.data);
      if (stream.kind === null && data.length) { stream.kind = data[0]; data = data.subarray(1); }
      if (stream.kind === DATA) { if (data.length) this.events.data(data); continue; }
      const lane = !this.owner.enhanced || stream.kind === null ? undefined : LANE_BY_KIND.get(stream.kind);
      if (lane) { if (data.length) this.sessionData(lane, data); if (this.disposed) return; continue; }
      if (stream.kind === CONTROL) {
        stream.text += decodeUtf8(data);
        if (stream.text.length > 8192) { this.close({ drain: false }); return; }
        for (let end = stream.text.indexOf('\n'); end >= 0; end = stream.text.indexOf('\n')) {
          this.onControl(stream.text.slice(0, end));
          stream.text = stream.text.slice(end + 1);
        }
      } else if (stream.kind !== null) { this.close({ drain: false }); return; }
    }
    for (const event of state.events) if (event.kind === 'finish') {
      if (this.streams.get(event.stream)?.kind === DATA) { this.close(); return; }
      this.streams.delete(event.stream);
    }
    if (!this.events.closed && now() >= this.nextProbe && this.candidates.length) {
      this.nextProbe = now() + 10_000;
      const count = Math.min(4, this.candidates.length);
      for (let index = 0; index < count; index++) {
        const address = this.candidates[(this.candidateCursor + index) % this.candidates.length];
        void this.owner.call({ op: 'probe', id: this.id, address }).catch(() => undefined);
      }
      this.candidateCursor = (this.candidateCursor + count) % this.candidates.length;
    }
  }
  private onControl(line: string): void {
    let value: { candidates?: unknown; session?: unknown };
    // Ignore malformed control lines, never business frames.
    try { value = JSON.parse(line); } catch { return; }
    if (this.owner.enhanced && Array.isArray(value?.session) && value.session.includes(AGENT_NET_SESSION_V1) && !this.sessionCapable) {
      this.sessionCapable = true;
      this.peerSessionFeatures = value.session
        .filter((feature): feature is string => typeof feature === 'string' && feature !== AGENT_NET_SESSION_V1 && feature.length <= 64).slice(0, 16);
      for (const handler of this.sessionCapableHandlers.splice(0)) handler();
    }
    if (Array.isArray(value?.candidates)) {
      const candidates = value.candidates.filter((a: Address) => a && typeof a.address === 'string' && a.address.length <= 128
        && Number.isInteger(a.port) && a.port > 0 && a.port <= 65535);
      if (this.owner.enhanced) candidates.sort((a: Address, b: Address) => Number(isPrivate(a.address)) - Number(isPrivate(b.address)));
      this.candidates = candidates.slice(0, MAX_CANDIDATES);
      this.candidateCursor = 0; this.nextProbe = 0;
    }
  }
  onData(handler: (bytes: Uint8Array) => void): void { this.events.onData(handler); }
  onClose(handler: () => void): void { this.events.onClose(handler); }
  path(): 'direct' | 'relay' | null { return this.events.closed || !this.state?.path ? null : 'link' in this.state.path ? 'relay' : 'direct'; }
  stats(): Record<string, number> | null {
    return this.events.closed || !this.state ? null : { srttUs: this.state.rttUs, sent: this.state.sent, received: this.state.received, rotations: this.state.rotations };
  }
  close(options?: { drain?: boolean }): void {
    if (this.disposed) return;
    this.events.close();
    if (options?.drain !== false) { this.closeDeadline ||= now() + 2_000; this.owner.wake(); return; }
    this.dispose();
  }
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.data.items) this.owner.release(item.bytes.length - item.offset);
    for (const outgoing of [this.data, this.control, ...(this.lanes ? Object.values(this.lanes) : [])]) { outgoing.items = []; outgoing.queued = 0; }
    this.streams.clear(); this.earlySession = []; this.events.close(); this.owner.detach(this.id);
  }
}

/** Private addresses: LAN, carrier NAT, link-local (as transport.ts). */
function isPrivate(address: string): boolean {
  if (address.includes(':')) return /^(fe80:|fc|fd)/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
}
