import type { KeyObject } from 'node:crypto';
import type { AgentNetUplink } from '@cindy/agent-net-relay/client';
export type PathPreference = 'auto' | 'direct' | 'relay';

export interface PeerPathMetrics {
  directRttMs: number | null;
  relayRttMs: number | null;
  preference: PathPreference;
}

export interface RosterEntry { id: string; dial: unknown; }
export interface PeerChannel {
  readonly remoteId: string;
  /** Bytes waiting for admission to the bounded core send buffer. */
  readonly bufferedAmount?: number;
  send(bytes: Uint8Array): void;
  onData(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  /** `bufferedAmount` went down because the core took queued bytes. Optional: channels without it never call back. */
  onDrain?(handler: () => void): void;
  close(options?: { drain?: boolean }): void;
  /**
   * Agent-Net session lanes on this connection (docs/agent-net-session-plan.md §10.1), or null while the peer has not
   * declared support. Optional: channels without it never carry sessions and stay on Device Link frames.
   */
  sessionWire?(): SessionWire | null;
  /** Declare that this node reads sessions on this connection, with optional features (see CoreChannel.declareSessions). */
  declareSessions?(features?: readonly string[]): void;
  /** The peer declared session support; `sessionWire()` is available from now on. Fires at most once. */
  onSessionCapable?(handler: () => void): void;
  /** Features the peer declared along with session support. */
  sessionFeatures?(): readonly string[];
  /**
   * The channel carries `agent-net-session-v2` body streams (`SessionWire.openBody` / `onBody`): this node declares
   * `AGENT_NET_SESSION_V2` and reads the peer's body streams.
   */
  readonly sessionBodies?: boolean;
  path?(): 'direct' | 'relay' | null;
  /** Live RTT of both direct and relay paths (when measured) plus the local path preference. */
  pathMetrics?(): PeerPathMetrics;
  /** Change the local path preference (`auto` / `direct` / `relay`) and sync it with the peer on the control stream. */
  setPathPreference?(preference: PathPreference): void;
  /** The peer's authenticated direct UDP address while `path()` is `'direct'`, so a fast foreground resume can dial it first. */
  directAddress?(): { address: string; port: number } | null;
  /** Fires when `path()` or `directAddress()` changes after the channel was adopted (for instance after hole punching). */
  onPathChange?(handler: (path: 'direct' | 'relay' | null) => void): void;
  stats?(): Record<string, number> | null;
  addressKind?(): 'relay' | 'loopback' | 'private' | 'public' | null;
}
export const MAX_CHANNEL_PENDING_BYTES = 8 * 1024 * 1024;

/** Declared on a connection's control stream by a node whose upper layer reads sessions (see `PeerChannel.declareSessions`). */
export const AGENT_NET_SESSION_V1 = 'agent-net-session-v1';
/**
 * First byte of each session lane stream (session/lanes.ts) and the core priority it runs at. Opened only after the peer
 * declared support: older nodes close the connection on a stream type they do not know. The same on every driver.
 */
export const SESSION_LANE_KINDS = { control: 0x30, normal: 0x31, background: 0x32 } as const;
export const SESSION_LANE_PRIORITY = { control: 'interactive', normal: 'normal', background: 'background' } as const;
export type SessionLaneName = keyof typeof SESSION_LANE_KINDS;
/** Session bytes that may arrive before this side attached its session; beyond it the connection is closed. */
export const MAX_EARLY_SESSION_BYTES = 16 * 1024 * 1024;
/**
 * Declared along with session support by a node that reads body streams (docs/dev-rules/protocol-compatibility/agent-net-session.md
 * 「会话 v2」). Only once the peer declared it does this node open one: older nodes close the connection on a stream type they do not know.
 */
export const AGENT_NET_SESSION_V2 = 'agent-net-session-v2';
/**
 * First byte of a body stream, then the body's key (4 bytes, big-endian), then the message body; the stream ends after it.
 * The core priority is the one of the lane the message's placeholder went on.
 */
export const SESSION_BODY_KIND = 0x33;
export const SESSION_BODY_HEADER_BYTES = 5;
/** What each body event that arrives before the session attached costs in MAX_EARLY_SESSION_BYTES, besides its bytes (an end has none). */
export const EARLY_BODY_EVENT_BYTES = 64;
/** One message body on a stream of its own (session v2, `SessionWire.openBody`). */
export interface SessionBodyWriter {
  write(bytes: Uint8Array): void;
  /** The body is complete: the stream ends after what was written. */
  finish(): void;
  /** Give the body up (its caller cancelled): what the core has not sent goes no further, the stream ends now. */
  abandon(): void;
}

/** The session's three core streams on one connection, independent of the Device Link frame stream. */
export interface SessionWire {
  write(lane: 'control' | 'normal' | 'background', bytes: Uint8Array): void;
  /** Bytes the session wrote that the core has not taken yet, all lanes together. */
  readonly bufferedAmount: number;
  /** Each chunk is handed over to the session, which may keep it until its frame is complete: the wire must not reuse it. */
  onData(handler: (lane: 'control' | 'normal' | 'background', bytes: Uint8Array) => void): void;
  /**
   * Session v2: a stream of its own for one message body, at the core priority of `lane`, starting with `SESSION_BODY_KIND`
   * and `key`. Null when the connection cannot open one (stream limit): the message then goes on its lane as in v1.
   * Only after the peer declared `AGENT_NET_SESSION_V2`.
   */
  openBody?(lane: 'control' | 'normal' | 'background', key: number): SessionBodyWriter | null;
  /** Bytes of a body stream the peer opened (after its kind and key), then `null` once that stream ended. Same rule as `onData`. */
  onBody?(handler: (key: number, bytes: Uint8Array | null) => void): void;
  /** Optional: fires when the underlying channel backlog drains (`PeerChannel.onDrain`). */
  onDrain?(handler: () => void): void;
}
/**
 * `onDrain` fires when the socket backlog falls back to this or below. Same as Device Link's socket low watermark
 * (`SOCKET_DATA_LOW_WATER_BYTES` in packages/device-link/src/client.ts): at or below it, any frame may be written.
 */
export const DRAIN_LOW_WATER_BYTES = 128 * 1024;
/**
 * How datagrams relayed for this computer travel right now: over the relay's UDP port (relayUdp.ts) or its WebSocket,
 * and the last round trip on that path in ms (null until measured). The remote connection page shows both on the relay.
 */
export interface RelayRoute {
  via: 'udp' | 'websocket';
  rttMs: number | null;
  /** On the WebSocket because the relay UDP carried registrations but no data (relayUdp.ts); retried after `cooldownMs`. */
  udpSuspension?: { reason: 'data-silence' | 'request-timeouts' | 'unacked-sends' | 'probe-failed'; cooldownMs: number };
}
/**
 * NAT mapping behavior inferred from STUN answers observed on the same local UDP socket:
 * - `cone`: multiple STUN servers agree on the same external IP and port (EIM / hole-punch friendly).
 * - `symmetric`: same external IP but different external ports per STUN server (EDM / symmetric NAT or proxy).
 * - `multi-egress`: different external IPs across STUN servers (split-tunnel VPN or multi-homed egress).
 * - `single-server`: only one STUN response observed so far; cannot yet distinguish cone vs symmetric.
 * - `unknown`: no STUN response yet.
 */
export type NatMappingKind = 'unknown' | 'single-server' | 'cone' | 'symmetric' | 'multi-egress';
export type PortMapProtocol = 'nat-pmp' | 'upnp';
export interface PortMappingEntry {
  address: string;
  port: number;
  lifetimeSec: number;
  protocol: PortMapProtocol;
}
/** Portable lifecycle controller injected by Node callers (`portMap.ts`) so `nativeTransport.ts` remains RN-compatible. */
export interface PortMapController {
  refresh(internalPort: number): void;
  current(): PortMappingEntry | null;
  close(): Promise<void>;
}
/** Non-sensitive connectivity diagnostics summary (contains only enums and counts — never raw IPs, ports, or keys). */
export interface TransportDiagnostics {
  natMapping: NatMappingKind;
  portPreserving: boolean | null;
  stunResponses: number;
  portMapped: PortMapProtocol | null;
  localCandidates: number;
  publicCandidates: number;
}
/**
 * Classifies NAT mapping behavior from STUN responses observed on a single local UDP socket.
 * Multiple identical IP:port answers indicate Endpoint-Independent Mapping (`cone`); same IP with
 * distinct external ports indicates Symmetric NAT / EDM (`symmetric`); distinct external IPs indicate
 * multi-egress split routing (`multi-egress`, e.g., VPN routing one STUN region differently).
 */
export function classifyNatMapping(
  observations: readonly { address: string; port: number }[],
  localPort?: number | null,
): { natMapping: NatMappingKind; portPreserving: boolean | null } {
  if (!observations.length) return { natMapping: 'unknown', portPreserving: null };
  const ips = new Set(observations.map((entry) => entry.address));
  const ports = new Set(observations.map((entry) => entry.port));
  const portPreserving = typeof localPort === 'number' && localPort > 0
    ? observations.every((entry) => entry.port === localPort)
    : null;
  if (observations.length === 1) return { natMapping: 'single-server', portPreserving };
  if (ips.size > 1) return { natMapping: 'multi-egress', portPreserving };
  if (ports.size > 1) return { natMapping: 'symmetric', portPreserving: false };
  return { natMapping: 'cone', portPreserving };
}
/** Formats non-sensitive diagnostics for `onLog` (strictly enums and counts; never IPs, ports, or keys). */
export function formatTransportDiagnosticsLog(diagnostics: TransportDiagnostics): string {
  return `agent-net nat=${diagnostics.natMapping}`
    + ` portPreserving=${diagnostics.portPreserving === null ? 'unknown' : String(diagnostics.portPreserving)}`
    + ` stun=${diagnostics.stunResponses}`
    + ` portMap=${diagnostics.portMapped ?? 'none'}`
    + ` candidates=public:${diagnostics.publicCandidates},local:${diagnostics.localCandidates}`;
}
export interface Transport {
  readonly id: string;
  readonly dial: unknown;
  connect(entry: RosterEntry): Promise<PeerChannel>;
  close(): Promise<void>;
  /** This computer changed networks: connections send from the new address now (the peer follows) and candidates are gathered again. */
  networkChanged?(): void;
  /** Updates the STUN server list (e.g. when a peer official region's STUN resolves asynchronously) and queries any newly added servers. */
  setStunServers?(servers: readonly string[]): void;
  /** Session requests to a relayed peer timed out; relay UDP may carry registrations but no data (relayUdp.ts noteStall). */
  relayStalled?(): void;
  /** The roster or the peer rule changed: a transport that mirrors the admitted peers elsewhere (the phone's engine) does it now. */
  admissionChanged?(): void;
  /**
   * See RelayRoute; null without a relay. Only the UDP round trip is known here (`rttMs` is null for the WebSocket):
   * the WebSocket itself is opened and pinged by the host (workerSocket.ts).
   */
  relayRoute?(): RelayRoute | null;
  /** Current non-sensitive NAT/candidate diagnostics summary for troubleshooting direct-connect failures. */
  diagnostics?(): TransportDiagnostics;
}
export interface TransportOptions {
  admit(remoteId: string): boolean;
  onIncoming(channel: PeerChannel): void;
  relay?: { uplink: Pick<AgentNetUplink, 'kind' | 'send' | 'onDatagram' | 'close'>; deviceId: string;
    /** The current relay session's UDP credentials; changes when the relay WebSocket reconnects. */
    udpCredentials?(): { session: Uint8Array; key: Uint8Array; probe?: boolean } | null };
  /** The relay's UDP address (`host:port`, the same port as its STUN). With credentials, relayed datagrams use UDP. */
  relayUdpServer?: string;
  relayIdOf?(remoteId: string): string | undefined;
  /** Root-verified, currently authorized keys; native hosts mirror these before polling IO. */
  admittedPeers?(): { id: string; relayId: string }[];
  /** Invalidates remembered handshake refusals when a verified roster/grant changes. */
  admissionVersion?(): number;
  udp?: boolean;
  reprobeMs?: number;
  bindAddress?: string;
  /** Optional fixed local UDP listening port (`1..65535`). Falls back to ephemeral port `0` if busy (`EADDRINUSE` / `EACCES`) or unset. */
  bindPort?: number;
  stunServers?: string[];
  publicCandidatesOnly?: boolean;
  identity?: KeyObject;
  module?: WebAssembly.Module;
  tap?(datagram: Uint8Array, via: 'udp' | 'relay'): void;
  udpTraffic?: BigUint64Array;
  /**
   * The native engine's transport (Desktop): turn a `host:port` for STUN or relay UDP into the address to use, before the
   * engine resolves it itself. The Desktop avoids proxies' Fake-IP answers this way (stun.ts `resolveUdpHost`), as the WASM
   * transport does on its own; the phones pass none and the engine resolves names as before.
   */
  resolveUdpServer?(server: string): Promise<string>;
  /** Optional plain-text transport lifecycle/fallback logger (no addresses, keys or payloads). */
  onLog?(level: 'info' | 'warn', message: string): void;
  /**
   * Best-effort NAT-PMP / UPnP router port mapping for the local UDP socket (defaults to enabled on Node when UDP is on
   * and `publicCandidatesOnly` is not forced). Set `false` in tests or restricted environments.
   */
  portMapping?: boolean;
  /** Optional custom port-mapping controller factory (used by `socket.ts` for NativeTransport and unit tests). */
  createPortMap?(onMapped: (mapping: PortMappingEntry | null) => void): PortMapController;
}
/** Early stream events are bounded by the core's receive credit; do not lose them during admission. */
export class ChannelEvents {
  private dataHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private readonly early: Uint8Array[] = [];
  private closedEarly = false;
  closed = false;
  onData(handler: (bytes: Uint8Array) => void): void {
    this.dataHandler = handler;
    for (const bytes of this.early.splice(0)) handler(bytes);
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closedEarly) handler();
  }
  data(bytes: Uint8Array): void {
    if (this.dataHandler) this.dataHandler(bytes);
    else this.early.push(bytes);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeHandler) this.closeHandler();
    else this.closedEarly = true;
  }
}
