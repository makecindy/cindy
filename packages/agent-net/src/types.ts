import type { KeyObject } from 'node:crypto';
import type { AgentNetUplink } from '@cindy/agent-net-relay/client';
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
  udpSuspension?: { reason: 'data-silence' | 'request-timeouts' | 'unacked-sends'; cooldownMs: number };
}
export interface Transport {
  readonly id: string;
  readonly dial: unknown;
  connect(entry: RosterEntry): Promise<PeerChannel>;
  close(): Promise<void>;
  /** This computer changed networks: connections send from the new address now (the peer follows) and candidates are gathered again. */
  networkChanged?(): void;
  /** Session requests to a relayed peer timed out; relay UDP may carry registrations but no data (relayUdp.ts noteStall). */
  relayStalled?(): void;
  /** The roster or the peer rule changed: a transport that mirrors the admitted peers elsewhere (the phone's engine) does it now. */
  admissionChanged?(): void;
  /**
   * See RelayRoute; null without a relay. Only the UDP round trip is known here (`rttMs` is null for the WebSocket):
   * the WebSocket itself is opened and pinged by the host (workerSocket.ts).
   */
  relayRoute?(): RelayRoute | null;
}
export interface TransportOptions {
  admit(remoteId: string): boolean;
  onIncoming(channel: PeerChannel): void;
  relay?: { uplink: Pick<AgentNetUplink, 'kind' | 'send' | 'onDatagram' | 'close'>; deviceId: string;
    /** The current relay session's UDP credentials; changes when the relay WebSocket reconnects. */
    udpCredentials?(): { session: Uint8Array; key: Uint8Array } | null };
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
  stunServers?: string[];
  publicCandidatesOnly?: boolean;
  identity?: KeyObject;
  module?: WebAssembly.Module;
  tap?(datagram: Uint8Array, via: 'udp' | 'relay'): void;
  udpTraffic?: BigUint64Array;
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
