import {
  AGENT_NET_SESSION_V1, AGENT_NET_SESSION_V2, ChannelEvents, EARLY_BODY_EVENT_BYTES, MAX_EARLY_SESSION_BYTES,
  SESSION_BODY_HEADER_BYTES, SESSION_BODY_KIND,
  SESSION_LANE_KINDS, SESSION_LANE_PRIORITY, type PeerChannel, type RosterEntry, type SessionBodyWriter, type SessionLaneName,
  type SessionWire, type Transport, type TransportOptions, type RelayRoute, type PathPreference, type PeerPathMetrics,
} from './types.js';
import { PathRouter } from './pathRouter.js';
import { concatBytes, decodeUtf8, fromBase64Url, keyHex, toBase64Url, utf8 } from './portableBytes.js';

export interface NativeEnginePort {
  command<T = unknown>(command: Record<string, unknown>): Promise<T>;
  /**
   * `native-wait` binaries: resolves true as soon as the engine has something to read with `poll`, false after `maxMs`.
   * Meanwhile the engine receives, acknowledges and runs its timers by itself (see `NativeTransport.rest`).
   */
  wait?(maxMs: number): Promise<boolean>;
  /**
   * `binary-io` binaries (engine.rs `io`): relayed datagrams, stream writes and a poll in one call, the bytes raw beside a
   * small JSON header (`encodeNativeIo`). With `waitMs` the call first waits as `wait` does and reads only once the engine
   * has something for JS (an empty result otherwise), so an answer comes back in the call that waited for it. `kick`: once
   * this call is done, wake a waiting call if the engine now has something for JS.
   */
  io?(input: Uint8Array, waitMs?: number, kick?: boolean): Promise<Uint8Array>;
  /** `binary-io` binaries: a waiting `io` call returns now. */
  kick?(): void;
  destroy(): Promise<void>;
  assertCurrent?(): void;
}
interface Address { address: string; port: number; }
interface NativeState {
  id: number; established: boolean; dead: boolean; closedByPeer: boolean; unacked: boolean; remoteKey: string;
  path?: Address | { link: number };
  events: { kind: 'open' | 'finish'; stream: number }[];
  data: { stream: number; data: Uint8Array }[];
  rttUs: number; sent: number; received: number; rotations: number;
  /** [stream, bytes still in the core's send buffer] for the streams this side opened (`stream-buffered` builds). */
  buffered?: [number, number][];
  /** Round trips the core measured on paths it validated, in µs (`path-routing` builds). */
  probeRtts?: [Address | { link: number }, number][];
}
interface Poll {
  packets: { link: number; data: Uint8Array }[]; connections: NativeState[]; mapped?: Address[]; relayUdp?: boolean;
  /** `relay-udp-health` builds: how relayed datagrams go and why (engine.rs `read`, udp_paths.rs `route`). */
  relayRoute?: RelayRoute | null;
  /** `relay-udp-health` builds: bytes sent and received on the engine's UDP socket so far. */
  udpTraffic?: [number, number] | null;
}
/** A poll as the engine reports it: bytes as base64 `data` (`poll`), or as the `len` of the next bytes after the header (`io`). */
type WireBytes = { data?: string; len?: number };
type WirePoll = Omit<Poll, 'packets' | 'connections'> & {
  packets: ({ link: number } & WireBytes)[];
  connections: (Omit<NativeState, 'data'> & { data: ({ stream: number } & WireBytes)[] })[];
};
interface IoResult { written: number[]; poll: WirePoll | null; }
interface PlannedWrite { channel: NativeChannel; outgoing: Outgoing; bytes: Uint8Array; }

/** `binary-io` frame (lib.rs `cindy_agent_net_io`): a little-endian u32 header length, the JSON header, then the bytes it lists. */
export function encodeNativeIo(header: object, parts: readonly Uint8Array[] = []): Uint8Array {
  const json = utf8(JSON.stringify(header));
  let size = 4 + json.length;
  for (const part of parts) size += part.length;
  const frame = new Uint8Array(size);
  new DataView(frame.buffer).setUint32(0, json.length, true);
  frame.set(json, 4);
  let offset = 4 + json.length;
  for (const part of parts) { frame.set(part, offset); offset += part.length; }
  return frame;
}
/** Reads an `io` result frame: the engine's answer, or its error code thrown as the command path throws it. */
export function decodeNativeIo<T>(frame: Uint8Array): { value: T; payload: Uint8Array } {
  if (frame.length < 4) throw new Error('INVALID_NATIVE_IO');
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  if (4 + length > frame.length) throw new Error('INVALID_NATIVE_IO');
  const response = JSON.parse(decodeUtf8(frame.subarray(4, 4 + length))) as { ok: boolean; value?: T; code?: string };
  if (!response.ok) throw new Error(response.code || 'AGENT_NET_NATIVE_COMMAND_FAILED');
  return { value: response.value as T, payload: frame.subarray(4 + length) };
}
/** A poll with its bytes in hand: base64 from `poll`, or slices of an `io` result in the order the engine wrote them. */
function readPoll(wire: WirePoll, payload: Uint8Array | null): Poll {
  let cursor = 0;
  const bytes = (item: WireBytes): Uint8Array => {
    if (!payload) return fromBase64Url(item.data ?? '');
    const length = item.len;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || cursor + length > payload.length) throw new Error('INVALID_NATIVE_IO');
    cursor += length;
    return payload.subarray(cursor - length, cursor);
  };
  const packets = wire.packets.map(packet => ({ link: packet.link, data: bytes(packet) }));
  const connections = wire.connections.map(state => ({ ...state, data: state.data.map(chunk => ({ stream: chunk.stream, data: bytes(chunk) })) }));
  if (payload && cursor !== payload.length) throw new Error('INVALID_NATIVE_IO');
  return { ...wire, packets, connections };
}
const SUSPENSION_REASONS = new Set(['data-silence', 'request-timeouts', 'unacked-sends']);
/** The engine's `relayRoute`, kept only in the shape the socket reports (types.ts `RelayRoute`). */
function readRoute(value: unknown): RelayRoute | null {
  if (!value || typeof value !== 'object') return null;
  const route = value as Partial<RelayRoute>;
  const rttMs = typeof route.rttMs === 'number' && Number.isFinite(route.rttMs) && route.rttMs >= 0 ? route.rttMs : null;
  const suspension = route.udpSuspension;
  const udpSuspension = suspension && SUSPENSION_REASONS.has(suspension.reason) && typeof suspension.cooldownMs === 'number'
    ? { reason: suspension.reason, cooldownMs: suspension.cooldownMs } : undefined;
  return route.via === 'udp' ? { via: 'udp', rttMs } : { via: 'websocket', rttMs: null, ...(udpSuspension ? { udpSuspension } : {}) };
}
interface NativeIdentity { deviceId: string; transportKey: string; udpPort: number | null; features?: string[]; }
interface Waiting { resolve(channel: PeerChannel): void; reject(error: Error): void; deadline: number; }
/** This side's local addresses for its candidates: a fixed list, or read again on every network change. */
export type NativeAddresses = string[] | (() => Promise<string[]>);
const MAX_PENDING = 16 * 1024 * 1024;
const MAX_CANDIDATES = 16;
/** `path-routing`: probe the candidates again this often while relayed, as the WASM transport (`DEFAULT_REPROBE_MS`). */
const NATIVE_REPROBE_MS = 10_000;
/** Same as the Desktop driver (transport.ts): at most this many STUN servers are asked. */
const MAX_STUN_SERVERS = 4;
/** `resolveUdpServer`: the relay's UDP host is looked up again this often, and on every network change (relayUdp.ts `RESOLVE_REFRESH_MS`). */
const UDP_SERVER_REFRESH_MS = 5 * 60_000;
const DATA = 0x44;
const CONTROL = 0x43;
const LANE_BY_KIND = new Map<number, SessionLaneName>(Object.entries(SESSION_LANE_KINDS).map(([lane, kind]) => [kind, lane as SessionLaneName]));
/**
 * Session v2 body streams one connection keeps at once, until what they carried was acknowledged; more messages go on their lanes
 * as in v1. The core allows 64 streams per connection, five of them this channel's own.
 */
const MAX_NATIVE_BODIES = 32;
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
/** `binary-io`: per `io` call at most this many bytes of writes, and as many of relayed datagrams (lib.rs MAX_IO is 4 MiB). */
const MAX_IO_BYTES = 1024 * 1024;
/**
 * `binary-io`: per `io` call at most this many writes (engine.rs refuses a call with more than MAX_IO_WRITES, 1024). Small messages
 * queued on many connections reach it long before the byte budget: 129 connections with 8 each are 1032 writes of a few bytes, and a
 * refused call closed the whole transport (PR #12036 review). The rest goes next turn.
 */
const MAX_IO_WRITES = 512;
/** `binary-io`: relayed datagrams waiting here for the next `io` call; beyond this the oldest go (the core resends). */
const MAX_RELAYED = 512;
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
 * - `binary-io`: stream bytes and relayed datagrams cross the bridge raw, and a turn's writes and its poll are one call
 *   (`exchange`); with `native-wait` the call that waits also brings back what the engine then has (`restBinary`). On a
 *   phone whose cores had clocked down every async bridge call cost 3–4 ms and a 2 KB answer took 3.8 ms to decode from
 *   base64; an answer took three crossings (the wait returning, then the poll there and back) (2026-11-21).
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
  /** `binary-io`: writes, relayed datagrams and polls go through `io` (`exchange`). */
  private readonly binary: boolean;
  /**
   * Session v2 body streams (opened here, read from peers): only on an engine whose core sends every stream's credit when answering
   * a probe (`probe-grants`). An older core sends the two lowest streams' only, and a body is a connection's sixth stream: when its
   * first credit did not get through, the peer stops at 128 segments for good (2026-11-22, CI). Such a phone keeps to v1.
   */
  readonly bodies: boolean;
  /** `binary-io` with `native-wait`: a waiting `io` call is out (`restBinary`); it reads for JS, a drive meanwhile does not. */
  private resting = false;
  /** Polls a waiting `io` call brought back while a drive ran: the drive applies them before anything it reads itself. */
  private parked: { poll: Poll; waitingAtPoll: Map<number, Waiting> }[] = [];
  /** `binary-io`: datagrams from the relay WebSocket for the next `io` call. */
  private relayed: { link: number; bytes: Uint8Array }[] = [];
  /** `binary-io`: the next drive reads even with nothing to write (the first one, a dial's deadline, the periodic full poll). */
  private mustRead = true;
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
  /** The relay UDP server the engine was last given with them: a new address (moved, or Fake-IP avoided) goes to it as well. */
  private relaySyncedServer: string | undefined;
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
  /** The relay UDP server as configured (`host:port`), which `resolveUdpServer` turns into `relayUdpServer`. */
  private relayUdpName: string | undefined;
  private stunServers: string[];
  private stunGeneration = 0;
  private udpRefresh: ReturnType<typeof setInterval> | null = null;
  /** `relay-udp-health`: the route the engine last reported for relayed datagrams (`relayRoute`). */
  private route: RelayRoute | null = null;
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
    this.binary = enhanced && this.features.has('binary-io') && typeof engine.io === 'function';
    this.bodies = enhanced && this.features.has('probe-grants');
    // With `resolveUdpServer` the engine gets no server until it answered (`resolveUdpServers`): relayed datagrams stay on the
    // WebSocket meanwhile, and the engine never looks the name up itself first (a Fake-IP).
    this.relayUdpServer = options.resolveUdpServer ? undefined : options.relayUdpServer;
    this.relayUdpName = options.relayUdpServer;
    this.stunServers = (options.stunServers ?? []).slice(0, MAX_STUN_SERVERS);
    this.localAddresses = addresses;
    this.candidateList = this.computeCandidates();
    options.relay?.uplink.onDatagram((deviceId, bytes) => {
      if (this.closed) return;
      const link = this.links.get(deviceId);
      if (!link) return;
      if (this.binary) {
        if (this.relayed.length >= MAX_RELAYED) this.relayed.shift();
        this.relayed.push({ link, bytes });
      } else void this.call({ op: 'datagram', from: { link }, data: toBase64Url(bytes) }).catch(() => undefined);
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
      // Resolved in the background, as the WASM transport gathers STUN candidates: a slow DNS answer must not hold up a transport
      // that can already reach peers over the relay WebSocket or the LAN.
      if (options.resolveUdpServer) void transport.resolveUdpServers();
      else await transport.startStun(transport.stunServers);
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
  /** Benchmarks and tests that force the relay path: no private address is offered or probed (`publicCandidatesOnly`). */
  get publicOnly(): boolean { return this.options.publicCandidatesOnly === true; }
  /** The engine's relay link to the peer with this transport key, when it has a relay id. */
  linkOf(remoteId: string): number | null {
    const deviceId = this.options.relayIdOf?.(remoteId);
    return (deviceId && this.links.get(deviceId)) || null;
  }
  private computeCandidates(): Address[] {
    const port = this.identity.udpPort;
    if (!port) return [];
    // Benchmarks and tests that force the relay path offer public addresses only, as the WASM transport does (`publicCandidatesOnly`).
    const allowed = (address: string) => address.length <= 128 && (!this.options.publicCandidatesOnly || !isPrivate(address));
    const local = this.localAddresses.filter(allowed).map(address => ({ address, port }));
    if (!this.enhanced) return local.slice(0, MAX_CANDIDATES);
    const seen = new Set<string>();
    return [...local, ...this.mapped.filter(candidate => allowed(candidate.address))]
      .filter(candidate => { const key = `${candidate.address}:${candidate.port}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => Number(isPrivate(a.address)) - Number(isPrivate(b.address))).slice(0, MAX_CANDIDATES);
  }
  private updateCandidates(): void {
    const next = this.computeCandidates();
    if (JSON.stringify(next) === JSON.stringify(this.candidateList)) return;
    this.candidateList = next;
    for (const channel of this.channels.values()) channel.announceCandidates();
  }
  async configureUdpServer(server: string, extraStunServers: readonly string[] = []): Promise<void> {
    if (this.closed || !this.enhanced) return;
    this.relayUdpName = server;
    this.relayUdpServer = await this.resolveUdpServer(server);
    if (this.closed) return;
    // The next poll hands the engine the relay's UDP credentials: now, not when the engine next has something for JS.
    this.wake();
    await this.configureStunServers([this.relayUdpServer, ...extraStunServers]);
  }
  async configureStunServers(servers: readonly string[]): Promise<void> {
    if (this.closed || !this.enhanced) return;
    const unique = [...new Set(servers.map(s => s.trim()).filter(Boolean))].slice(0, MAX_STUN_SERVERS);
    if (!unique.length) return;
    const generation = ++this.stunGeneration;
    const resolved = this.options.resolveUdpServer
      ? await Promise.all(unique.map(server => this.resolveUdpServer(server)))
      : unique;
    if (this.closed || generation !== this.stunGeneration) return;
    this.stunServers = [...new Set(resolved)].slice(0, MAX_STUN_SERVERS);
    await this.startStun(this.stunServers);
  }
  /** The relay UDP and STUN servers as `resolveUdpServer` gives them (unchanged without it, or when it fails). */
  private async resolveUdpServers(): Promise<void> {
    if (!this.options.resolveUdpServer) return;
    const generation = this.stunGeneration;
    const [relay, stun] = await Promise.all([this.relayUdpName ? this.resolveUdpServer(this.relayUdpName) : undefined,
      Promise.all(this.stunServers.map(server => this.resolveUdpServer(server)))]);
    if (this.closed) return;
    // `configureUdpServer` may have set another server meanwhile: that one stands.
    this.relayUdpServer ??= relay;
    this.wake();
    if (generation === this.stunGeneration) {
      this.stunServers = stun;
      await this.startStun(this.stunServers);
    }
    if (!this.udpRefresh && this.relayUdpName && !this.closed) {
      this.udpRefresh = setInterval(() => { void this.refreshUdpServer(); }, UDP_SERVER_REFRESH_MS);
      (this.udpRefresh as { unref?: () => void }).unref?.();
    }
  }
  private resolveUdpServer(server: string): Promise<string> {
    const resolve = this.options.resolveUdpServer;
    return resolve ? resolve(server).catch(() => server) : Promise.resolve(server);
  }
  /** The relay's UDP host answers with another address now (moved, or a proxy's Fake-IP went away): the engine registers there. */
  private async refreshUdpServer(): Promise<void> {
    if (this.closed || !this.relayUdpName || !this.options.resolveUdpServer) return;
    const next = await this.resolveUdpServer(this.relayUdpName);
    if (this.closed || next === this.relayUdpServer) return;
    const previous = this.relayUdpServer;
    this.relayUdpServer = next;
    this.wake();
    const stun = [next, ...this.stunServers.filter(server => server !== previous && server !== next)].slice(0, MAX_STUN_SERVERS);
    this.stunServers = stun;
    await this.startStun(stun);
  }
  private async startStun(servers = this.stunServers): Promise<void> {
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
    if (credentials === this.relayCredentials && server === this.relaySyncedServer) return;
    this.relayCredentials = credentials;
    this.relaySyncedServer = server;
    await this.call({ op: 'relayUdp', server, ...(credentials
      ? { session: toBase64Url(credentials.session), key: toBase64Url(credentials.key), ...(credentials.probe === true ? { probe: true } : {}) } : { session: null }) });
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
    const dial = entry.dial as { relayId?: string; udp?: Address; preferUdp?: boolean; timeoutMs?: number };
    const expected = this.options.relayIdOf?.(entry.id);
    if (!expected || dial.relayId !== expected) throw new Error('PEER_ADDRESS_MISMATCH');
    const address = dial.preferUdp && dial.udp ? dial.udp : { link: this.linkFor(expected) };
    if ('link' in address) await this.relayUdpSettled();
    const key = toBase64Url(Uint8Array.from(entry.id.match(/../g)!, part => parseInt(part, 16)));
    const id = await this.call<number>({ op: 'connect', key, address });
    const budgetMs = typeof dial.timeoutMs === 'number' && dial.timeoutMs > 0 ? dial.timeoutMs : 3_000;
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('NATIVE_TRANSPORT_CLOSED')); return; }
      this.waiting.set(id, { resolve, reject, deadline: now() + budgetMs });
      this.wake();
    });
  }
  /**
   * How relayed datagrams go now (types.ts `RelayRoute`), as the WASM transport reports it (transport.ts `relayRoute`): over the
   * relay's UDP port with its registration round trip, or over the relay WebSocket, and why while relay UDP is off for carrying
   * no data. Null without a relay. An engine without `relay-udp-health` reports only whether UDP is up, without a round trip.
   */
  relayRoute(): RelayRoute | null {
    if (!this.options.relay || this.closed) return null;
    if (this.relayUdpUp) return { via: 'udp', rttMs: this.route?.via === 'udp' ? this.route.rttMs : null };
    const suspension = this.route?.udpSuspension;
    return suspension ? { via: 'websocket', rttMs: null, udpSuspension: suspension } : { via: 'websocket', rttMs: null };
  }
  /** Session requests to a relayed peer timed out: the engine judges whether relay UDP carries data (udp_paths.rs `note_stall`). */
  relayStalled(): void {
    if (this.closed || !this.supports('relay-udp-health')) return;
    void this.call({ op: 'relayStalled' }).catch(() => undefined);
    this.wake();
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
    void this.refreshUdpServer();
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
  private drive(read = false): void {
    if (read) this.mustRead = true;
    if (this.closed) return;
    if (this.polling) { this.again = true; return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.polling = true;
    void (async () => {
      try {
        if (this.binary) {
          await this.exchange();
          if (this.again && !this.closed) { this.again = false; await this.exchange(); }
        } else {
          await this.writeFirst();
          await this.poll();
          if (this.again && !this.closed) { this.again = false; await this.writeFirst(); await this.poll(); }
        }
      } catch { this.polling = false; await this.close(); return; }
      this.polling = false;
      this.again = false;
      if (this.closed) return;
      // A waiting call came back during the last turn, after that turn applied what was parked.
      if (this.parked.length) { this.drive(); return; }
      if (!this.waits) this.schedule();
      else if (!this.binary) this.rest();
      else if (!this.resting) this.restBinary();
      // The waiting call may be on IDLE_WAIT_MS while a dial or unwritten bytes need JS back within FAST_POLL_MS.
      else if (this.busy()) this.kickRest();
    })();
  }
  private busy(): boolean { return this.waiting.size > 0 || [...this.channels.values()].some(channel => channel.moving); }
  private async io(input: Uint8Array, waitMs: number, kick: boolean): Promise<Uint8Array> {
    if (this.closed) throw new Error('NATIVE_TRANSPORT_CLOSED');
    this.engine.assertCurrent?.();
    const output: Uint8Array | ArrayBuffer = await this.engine.io!(input, waitMs, kick);
    this.engine.assertCurrent?.();
    if (this.closed) throw new Error('NATIVE_TRANSPORT_CLOSED');
    return output instanceof Uint8Array ? output : new Uint8Array(output);
  }
  /**
   * `binary-io`: one turn. What a waiting call read meanwhile goes first; then the admitted peers and the relay's credentials
   * go to the engine if they changed (before any write, as in `writeFirst`); then one `io` call hands the engine this turn's
   * relayed datagrams and writes and reads, unless a waiting call is out: that call reads, and this one wakes it if the engine
   * has something for JS afterwards (a datagram for the relay WebSocket, an answer).
   */
  private async exchange(): Promise<void> {
    await this.applyParked();
    if (this.closed) return;
    const version = this.options.admissionVersion?.();
    const changed = version === undefined || version !== this.mirroredVersion;
    if (changed) await this.synchronizeAdmission();
    await this.synchronizeRelayUdp();
    const datagrams: [number, number][] = [], parts: Uint8Array[] = [];
    for (let bytes = 0; this.relayed.length && bytes + this.relayed[0].bytes.length <= MAX_IO_BYTES;) {
      const { link, bytes: data } = this.relayed.shift()!;
      datagrams.push([link, data.length]); parts.push(data); bytes += data.length;
    }
    const writes: PlannedWrite[] = [], planned: NativeChannel[] = [], budget = { bytes: MAX_IO_BYTES, writes: MAX_IO_WRITES };
    for (const channel of [...this.channels.values()]) {
      if (!channel.moving || !this.options.admit(channel.remoteId)) continue;
      planned.push(channel);
      try { writes.push(...await channel.plan(budget)); }
      catch { channel.close({ drain: false }); this.engine.assertCurrent?.(); }
    }
    for (const write of writes) parts.push(write.bytes);
    const read = !this.resting && (!this.waits || this.mustRead || parts.length > 0 || this.waiting.size > 0);
    if (read || parts.length) {
      if (read) { this.mustRead = false; this.polledAt = now(); }
      const waitingAtPoll = new Map(this.waiting);
      const header = { datagrams, writes: writes.map(write => [write.channel.connectionId, write.outgoing.stream, write.bytes.length]), poll: read };
      const { value, payload } = decodeNativeIo<IoResult>(await this.io(encodeNativeIo(header, parts), 0, this.resting));
      if (!Array.isArray(value.written) || value.written.length !== writes.length) throw new Error('INVALID_NATIVE_IO');
      writes.forEach((write, index) => write.channel.consume(write.outgoing, value.written[index], write.bytes.length));
      await this.applyParked();
      if (value.poll) await this.applyPoll(readPoll(value.poll, payload), waitingAtPoll, false);
    }
    for (const channel of planned) await channel.afterWrites();
    // The once-a-second look for admission that lapsed with time does not hold this turn's writes back (see `writeFirst`).
    if (!changed && now() - this.admissionAt >= ADMISSION_RECHECK_MS) await this.synchronizeAdmission();
  }
  private async applyParked(): Promise<void> {
    while (this.parked.length && !this.closed) {
      const { poll, waitingAtPoll } = this.parked.shift()!;
      await this.applyPoll(poll, waitingAtPoll, false);
    }
  }
  /**
   * `binary-io` with `native-wait`: one `io` call waits in the engine until it has something for JS and brings it back in
   * the same call. Writes meanwhile go in their own `io` calls that do not read (`exchange`), so only one call reads at a
   * time and what is read reaches JS in order.
   */
  private restBinary(): void {
    if (this.closed || this.resting) return;
    this.resting = true;
    const waitingAtPoll = new Map(this.waiting);
    void this.io(encodeNativeIo({ poll: true }), this.busy() ? FAST_POLL_MS : IDLE_WAIT_MS, false).then((output) => {
      this.resting = false;
      if (this.closed) return;
      if (output.length) {
        const { value, payload } = decodeNativeIo<IoResult>(output);
        if (value.poll) { this.polledAt = now(); this.parked.push({ poll: readPoll(value.poll, payload), waitingAtPoll }); }
      }
      // A running drive applies it after its own call, which did not read.
      if (this.polling) { this.again = true; return; }
      if (this.parked.length) this.drive();
      else if (this.busy() || this.mirrorChanged() || now() - this.polledAt >= IDLE_FULL_POLL_MS) this.drive(true);
      else this.restBinary();
    }).catch(() => {
      // What a failed call read is lost to JS: start over on a new connection rather than go on with a gap.
      this.resting = false;
      if (!this.closed) void this.close();
    });
  }
  private kickRest(): void {
    if (this.engine.kick) { try { this.engine.kick(); return; } catch { /* The timer below brings JS back. */ } }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.drive(true); }, FAST_POLL_MS);
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
      || (this.options.relay?.udpCredentials?.() ?? null) !== (this.relayCredentials ?? null)
      || (this.relayUdpServer !== undefined && this.relayUdpServer !== this.relaySyncedServer);
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
    await this.applyPoll(readPoll(await this.call<WirePoll>({ op: 'poll' }), null), waitingAtPoll, true);
  }
  /**
   * What a poll read, applied in the order the engine read it. `flush`: hand each connection's queued bytes to the engine as
   * it goes (the command path); `binary-io` writes them in the next `io` call instead.
   */
  private async applyPoll(result: Poll, waitingAtPoll: Map<number, Waiting>, flush: boolean): Promise<void> {
    for (const packet of result.packets) {
      const deviceId = this.deviceForLink.get(packet.link);
      if (deviceId) this.options.relay?.uplink.send(deviceId, packet.data);
    }
    // What the engine reports is about the credentials it was given; newer ones seen meanwhile are not up yet.
    this.relayUdpUp = result.relayUdp === true && this.relayUdpFor === this.relayCredentials;
    if (this.relayUdpUp) for (const done of [...this.relayUdpWaiters]) done();
    if (result.relayRoute !== undefined) this.route = readRoute(result.relayRoute);
    const traffic = this.options.udpTraffic;
    if (traffic && Array.isArray(result.udpTraffic) && result.udpTraffic.every(value => Number.isSafeInteger(value) && value >= 0)) {
      Atomics.store(traffic, 0, BigInt(result.udpTraffic[0])); Atomics.store(traffic, 1, BigInt(result.udpTraffic[1]));
    }
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
        if (channel) { channel.receive(state); if (flush && channel.moving) await channel.flush(); }
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
    if (this.udpRefresh) clearInterval(this.udpRefresh); this.udpRefresh = null;
    const ids = [...this.channels.keys(), ...this.waiting.keys()];
    for (const pending of this.waiting.values()) pending.reject(new Error('NATIVE_TRANSPORT_CLOSED'));
    this.waiting.clear();
    this.parked = []; this.relayed = [];
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
  /**
   * `binary-io`: the stream took less than it was given last time (its send buffer is full). It gets one chunk per turn until
   * it takes a whole one, so a full stream does not carry half a megabyte across the bridge every turn only to refuse it.
   */
  short = false;
  constructor(readonly priority: 'interactive' | 'normal' | 'background', readonly reserved: boolean) {}
  push(bytes: Uint8Array): void { this.items.push({ bytes, offset: 0 }); this.queued += bytes.length; }
}

/**
 * Session v2: one message body on a stream of its own (types.ts SESSION_BODY_KIND). `closing`: complete (or given up), the stream
 * ends once its bytes are with the engine; `ended`: the end went to the engine, it stays counted until the core holds none of it.
 */
class Body extends Outgoing {
  closing = false;
  ended = false;
  abandoned = false;
}

class NativeChannel implements PeerChannel {
  private events = new ChannelEvents();
  private readonly data = new Outgoing('normal', true);
  private readonly control = new Outgoing('interactive', false);
  /** Session lanes, opened on first use after the peer declared session support (as the Desktop's CoreChannel). */
  private lanes: Record<SessionLaneName, Outgoing> | null = null;
  /** Session v2 body streams this side opened, until the core holds nothing of them. */
  private bodies: Body[] = [];
  /** `key`: a body stream's key, once its four bytes arrived after the kind (`head` collects them). */
  private streams = new Map<number, { kind: number | null; text: string; key?: number | null; head?: number[] }>();
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
  private bodyHandler: ((key: number, bytes: Uint8Array | null) => void) | null = null;
  private earlyBodies: Array<[number, Uint8Array | null]> = [];
  /** This side declared `AGENT_NET_SESSION_V2`: the peer may open body streams. */
  private bodiesDeclared = false;
  private readonly drainHandlers: Array<() => void> = [];
  private readonly pathHandlers: Array<(path: 'direct' | 'relay' | null) => void> = [];
  private reportedPath = '';
  /**
   * `path-routing` engines: direct or relayed, and when to probe or measure which path, the same as on the WASM transport
   * (pathRouter.ts), with the peer's preference synced on the control stream. Older engines probe the candidates every 10 s.
   */
  private readonly router: PathRouter<{ link: number }> | null;
  constructor(private owner: NativeTransport, private id: number, readonly remoteId: string) {
    const fire = (command: Record<string, unknown>) => { void owner.call({ ...command, id }).catch(() => undefined); };
    this.router = owner.enhanced && owner.supports('path-routing') ? new PathRouter<{ link: number }>({
      closed: () => this.events.closed || this.disposed,
      path: () => this.path(),
      directAddress: () => this.directAddress(),
      activeRttMs: () => (this.state?.rttUs ?? 0) > 0 ? this.state!.rttUs / 1000 : null,
      relayAddress: () => { const link = owner.linkOf(remoteId); return link ? { link } : null; },
      probe: (address) => fire({ op: 'probe', address }),
      measure: (address) => fire({ op: 'measure', address }),
      setPreferRelay: (prefer) => fire({ op: 'preferRelay', prefer }),
      writeControl: (line) => { this.control.push(utf8(line)); owner.wake(); },
    }, NATIVE_REPROBE_MS) : null;
    this.router?.start();
  }
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
      || (this.lanes !== null && (this.lanes.control.queued > 0 || this.lanes.normal.queued > 0 || this.lanes.background.queued > 0))
      || this.bodies.some(body => body.queued > 0 || (body.closing && !body.ended)));
  }
  /** Session v2: this channel opens and reads body streams (as the Desktop's CoreChannel); not on a plain-native transport. */
  get sessionBodies(): boolean { return this.owner.bodies; }
  onDrain(handler: () => void): void { this.drainHandlers.push(handler); }

  /** See CoreChannel.declareSessions (transport.ts): once per connection, on the control stream older nodes read only for candidates. */
  declareSessions(features: readonly string[] = []): void {
    if (!this.owner.enhanced || this.sessionsDeclared || this.events.closed) return;
    this.sessionsDeclared = true;
    this.bodiesDeclared = features.includes(AGENT_NET_SESSION_V2);
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
    const lanes = this.lanes, channel = this;
    return {
      write: (lane, bytes) => { if (!this.events.closed) { lanes[lane].push(bytes); this.owner.wake(); } },
      // As the Desktop (transport.ts): control and normal lanes count what the core still buffers, so a slow line pushes
      // back before a megabyte of pushes queues ahead of interactive replies; the background lane (file blocks) counts
      // only what waits here, so a download does not hold back task text.
      get bufferedAmount() {
        return lanes.control.queued + lanes.control.core + lanes.normal.queued + lanes.normal.core + lanes.background.queued + channel.bodiesBuffered();
      },
      onData: (handler) => {
        this.sessionHandler = handler;
        for (const [lane, bytes] of this.earlySession.splice(0)) handler(lane, bytes);
        this.earlySessionBytes = 0;
      },
      openBody: (lane, key) => this.openBody(lane, key),
      onBody: (handler) => {
        this.bodyHandler = handler;
        for (const [key, bytes] of this.earlyBodies.splice(0)) handler(key, bytes);
      },
      onDrain: (handler) => this.onDrain(handler),
    };
  }
  /** Session v2: bodies count like their lanes, on the control and normal lanes with what the core still buffers. */
  private bodiesBuffered(): number {
    let total = 0;
    for (const body of this.bodies) total += body.queued + (body.priority === 'background' ? 0 : body.core);
    return total;
  }
  /** Session v2: a stream of its own for one message body, at its lane's priority; opened in the engine with its first write. */
  private openBody(lane: SessionLaneName, key: number): SessionBodyWriter | null {
    if (!this.owner.bodies || this.events.closed || this.bodies.length >= MAX_NATIVE_BODIES) return null;
    const body = new Body(SESSION_LANE_PRIORITY[lane], false);
    const head = new Uint8Array(SESSION_BODY_HEADER_BYTES);
    head[0] = SESSION_BODY_KIND;
    new DataView(head.buffer).setUint32(1, key, false);
    body.push(head);
    this.bodies.push(body);
    this.owner.wake();
    return {
      write: (bytes) => { if (!this.events.closed && !body.closing) { body.push(bytes); this.owner.wake(); } },
      finish: () => { if (!body.closing) { body.closing = true; this.owner.wake(); } },
      abandon: () => this.abandonBody(body),
    };
  }
  /** What waits here is dropped, and what the engine's core has not sent (`abandon`): the peer sees the body end short. */
  private abandonBody(body: Body): void {
    if (body.abandoned || this.disposed) return;
    body.abandoned = true;
    body.closing = true;
    body.items = [];
    body.queued = 0;
    if (!body.ended) { this.owner.wake(); return; }
    if (body.stream !== null) {
      void this.owner.call({ op: 'abandon', id: this.id, stream: body.stream }).catch(() => undefined);
    }
  }
  private sessionBody(key: number, bytes: Uint8Array | null): void {
    if (this.bodyHandler) { this.bodyHandler(key, bytes); return; }
    // Every event counts, an end too: a peer that never attaches its session cannot pile up empty streams for free.
    this.earlySessionBytes += (bytes?.length ?? 0) + EARLY_BODY_EVENT_BYTES;
    if (this.earlySessionBytes > MAX_EARLY_SESSION_BYTES) { this.close({ drain: false }); return; }
    this.earlyBodies.push([key, bytes && bytes.slice()]);
  }
  private sessionData(lane: SessionLaneName, bytes: Uint8Array): void {
    if (this.sessionHandler) { this.sessionHandler(lane, bytes); return; }
    this.earlySessionBytes += bytes.length;
    if (this.earlySessionBytes > MAX_EARLY_SESSION_BYTES) { this.close({ drain: false }); return; }
    this.earlySession.push([lane, bytes.slice()]);
  }

  /** Control first, then the interactive lane, normal traffic, and the background lane last; each lane's bodies after it. */
  private order(): Outgoing[] {
    if (!this.owner.enhanced) return [this.data];
    const bodies = (priority: Outgoing['priority']) => this.bodies.filter(body => body.priority === priority && !body.ended);
    return [this.control, ...(this.lanes ? [this.lanes.control] : []), ...bodies('interactive'), ...(this.lanes ? [this.lanes.normal] : []),
      ...bodies('normal'), this.data, ...(this.lanes ? [this.lanes.background] : []), ...bodies('background')];
  }
  get connectionId(): number { return this.id; }
  /** Hands queued bytes to the engine in `order`. */
  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.closeDeadline && now() >= this.closeDeadline) { this.dispose(); return; }
    const before = this.bufferedAmount;
    for (const outgoing of this.order()) { if (this.disposed) return; if (outgoing.items.length) await this.flushStream(outgoing); }
    await this.drained(before);
  }
  private async drained(before: number): Promise<void> {
    if (this.disposed) return;
    // The engine took queued bytes: tell the socket, as the WASM transport does whenever the core takes some (transport.ts
    // `onDrain`). The socket fires its own drain once its whole backlog is under the watermark; several connections can add up
    // to more than it while none of them crosses it alone (2026-11-23 review), and the socket then waited for its next status.
    if (this.owner.enhanced && this.bufferedAmount < before) for (const handler of this.drainHandlers) handler();
    // A body whose bytes are all with the engine ends (one never opened there just ends); `receive` lets it go once the core holds none.
    for (const body of [...this.bodies]) {
      if (!body.closing || body.ended || body.items.length || this.disposed) continue;
      body.ended = true;
      if (body.stream !== null) await this.owner.call({ op: body.abandoned ? 'abandon' : 'finish', id: this.id, stream: body.stream });
    }
    if (this.disposed) return;
    const order = this.order();
    if (this.closeDeadline && !this.finished && order.every(outgoing => !outgoing.items.length)) {
      this.finished = true;
      // As CoreChannel.close: every stream this side opened ends, so the peer sees this side leave.
      for (const outgoing of order) if (outgoing.stream !== null) await this.owner.call({ op: 'finish', id: this.id, stream: outgoing.stream });
    }
  }
  /** `bufferedAmount` when the turn's writes were planned, for `afterWrites`. */
  private plannedFrom = 0;
  /**
   * `binary-io`: this turn's writes, in `order` and as `flushStream` would make them, at most `budget.bytes` and `budget.writes` in
   * all. Nothing is taken from the queues here: `consume` takes what the engine answers it took, and the rest goes next turn.
   */
  async plan(budget: { bytes: number; writes: number }): Promise<PlannedWrite[]> {
    if (this.disposed) return [];
    if (this.closeDeadline && now() >= this.closeDeadline) { this.dispose(); return []; }
    this.plannedFrom = this.bufferedAmount;
    const writes: PlannedWrite[] = [];
    for (const outgoing of this.order()) {
      while (outgoing.items.length && outgoing.items[0].offset >= outgoing.items[0].bytes.length) outgoing.items.shift();
      if (!outgoing.items.length || budget.bytes <= 0 || budget.writes <= 0) continue;
      if (outgoing.stream === null && !await this.open(outgoing)) continue;
      if (this.disposed) return [];
      // Given up while its stream opened.
      if (!outgoing.items.length) continue;
      let index = 0, offset = outgoing.items[0].offset;
      for (let turn = 0; turn < (outgoing.short ? 1 : WRITES_PER_STREAM) && index < outgoing.items.length && budget.bytes > 0 && budget.writes > 0; turn++) {
        const item = outgoing.items[index];
        const bytes = item.bytes.subarray(offset, offset + Math.min(WRITE_CHUNK, budget.bytes));
        if (bytes.length) { writes.push({ channel: this, outgoing, bytes }); budget.bytes -= bytes.length; budget.writes -= 1; }
        offset += bytes.length;
        if (offset >= item.bytes.length) { index++; offset = 0; }
      }
    }
    return writes;
  }
  /** `binary-io`: the engine took `written` of a planned write of `planned` bytes (-1: the connection is gone). */
  consume(outgoing: Outgoing, written: number, planned: number): void {
    if (this.disposed) return;
    if (!Number.isInteger(written) || written < 0 || written > planned) { this.close({ drain: false }); return; }
    outgoing.short = written < planned;
    for (let left = written; outgoing.items.length;) {
      const item = outgoing.items[0], taken = Math.min(left, item.bytes.length - item.offset);
      item.offset += taken; left -= taken; outgoing.queued -= taken;
      if (outgoing.reserved) this.owner.release(taken);
      if (item.offset < item.bytes.length) break;
      outgoing.items.shift();
    }
  }
  /** `binary-io`: after the turn's `io` call, what `flush` does once its writes are done. */
  async afterWrites(): Promise<void> {
    if (this.closeDeadline && now() >= this.closeDeadline) { this.dispose(); return; }
    await this.drained(this.plannedFrom);
  }
  /**
   * Opens `outgoing`'s stream in the engine. A body the engine has no stream for yet (`STREAM_LIMIT`: earlier ones are not all
   * acknowledged) waits for the next turn; for the channel's own streams it is an error, as before.
   */
  private async open(outgoing: Outgoing): Promise<boolean> {
    if (!(outgoing instanceof Body)) {
      outgoing.stream = await this.owner.call<number>({ op: 'openStream', id: this.id, priority: outgoing.priority });
      return true;
    }
    try { outgoing.stream = await this.owner.call<number>({ op: 'openStream', id: this.id, priority: outgoing.priority }); }
    catch (error) { if ((error as Error)?.message === 'STREAM_LIMIT') return false; throw error; }
    return true;
  }
  private async flushStream(outgoing: Outgoing): Promise<void> {
    if (!outgoing.items.length) return;
    if (outgoing.stream === null && !await this.open(outgoing)) return;
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
    if (!this.events.closed && state.path) {
      const tag = 'link' in state.path ? 'relay' : `${state.path.address}:${state.path.port}`;
      if (tag !== this.reportedPath) {
        this.reportedPath = tag;
        const current = this.path();
        for (const handler of this.pathHandlers) handler(current);
      }
    }
    const core = Array.isArray(state.buffered) ? new Map(state.buffered.map(([stream, bytes]) => [stream, bytes])) : null;
    for (const outgoing of [this.data, this.control, ...(this.lanes ? Object.values(this.lanes) : []), ...this.bodies]) {
      outgoing.core = outgoing.stream === null || !core ? 0 : core.get(outgoing.stream) ?? 0;
    }
    // An ended body leaves once the core holds none of it (builds without `stream-buffered`: at once).
    if (this.bodies.some(body => body.ended && body.core === 0)) this.bodies = this.bodies.filter(body => !body.ended || body.core > 0);
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
      let data = chunk.data;
      if (stream.kind === null && data.length) { stream.kind = data[0]; data = data.subarray(1); }
      if (stream.kind === DATA) { if (data.length) this.events.data(data); continue; }
      if (stream.kind === SESSION_BODY_KIND && this.owner.enhanced) {
        // Only after this side declared v2: before that it is a stream kind this node does not take, as on older nodes.
        if (!this.bodiesDeclared) { this.close({ drain: false }); return; }
        // Its key (4 bytes, big-endian) follows the kind; it may arrive over several chunks.
        stream.head ??= [];
        while (stream.key == null && data.length) {
          stream.head.push(data[0]); data = data.subarray(1);
          if (stream.head.length === 4) stream.key = new DataView(Uint8Array.from(stream.head).buffer).getUint32(0, false);
        }
        if (stream.key != null && data.length) this.sessionBody(stream.key, data);
        if (this.disposed) return;
        continue;
      }
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
      const stream = this.streams.get(event.stream);
      if (stream?.kind === DATA) { this.close(); return; }
      this.streams.delete(event.stream);
      if (stream?.kind === SESSION_BODY_KIND && stream.key != null && this.owner.enhanced) { this.sessionBody(stream.key, null); if (this.disposed) return; }
    }
    for (const [address, rttUs] of state.probeRtts ?? []) {
      if (this.router && address && typeof rttUs === 'number') this.router.onProbeRtt(address, 'link' in address, rttUs);
    }
    if (!this.router && !this.events.closed && now() >= this.nextProbe && this.candidates.length) {
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
    let value: { candidates?: unknown; session?: unknown; pathPreference?: unknown; autoRelay?: unknown };
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
        && Number.isInteger(a.port) && a.port > 0 && a.port <= 65535 && (!this.owner.publicOnly || !isPrivate(a.address)));
      if (this.owner.enhanced) candidates.sort((a: Address, b: Address) => Number(isPrivate(a.address)) - Number(isPrivate(b.address)));
      this.candidates = candidates.slice(0, MAX_CANDIDATES);
      this.candidateCursor = 0; this.nextProbe = 0;
      this.router?.setCandidates(this.candidates);
    }
    if (value) this.router?.onPeerPreference(value);
  }
  /** Both paths' round trips as last measured and this side's preference (types.ts `PeerPathMetrics`). */
  pathMetrics(): PeerPathMetrics {
    if (this.router) return this.router.pathMetrics();
    const path = this.path(), rtt = (this.state?.rttUs ?? 0) > 0 ? this.state!.rttUs / 1000 : null;
    return { directRttMs: path === 'direct' ? rtt : null, relayRttMs: path === 'relay' ? rtt : null, preference: 'auto' };
  }
  /** Prefer the direct or the relay path, or choose by round trip (`auto`); the peer is told and follows. */
  setPathPreference(preference: PathPreference): void { this.router?.setPathPreference(preference); }
  onData(handler: (bytes: Uint8Array) => void): void { this.events.onData(handler); }
  onClose(handler: () => void): void { this.events.onClose(handler); }
  path(): 'direct' | 'relay' | null { return this.events.closed || !this.state?.path ? null : 'link' in this.state.path ? 'relay' : 'direct'; }
  directAddress(): Address | null { return this.events.closed || !this.state?.path || 'link' in this.state.path ? null : this.state.path; }
  onPathChange(handler: (path: 'direct' | 'relay' | null) => void): void { this.pathHandlers.push(handler); }
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
    this.router?.stop();
    for (const item of this.data.items) this.owner.release(item.bytes.length - item.offset);
    for (const outgoing of [this.data, this.control, ...(this.lanes ? Object.values(this.lanes) : []), ...this.bodies]) { outgoing.items = []; outgoing.queued = 0; }
    this.bodies = [];
    this.streams.clear(); this.earlySession = []; this.earlyBodies = []; this.events.close(); this.owner.detach(this.id);
  }
}

/** Private addresses: LAN, carrier NAT, link-local (as transport.ts). */
function isPrivate(address: string): boolean {
  if (address.includes(':')) return /^(fe80:|fc|fd)/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
}
