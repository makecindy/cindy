/**
 * Frame-level byte meter for one Device Link WebSocket.
 *
 * It wraps the real `ws` socket handed to `DeviceLinkClient` (the same object the
 * production client writes to), so every counted frame is exactly what the client
 * put on, or read from, the wire. Reliable-transport segments are reassembled only to
 * attribute bytes to a logical message and channel; the client does its own parsing.
 *
 * Definitions (all UTF-8 bytes):
 *  - wireBytes:    WebSocket frame bytes = frame header + payload as sent. No
 *                  permessage-deflate is negotiated today (`extensions` proves it),
 *                  so the payload is the JSON text frame itself.
 *  - decodedBytes: the logical message after transport reassembly and after the
 *                  Device Link result gzip (`transfer.gzipBase64`, or the list delta
 *                  patch's `transfer.delta.gzipBase64`) and push compression are
 *                  inflated — what the receiving app has to parse and hold. Envelope/transport
 *                  wrappers are excluded; control frames count their whole text.
 *  - frames:       WebSocket text frames. messages: logical messages (one per
 *                  reassembled reliable message, one per non-reliable frame).
 */
import { gunzipSync, inflateRawSync } from 'node:zlib';
import type WebSocket from 'ws';
import * as deviceLink from '@cindy/device-link';
import {
  DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
  MAKER_EVENT_BATCH_CHANNEL,
  MESSAGE_BODY_FORMAT,
  byteLength,
  mapMessageBodies,
  parseTransportPayload,
  type Envelope,
} from '@cindy/device-link';

export type Side = 'controller' | 'host';
export type Direction = 'controller_to_host' | 'host_to_controller';

export interface TrafficCounts {
  wireBytes: number;
  decodedBytes: number;
  frames: number;
  messages: number;
  /** Duplicate reliable frames, including segments repeated before reassembly finishes. */
  retransmitFrames: number;
  /** Results that used the Device Link gzip encoding (whole result or list delta patch) / the notModified short-circuit. */
  gzipMessages: number;
  notModifiedMessages: number;
  /** maker:event entries carried (single events + events inside batches). */
  makerEvents: number;
  /** Pushes carried as `transfer.deflateBase64` (push-deflate-v1) that the meter inflated. */
  deflatedMessages: number;
  /** Encoded pushes / delta patches the meter could not decode; their decoded size is unknown and not counted. */
  decodedUnknownMessages: number;
}

/**
 * What a channel's decoded bytes are made of:
 *  - `event:<type>`: each maker:event (single or inside a batch);
 *  - `row:<role>`: messages pushed in `local-db:messages:created` or returned by
 *    `local-db:messages:work-details`;
 *  - `body:sent` / `body:reused`: reusable text bodies in a `messages:view` / `messages:list`
 *    result that came with their content vs. as a reference to a body the controller knew;
 *  - `session:<id>`: history reads (`view`, `work-details`, `view-intent`) by target task,
 *    with `wireBytes` (requests and results alike).
 * Bytes are the JSON of that one event / message (or the whole read for `session:`).
 */
export type ContentBreakdown = Record<string, { count: number; bytes: number; wireBytes?: number }>;

const SESSION_SCOPED_READS = new Set(['local-db:messages:view', 'local-db:messages:work-details', 'local-db:messages:view-intent']);

export interface TrafficRow extends TrafficCounts {
  breakdown: ContentBreakdown;
  stage: string;
  side: Side;
  direction: Direction;
  /** `invoke`, `result`, `push`, `link`, `transport-ack` or `control`. */
  kind: string;
  channel: string;
}

export interface SocketTotals {
  stage: string;
  side: Side;
  /** Raw TCP bytes (includes HTTP upgrade and WebSocket framing). */
  tcpBytesWritten: number;
  tcpBytesRead: number;
  sockets: number;
  extensions: string[];
}

function emptyCounts(): TrafficCounts {
  return {
    wireBytes: 0, decodedBytes: 0, frames: 0, messages: 0, retransmitFrames: 0,
    gzipMessages: 0, notModifiedMessages: 0, makerEvents: 0, deflatedMessages: 0, decodedUnknownMessages: 0,
  };
}

/**
 * push-deflate (the push-compression task's change): `payload: null` plus
 * `transfer.deflateBase64`, raw DEFLATE primed with a preset dictionary chosen by
 * `transfer.dict` (omitted for id 1). Dictionaries come from @cindy/device-link
 * (`PUSH_TRANSFER_DICTIONARIES`, or the single `PUSH_TRANSFER_DICTIONARY_V1` of the first
 * version) and only exist where that change is merged. An unknown id, a missing dictionary or
 * a failed inflate makes the push undecodable; its decoded size is then reported as unknown.
 */
type PushDictionaries = ReadonlyArray<{ id: number; dictionary: string }>;

function exportedPushDictionaries(): PushDictionaries {
  const exported = deviceLink as Record<string, unknown>;
  const list = exported.PUSH_TRANSFER_DICTIONARIES;
  if (Array.isArray(list)) {
    return list.filter((entry): entry is { id: number; dictionary: string } =>
      !!entry && typeof entry.id === 'number' && typeof entry.dictionary === 'string');
  }
  return typeof exported.PUSH_TRANSFER_DICTIONARY_V1 === 'string' ? [{ id: 1, dictionary: exported.PUSH_TRANSFER_DICTIONARY_V1 }] : [];
}

export function decodeDeflatedPush(
  push: Record<string, unknown>,
  dictionaries: PushDictionaries = exportedPushDictionaries(),
): { ok: true; push: Record<string, unknown>; dict: number } | { ok: false; dict: unknown } | null {
  const transfer = push.transfer as { deflateBase64?: unknown; dict?: unknown } | undefined;
  if (push.payload !== null || typeof transfer?.deflateBase64 !== 'string') return null;
  const dict = transfer.dict === undefined ? 1 : transfer.dict;
  const dictionary = dictionaries.find((entry) => entry.id === dict)?.dictionary;
  if (dictionary === undefined) return { ok: false, dict };
  try {
    const text = inflateRawSync(Buffer.from(transfer.deflateBase64, 'base64'), { dictionary: Buffer.from(dictionary, 'latin1') }).toString('utf8');
    return { ok: true, dict: dict as number, push: { channel: push.channel, payload: JSON.parse(text), ...(push.ownerStamp ? { ownerStamp: push.ownerStamp } : {}) } };
  } catch {
    return { ok: false, dict };
  }
}

/** RFC 6455 §5.2: 2-byte base header, 16/64-bit extended length, 4-byte mask for client frames. */
export function webSocketFrameBytes(payloadBytes: number, masked: boolean): number {
  const extended = payloadBytes > 65_535 ? 8 : payloadBytes > 125 ? 2 : 0;
  return 2 + extended + (masked ? 4 : 0) + payloadBytes;
}

interface Partial {
  stage: string;
  kind: string;
  id?: string;
  wireBytes: number;
  frames: number;
  retransmitFrames: number;
  segments: string[];
  received: number;
  total: number;
}

interface TcpCounters { bytesWritten?: number; bytesRead?: number }

interface TapState {
  side: Side;
  sockets: Array<{ ws: WebSocket; tcp: () => TcpCounters | undefined }>;
  /** Per-direction reassembly buffers keyed by stream + seq. */
  partial: Map<string, Partial>;
  /** Completed reliable messages, for retransmission attribution. */
  completed: Map<string, { kind: string; channel: string }>;
  /** invoke request id → channel, shared by both directions. */
  requestChannels: Map<string, string>;
  /** invoke request id → target task of a session-scoped history read. */
  requestSessions: Map<string, string>;
  lastSnapshot: { written: number; read: number };
}

/**
 * The baseline run is bounded (hundreds of messages), so attribution maps are never evicted.
 * Request ids and reliable stream ids are both random UUIDs (packages/device-link/src/client.ts
 * createRequestId), so controllers sharing one side's maps cannot collide.
 */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
}

/** Capabilities a controller actually put on the wire (last seen; see switches.ts). */
export interface DeclaredCapabilities {
  hello?: string[];
  linkOpen?: string[];
  subscribe?: string[];
}

/** One logical message on the controller socket, kept only for stages named in TRANSFER_BASELINE_TRACE. */
export interface TraceEntry {
  stage: string;
  /** Milliseconds since the stage began. */
  t: number;
  direction: Direction;
  kind: string;
  channel: string;
  wireBytes: number;
  decodedBytes: number;
  notModified?: true;
  session?: string;
  /** First characters of the request id, to pair a request with its result. */
  id?: string;
}

const MAX_TRACE_ENTRIES = 20_000;

export class WireMeter {
  private stage = 'setup';
  private readonly stageStartedAt = new Map<string, number>([['setup', performance.now()]]);
  readonly declared: DeclaredCapabilities = {};
  readonly trace: TraceEntry[] = [];
  /** Stage names to trace; `*` traces all. Empty disables tracing. */
  constructor(private readonly traceStages: ReadonlySet<string> = new Set()) {}
  private readonly rows = new Map<string, TrafficRow>();
  private readonly taps = new Map<Side, TapState>();
  private readonly socketTotals: SocketTotals[] = [];
  private lastFrameAt = 0;

  setStage(stage: string): void {
    this.snapshotSockets();
    this.stage = stage;
    this.stageStartedAt.set(stage, performance.now());
  }

  private tracing(state: TapState, stage: string): boolean {
    return state.side === 'controller' && this.trace.length < MAX_TRACE_ENTRIES
      && (this.traceStages.has('*') || this.traceStages.has(stage));
  }

  private record(state: TapState, entry: Omit<TraceEntry, 'stage' | 't'>, stage: string): void {
    if (!this.tracing(state, stage)) return;
    // Time since the start of the stage the message belongs to (a segmented one may finish later).
    this.trace.push({ stage, t: Math.round(performance.now() - (this.stageStartedAt.get(stage) ?? performance.now())), ...entry });
  }

  private noteDeclared(state: TapState, direction: Direction, kind: string, envKind: string, logical: Record<string, unknown> | undefined): void {
    if (state.side !== 'controller' || direction !== 'controller_to_host' || !logical) return;
    const caps = (value: unknown) => (Array.isArray(value) ? value.filter((cap): cap is string => typeof cap === 'string') : undefined);
    if (envKind === 'hello') this.declared.hello = caps(logical.capabilities) ?? this.declared.hello;
    if (envKind === 'link-open') this.declared.linkOpen = caps(logical.capabilities) ?? this.declared.linkOpen;
    if (kind === 'invoke' && logical.channel === 'device-link:subscribe') {
      const first = (logical.args as unknown[] | undefined)?.[0] as { capabilities?: unknown } | undefined;
      this.declared.subscribe = caps(first?.capabilities) ?? this.declared.subscribe;
    }
  }

  get currentStage(): string {
    return this.stage;
  }

  /** Milliseconds since the last metered frame on any tapped socket. */
  idleMs(now = performance.now()): number {
    return now - this.lastFrameAt;
  }

  /** Wrap a socket created for the real client. Must run before the client attaches listeners. */
  tap(ws: WebSocket, side: Side): WebSocket {
    let state = this.taps.get(side);
    if (!state) {
      state = { side, sockets: [], partial: new Map(), completed: new Map(), requestChannels: new Map(), requestSessions: new Map(), lastSnapshot: { written: 0, read: 0 } };
      this.taps.set(side, state);
    }
    const tapState = state;
    // Keep the net.Socket itself: ws drops its reference on close, the counters stay final.
    let tcp: TcpCounters | undefined;
    const capture = () => { tcp ??= (ws as unknown as { _socket?: TcpCounters })._socket ?? undefined; };
    ws.on('upgrade', capture);
    ws.on('open', capture);
    tapState.sockets.push({ ws, tcp: () => { capture(); return tcp; } });
    const outbound: Direction = side === 'controller' ? 'controller_to_host' : 'host_to_controller';
    const inbound: Direction = side === 'controller' ? 'host_to_controller' : 'controller_to_host';
    const send = ws.send.bind(ws) as (data: unknown, ...rest: unknown[]) => void;
    (ws as unknown as { send: (...args: unknown[]) => void }).send = (data: unknown, ...rest: unknown[]) => {
      if (typeof data === 'string') this.observe(tapState, outbound, data, true);
      send(data, ...rest);
    };
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      this.observe(tapState, inbound, data.toString(), false);
    });
    return ws;
  }

  private bucket(side: Side, direction: Direction, kind: string, channel: string, stage = this.stage): TrafficRow {
    const key = `${stage}\u0000${side}\u0000${direction}\u0000${kind}\u0000${channel}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { stage, side, direction, kind, channel, ...emptyCounts(), breakdown: {} };
      this.rows.set(key, row);
    }
    return row;
  }

  private observe(state: TapState, direction: Direction, text: string, masked: boolean): void {
    this.lastFrameAt = performance.now();
    const payloadBytes = byteLength(text);
    const wireBytes = webSocketFrameBytes(payloadBytes, masked);
    let env: Envelope;
    try {
      env = JSON.parse(text) as Envelope;
    } catch {
      const row = this.bucket(state.side, direction, 'control', 'unparsed');
      row.wireBytes += wireBytes; row.decodedBytes += payloadBytes; row.frames++; row.messages++;
      return;
    }
    const kind = env.kind === 'invoke' ? 'invoke' : env.kind === 'invoke-result' ? 'result'
      : env.kind === 'push' ? 'push'
        : env.kind === 'link-open' || env.kind === 'link-accept' || env.kind === 'link-close' ? 'link' : 'control';
    const transport = kind === 'invoke' || kind === 'result' || kind === 'push' ? parseTransportPayload(env.payload) : null;
    if (!transport) {
      // Non-reliable frame: control traffic, link handshake, transport ACKs or a legacy payload.
      const payload = env.payload as { channel?: unknown } | undefined;
      const ack = kind === 'push' && payload?.channel === DEVICE_LINK_TRANSPORT_ACK_CHANNEL;
      const channel = ack ? 'ack' : kind === 'control' || kind === 'link' ? env.kind : this.channelOf(state, kind, env, payload);
      const row = this.bucket(state.side, direction, ack ? 'transport-ack' : kind, channel);
      row.wireBytes += wireBytes; row.frames++; row.messages++;
      // push-deflate is only sent over the reliable transport; decode here too in case it is not.
      const deflated = kind === 'push' && !ack ? decodeDeflatedPush(payload as Record<string, unknown>) : null;
      if (deflated?.ok) { row.deflatedMessages++; row.decodedBytes += byteLength(JSON.stringify(deflated.push)); }
      else if (deflated) row.decodedUnknownMessages++;
      else row.decodedBytes += payloadBytes;
      if (kind === 'push' && !ack) this.countPush(row, (deflated?.ok ? deflated.push : payload) as { channel?: unknown; payload?: unknown });
      this.noteDeclared(state, direction, kind, env.kind, env.payload as Record<string, unknown> | undefined);
      this.record(state, { direction, kind: ack ? 'transport-ack' : kind, channel, wireBytes, decodedBytes: payloadBytes }, this.stage);
      return;
    }
    const { meta, data } = transport;
    const key = `${direction}\u0000${meta.streamId}\u0000${meta.seq}`;
    const done = state.completed.get(key);
    if (done) {
      const row = this.bucket(state.side, direction, done.kind, done.channel);
      row.wireBytes += wireBytes; row.frames++; row.retransmitFrames++;
      return;
    }
    const total = meta.segment?.total ?? 1;
    let partial = state.partial.get(key);
    if (!partial) {
      partial = { stage: this.stage, kind, id: env.id, wireBytes: 0, frames: 0, retransmitFrames: 0, segments: new Array(total), received: 0, total };
      state.partial.set(key, partial);
    }
    const index = meta.segment?.index ?? 0;
    partial.wireBytes += wireBytes;
    partial.frames++;
    if (partial.segments[index] === undefined) {
      partial.segments[index] = data;
      partial.received++;
    } else {
      // Keep all counters together until the logical channel is known.
      partial.retransmitFrames++;
    }
    if (partial.received < partial.total) return;
    state.partial.delete(key);
    const json = partial.segments.join('');
    let logical: Record<string, unknown> = {};
    try { logical = JSON.parse(json) as Record<string, unknown>; } catch { /* counted as unparsed below */ }
    const channel = this.channelOf(state, kind, env, logical);
    remember(state.completed, key, { kind, channel });
    const row = this.bucket(state.side, direction, kind, channel, partial.stage);
    row.wireBytes += partial.wireBytes;
    row.frames += partial.frames;
    row.retransmitFrames += partial.retransmitFrames;
    row.messages++;
    const bodyReads = channel === 'local-db:messages:view' || channel === 'local-db:messages:list';
    const decoded = this.decode(row, kind, json, logical, channel === 'local-db:messages:work-details' || bodyReads);
    const deflated = kind === 'push' ? decodeDeflatedPush(logical) : null;
    if (deflated?.ok) {
      row.deflatedMessages++;
      decoded.bytes = byteLength(JSON.stringify(deflated.push));
      this.addBytes(row, `deflate:dict${deflated.dict}`, decoded.bytes, partial.wireBytes);
    } else if (deflated) {
      row.decodedUnknownMessages++;
      decoded.bytes = 0;
      this.addBytes(row, `deflate:unknown:${String(deflated.dict)}`, 0, partial.wireBytes);
    }
    row.decodedBytes += decoded.bytes;
    if (kind === 'push') this.countPush(row, (deflated?.ok ? deflated.push : logical) as { channel?: unknown; payload?: unknown });
    if (kind === 'result' && channel === 'local-db:messages:work-details' && decoded.result) {
      const messages = (decoded.result as { messages?: unknown }).messages;
      if (Array.isArray(messages)) for (const message of messages) this.addBreakdown(row, `row:${(message as { role?: unknown }).role}`, message);
    }
    if (kind === 'result' && bodyReads) this.countBodies(row, decoded.result);
    if (SESSION_SCOPED_READS.has(channel)) {
      let sessionId: string | undefined;
      if (kind === 'invoke') {
        const target = (logical.args as unknown[] | undefined)?.[0];
        if (typeof target === 'string') {
          sessionId = target;
          if (env.id) remember(state.requestSessions, env.id, target);
        }
      } else if (kind === 'result' && env.id) sessionId = state.requestSessions.get(env.id);
      if (sessionId) this.addBytes(row, `session:${sessionId}`, decoded.bytes, partial.wireBytes);
    }
    this.noteDeclared(state, direction, kind, env.kind, logical);
    if (!this.tracing(state, partial.stage)) return;
    const notModified = kind === 'result' && (logical.transfer as { notModified?: unknown } | undefined)?.notModified === true;
    const traceSession = SESSION_SCOPED_READS.has(channel)
      ? (kind === 'invoke' ? (logical.args as unknown[] | undefined)?.[0] : env.id ? state.requestSessions.get(env.id) : undefined)
      : undefined;
    this.record(state, {
      direction, kind, channel, wireBytes: partial.wireBytes, decodedBytes: decoded.bytes,
      ...(notModified ? { notModified: true as const } : {}),
      ...(typeof traceSession === 'string' ? { session: traceSession } : {}),
      ...(env.id ? { id: env.id.slice(0, 8) } : {}),
    }, partial.stage);
  }

  private channelOf(state: TapState, kind: string, env: Envelope, logical: { channel?: unknown } | undefined): string {
    if (kind === 'invoke') {
      const channel = typeof logical?.channel === 'string' ? logical.channel : 'unknown';
      if (env.id) remember(state.requestChannels, env.id, channel);
      return channel;
    }
    if (kind === 'result') return (env.id && state.requestChannels.get(env.id)) || 'unknown';
    if (kind === 'push') return typeof logical?.channel === 'string' ? logical.channel : 'unknown';
    return env.kind;
  }

  /** Decoded size of one logical message, plus the inflated invoke result when it is one. */
  private decode(row: TrafficRow, kind: string, json: string, logical: Record<string, unknown>, wantResult: boolean): { bytes: number; result?: unknown } {
    const bytes = byteLength(json);
    if (kind !== 'result') return { bytes };
    const transfer = logical.transfer as { gzipBase64?: unknown; notModified?: unknown; delta?: { gzipBase64?: unknown } } | undefined;
    if (transfer?.notModified === true) row.notModifiedMessages++;
    // A list delta (invokeDelta.ts) whose patch is gzipped: count it like a gzipped result. An
    // undecodable patch is reported as unknown rather than counted at its compressed size.
    const patch = transfer?.delta?.gzipBase64;
    if (typeof patch === 'string') {
      let inflated: string;
      try {
        inflated = gunzipSync(Buffer.from(patch, 'base64')).toString('utf8');
      } catch {
        row.decodedUnknownMessages++;
        this.addBytes(row, 'delta:unknown', 0);
        return { bytes: 0 };
      }
      row.gzipMessages++;
      return { bytes: bytes - patch.length + byteLength(inflated) };
    }
    if (typeof transfer?.gzipBase64 !== 'string') return { bytes, result: logical.result };
    row.gzipMessages++;
    const inflated = gunzipSync(Buffer.from(transfer.gzipBase64, 'base64')).toString('utf8');
    let result: unknown;
    if (wantResult) {
      try { result = JSON.parse(inflated); } catch { /* size still counts */ }
    }
    return { bytes: bytes - transfer.gzipBase64.length + byteLength(inflated), result };
  }

  private addBreakdown(row: TrafficRow, key: string, value: unknown): void {
    this.addBytes(row, key, byteLength(JSON.stringify(value) ?? ''));
  }

  private addBytes(row: TrafficRow, key: string, bytes: number, wireBytes?: number): void {
    const entry = row.breakdown[key] ??= { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += bytes;
    if (wireBytes !== undefined) entry.wireBytes = (entry.wireBytes ?? 0) + wireBytes;
  }

  /** Reused vs. resent text bodies in a message-bodies-v1 result (apps/desktop/src/main/device-link/sessionMessageReuse.ts). */
  private countBodies(row: TrafficRow, result: unknown): void {
    const value = result as { format?: unknown; value?: unknown } | null;
    if (!value || value.format !== MESSAGE_BODY_FORMAT) return;
    mapMessageBodies(value.value, (message) => {
      if (typeof message.remoteBodyVersion === 'string') {
        this.addBreakdown(row, 'content' in message ? 'body:sent' : 'body:reused', message);
      }
      return message;
    });
  }

  private countPush(row: TrafficRow, push: { channel?: unknown; payload?: unknown } | undefined): void {
    const eventType = (value: unknown) => `event:${String((value as { event?: { type?: unknown } } | null)?.event?.type)}`;
    if (push?.channel === 'maker:event') {
      row.makerEvents++;
      this.addBreakdown(row, eventType(push.payload), push.payload);
    }
    if (push?.channel === MAKER_EVENT_BATCH_CHANNEL) {
      const events = (push.payload as { events?: unknown } | undefined)?.events;
      if (Array.isArray(events)) {
        row.makerEvents += events.length;
        for (const event of events) this.addBreakdown(row, eventType(event), event);
      }
    }
    if (push?.channel === 'local-db:messages:created') {
      const message = (push.payload as { message?: { role?: unknown } } | undefined)?.message;
      this.addBreakdown(row, `row:${String(message?.role)}`, message);
    }
  }

  private snapshotSockets(): void {
    for (const state of this.taps.values()) {
      let written = 0;
      let read = 0;
      const extensions = new Set<string>();
      for (const { ws, tcp } of state.sockets) {
        const socket = tcp();
        written += socket?.bytesWritten ?? 0;
        read += socket?.bytesRead ?? 0;
        if (socket) extensions.add(ws.extensions || 'none');
      }
      this.socketTotals.push({
        stage: this.stage,
        side: state.side,
        tcpBytesWritten: written - state.lastSnapshot.written,
        tcpBytesRead: read - state.lastSnapshot.read,
        sockets: state.sockets.length,
        extensions: [...extensions],
      });
      state.lastSnapshot = { written, read };
    }
  }

  /** Close the current stage and return everything recorded so far. */
  finish(): { rows: TrafficRow[]; sockets: SocketTotals[] } {
    this.snapshotSockets();
    return {
      rows: [...this.rows.values()],
      sockets: [...this.socketTotals],
    };
  }
}
