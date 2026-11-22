/**
 * Agent-Net session lanes (docs/agent-net-session-plan.md §10.1): three long-lived core streams per direction between two
 * peers — control/interactive, normal, background. The core delivers each stream in order and schedules streams by
 * priority, so an interactive request never waits behind a bulk result the way it does in Device Link's single queue.
 *
 * Splitting one queue into lanes loses the cross-lane order the business relies on, so the sender stamps two kinds of
 * messages and the receiver holds them until the stamped messages have been delivered:
 * - a result waits for every push sent before it (pushes feed the same views the result is read against, §5.2);
 * - an interactive request waits for the normal-lane requests sent before it (e.g. "set model" before "send"), but not
 *   for background requests (uploads, migration) — overtaking those is the point of the interactive lane;
 * - a request moved to the background lane only for its size (BULK_REQUEST_BYTES) keeps its place among requests: it waits
 *   for the normal-lane requests sent before it, and the normal and interactive requests sent after it wait for it, except
 *   those the caller marks `unordered` (idempotent reads). 2026-11-17 review: a large queued-message edit could run after
 *   the "send" that followed it;
 * - a message sent `afterEarlier` (a link close) waits for every push and request sent before it: on its own lane it overtook
 *   the last pushes, which the peer then dropped, and a subscribe sent just before it was handled after it.
 * Stamps only point at messages sent earlier, and every lane is first-in first-out in send order, so the earliest
 * undelivered message is never blocked: holding cannot deadlock.
 *
 * Delivery is serial per lane (the next message of a lane is handed over after the previous handler settled), like
 * Device Link's in-order delivery today, and counts only delivered messages. This module only frames and orders; it
 * knows nothing about Device Link or the meaning of the messages. Delivery and retransmission belong to the core.
 *
 * Session v2 (both ends declared `agent-net-session-v2`, `SessionLanesOptions.openBody`): a message of BODY_STREAM_BYTES or more
 * goes on a core stream of its own, and the lane carries a small placeholder in its place (`z`: the body's key and length).
 * The placeholder waits at its lane's head until the body is complete, so every message is handed over in exactly the order it
 * would have been on the lane: pushes still never overtake a result they were sent after, and the reverse. What changes is
 * transport: the receiver learns at once that a result is coming and follows its bytes (`onProgress`: a slow line no longer
 * times out a large result it is visibly receiving), and the sender can drop a result its caller gave up on (`abandonResult`).
 */

export const SESSION_LANES = ['control', 'normal', 'background'] as const;
export type SessionLane = typeof SESSION_LANES[number];
/** `push` and `request` are counted; `result` and interactive (control-lane) `request` wait on those counts. */
export type SessionMessageClass = 'control' | 'request' | 'result' | 'push';

/** Upper bound for one message on a lane; the core stream itself has no message size. */
export const MAX_SESSION_MESSAGE_BYTES = 16 * 1024 * 1024;
/**
 * A request this large is bulk data whatever its channel (an upload sent through a list channel, a migration chunk):
 * it moves to the background lane, so an interactive request sent after it does not wait for it. Results stay on
 * their lane — later pushes must not overtake a result they were sent after (§5.2).
 */
export const BULK_REQUEST_BYTES = 256 * 1024;
/** Bytes a receiver may hold while messages wait on other lanes; beyond it the session is broken and must be reopened. */
export const MAX_SESSION_HELD_BYTES = 64 * 1024 * 1024;
/** Session v2: a message encoded this large or larger goes on a body stream of its own (see the module comment). */
export const BODY_STREAM_BYTES = 64 * 1024;
/** Session v2: result bodies being written that `abandonResult` can still drop; the oldest are forgotten first. */
const MAX_ABANDONABLE_BODIES = 256;
/** Session v2: bodies the peer opened that have not been handed over; more is a broken session. */
const MAX_OPEN_BODIES = 1024;
/** Session v2: keys of bodies the peer gave up, remembered so their late bytes and placeholders are dropped; the oldest go first. */
const MAX_ABANDONED_KEYS = 1024;

const LANE_INDEX: Record<SessionLane, number> = { control: 0, normal: 1, background: 2 };
const encoder = new TextEncoder(), decoder = new TextDecoder();

/**
 * Wire record: the message plus what it waits for. `p`: pushes delivered per lane; `r`: normal-lane requests delivered;
 * `b`: size-moved requests delivered; `o`: this is a size-moved request. Session v2: `z` [key, length] instead of `m`, the
 * message is the body stream with that key; `i` on a result is its request id, for the receiver's progress.
 */
interface Frame { m?: unknown; c: SessionMessageClass; p?: [number, number, number]; r?: number; b?: number; o?: 1; z?: [number, number]; i?: string; x?: number }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFrame(value: unknown, lane: SessionLane): value is Frame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { m, c, p, r, b, o, z, i, x } = value as Record<string, unknown>;
  // Session v2: `x` alone on the control lane: the sender gave up the body with this key (see `abandonResult`).
  if (x !== undefined) return c === 'control' && lane === 'control' && m === undefined && z === undefined && isCount(x) && x > 0;
  return (c === 'control' || c === 'request' || c === 'result' || c === 'push')
    && (p === undefined || (Array.isArray(p) && p.length === SESSION_LANES.length && p.every(isCount)))
    && (r === undefined || isCount(r))
    && (b === undefined || isCount(b))
    && (o === undefined || (o === 1 && c === 'request' && lane === 'background'))
    && (z === undefined || (m === undefined && Array.isArray(z) && z.length === 2 && z.every(isCount) && (z[1] as number) <= MAX_SESSION_MESSAGE_BYTES))
    && (i === undefined || (z !== undefined && c === 'result' && typeof i === 'string' && i.length <= 256));
}
/** See the module comment. `id`: a result's request id (session v2 progress and `abandonResult`). */
export interface SessionSendOptions { unordered?: boolean; afterEarlier?: boolean; id?: string }

export interface SessionLanesOptions {
  /** Write one framed message to the lane's core stream. */
  write(lane: SessionLane, bytes: Uint8Array): void;
  /** Hand a message to the business. Returning a promise holds the lane until it settles. */
  deliver(message: unknown, lane: SessionLane): void | Promise<void>;
  /** The peer sent something this side cannot parse or hold: the session must be closed and reopened. */
  onError(error: Error): void;
  /** Session v2, the peer declared it: a body stream for one large message, or null to keep it on its lane. Absent: v1. */
  openBody?(lane: SessionLane, key: number): import('../types.js').SessionBodyWriter | null;
  /** Session v2: `received` of `total` bytes of the result for request `id` have arrived. */
  onProgress?(id: string, received: number, total: number): void;
}

interface InboundBody { chunks: Uint8Array[]; length: number; ended: boolean; total?: number; id?: string }

export class SessionLanes {
  private readonly sentPushes: [number, number, number] = [0, 0, 0];
  private sentNormalRequests = 0;
  private readonly deliveredPushes: [number, number, number] = [0, 0, 0];
  private deliveredNormalRequests = 0;
  private sentMovedRequests = 0;
  private deliveredMovedRequests = 0;
  private readonly inbound: Inbound[] = SESSION_LANES.map(() => ({ chunks: [], length: 0, queue: [], busy: false }));
  private heldBytes = 0;
  private closed = false;
  /** Session v2. Keys this side gives its bodies; started at random so a new session on the same connection does not reuse one. */
  private nextBodyKey = 1 + Math.floor(Math.random() * 0x3fffffff);
  private readonly outgoingBodies = new Map<string, { writer: import('../types.js').SessionBodyWriter; key: number }>();
  private readonly inboundBodies = new Map<number, InboundBody>();
  /**
   * Bodies the peer gave up (`x`). The notice may come before the placeholder or the body's first bytes, or after the body was
   * handed over, and the core still resends bytes of it already sent: anything that arrives for these keys is dropped, and a
   * placeholder for one is skipped. Bounded and never an error, so notices for bodies long handed over cost nothing.
   */
  private readonly abandonedKeys = new Set<number>();

  constructor(private readonly options: SessionLanesOptions) {}

  /** Writes one message; returns the lane it actually went on (a bulk request moves to background, see BULK_REQUEST_BYTES). */
  send(lane: SessionLane, kind: SessionMessageClass, message: unknown, options: SessionSendOptions = {}): SessionLane {
    if (this.closed) throw new Error('AGENT_NET_SESSION_CLOSED');
    const frame: Frame = { m: message, c: kind };
    if (kind === 'result' || options.afterEarlier) frame.p = [...this.sentPushes] as [number, number, number];
    if ((kind === 'request' && lane === 'control') || options.afterEarlier) frame.r = this.sentNormalRequests;
    const ordered = (kind === 'request' && lane !== 'background' && !options.unordered) || options.afterEarlier;
    if (ordered && this.sentMovedRequests > 0) frame.b = this.sentMovedRequests;
    // The message is encoded once: the frame is built around it, and a body stream (v2) carries it as is.
    const json = JSON.stringify(message) as string | undefined;
    const encodeFrame = () => encoder.encode(json === undefined ? JSON.stringify(frame) : `{"m":${json},${JSON.stringify({ ...frame, m: undefined }).slice(1)}`);
    let body = encodeFrame();
    let moved = false;
    if (kind === 'request' && lane !== 'background' && body.length > BULK_REQUEST_BYTES) {
      lane = 'background';
      moved = true;
      // Still after the normal-lane requests sent before it; size-moved requests keep their order on the background lane.
      frame.r = this.sentNormalRequests;
      delete frame.b;
      if (!options.unordered) frame.o = 1;
      body = encodeFrame();
    }
    const index = LANE_INDEX[lane];
    if (body.length > MAX_SESSION_MESSAGE_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    if (body.length >= BODY_STREAM_BYTES && json !== undefined && this.options.openBody) {
      const key = this.nextBodyKey;
      const writer = this.options.openBody(lane, key);
      if (writer) {
        this.nextBodyKey = this.nextBodyKey >= 0x7fffffff ? 1 : this.nextBodyKey + 1;
        const content = encoder.encode(json);
        const { m: _message, ...stamps } = frame;
        const stub: Frame = { ...stamps, z: [key, content.length], ...(kind === 'result' && options.id ? { i: options.id } : {}) };
        this.writeFrame(lane, encoder.encode(JSON.stringify(stub)));
        writer.write(content);
        writer.finish();
        if (kind === 'result' && options.id) {
          if (this.outgoingBodies.size >= MAX_ABANDONABLE_BODIES) this.outgoingBodies.delete(this.outgoingBodies.keys().next().value as string);
          this.outgoingBodies.set(options.id, { writer, key });
        }
        this.counted(kind, lane, index, moved, options);
        return lane;
      }
    }
    this.writeFrame(lane, body);
    this.counted(kind, lane, index, moved, options);
    return lane;
  }

  private writeFrame(lane: SessionLane, body: Uint8Array): void {
    const bytes = new Uint8Array(4 + body.length);
    new DataView(bytes.buffer).setUint32(0, body.length, false);
    bytes.set(body, 4);
    this.options.write(lane, bytes);
  }

  private counted(kind: SessionMessageClass, lane: SessionLane, index: number, moved: boolean, options: SessionSendOptions): void {
    if (kind === 'push') this.sentPushes[index]++;
    if (kind === 'request' && lane === 'normal') this.sentNormalRequests++;
    if (moved && !options.unordered) this.sentMovedRequests++;
  }

  /**
   * Session v2: the caller of request `id` gave up. If its result is still being written as a body, the rest is not sent; the peer
   * sees the body end short and skips the result (its caller is no longer waiting). False when there is no such body.
   */
  abandonResult(id: string): boolean {
    const body = this.outgoingBodies.get(id);
    if (!body) return false;
    this.outgoingBodies.delete(id);
    body.writer.abandon();
    // The body stream may end before even its key went out (the core drops what it has not sent, its first bytes included), so
    // the peer could not tell which placeholder it ended: it learns it from this notice, read as soon as it arrives.
    if (!this.closed) this.writeFrame('control', encoder.encode(JSON.stringify({ c: 'control', x: body.key } satisfies Frame)));
    return true;
  }

  /**
   * Session v2: bytes of a body stream the peer opened (`key` from its first bytes; any chunking), then `null` when the stream
   * ended. Keeps `bytes` until the body is handed over, like `receive`.
   */
  receiveBody(key: number, bytes: Uint8Array | null): void {
    if (this.closed || this.abandonedKeys.has(key)) return;
    let body = this.inboundBodies.get(key);
    if (!body) {
      if (bytes === null) return;
      if (this.inboundBodies.size >= MAX_OPEN_BODIES) { this.fail(new Error('AGENT_NET_SESSION_BACKLOG')); return; }
      body = { chunks: [], length: 0, ended: false };
      this.inboundBodies.set(key, body);
    }
    if (bytes === null) { body.ended = true; this.pump(); return; }
    if (body.ended) { this.fail(new Error('AGENT_NET_SESSION_FRAME_INVALID')); return; }
    if (!bytes.length) return;
    body.chunks.push(bytes); body.length += bytes.length; this.heldBytes += bytes.length;
    if (body.length > (body.total ?? MAX_SESSION_MESSAGE_BYTES)) { this.fail(new Error('AGENT_NET_SESSION_FRAME_TOO_LARGE')); return; }
    if (this.heldBytes > MAX_SESSION_HELD_BYTES) { this.fail(new Error('AGENT_NET_SESSION_BACKLOG')); return; }
    if (body.id !== undefined) this.options.onProgress?.(body.id, body.length, body.total!);
    if (body.length === body.total) this.pump();
  }

  /**
   * Feed bytes read from the lane's core stream (any chunking). The lane keeps `bytes` until its frame is complete, so
   * the caller must not reuse the array. Chunks are joined once per frame: a 512 KiB result arrives in hundreds of
   * packet-sized chunks, and copying the partial frame on every chunk was a fifth of a CPU-bound transfer.
   */
  receive(lane: SessionLane, bytes: Uint8Array): void {
    if (this.closed) return;
    const state = this.inbound[LANE_INDEX[lane]];
    if (bytes.length) { state.chunks.push(bytes); state.length += bytes.length; }
    while (state.length >= 4) {
      const head = peek(state, 4);
      const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, false);
      if (length > MAX_SESSION_MESSAGE_BYTES) { this.fail(new Error('AGENT_NET_SESSION_FRAME_TOO_LARGE')); return; }
      if (state.length < 4 + length) break;
      const body = take(state, 4 + length).subarray(4);
      let frame: unknown;
      try { frame = JSON.parse(decoder.decode(body)); }
      catch { this.fail(new Error('AGENT_NET_SESSION_FRAME_INVALID')); return; }
      if (!isFrame(frame, lane)) {
        this.fail(new Error('AGENT_NET_SESSION_FRAME_INVALID')); return;
      }
      if (frame.x !== undefined) { this.bodyAbandoned(frame.x); continue; }
      if (frame.z && !this.expectBody(frame)) return;
      state.queue.push({ frame, bytes: length });
      this.heldBytes += length;
    }
    if (this.heldBytes + state.length > MAX_SESSION_HELD_BYTES) { this.fail(new Error('AGENT_NET_SESSION_BACKLOG')); return; }
    this.pump();
  }

  close(): void {
    this.closed = true;
    for (const state of this.inbound) { state.queue.length = 0; state.chunks = []; state.length = 0; }
    this.inboundBodies.clear();
    this.outgoingBodies.clear();
    this.abandonedKeys.clear();
    this.heldBytes = 0;
  }

  /** The sender gave up the body with this key: its placeholder is skipped when it reaches its lane's head (or as soon as it arrives). */
  private bodyAbandoned(key: number): void {
    if (this.abandonedKeys.size >= MAX_ABANDONED_KEYS) this.abandonedKeys.delete(this.abandonedKeys.values().next().value as number);
    this.abandonedKeys.add(key);
    const body = this.inboundBodies.get(key);
    if (!body) return;
    this.heldBytes -= body.length;
    // Its placeholder, if waiting at its lane's head for the rest, goes in the pump at the end of `receive`.
    body.chunks = []; body.length = 0; body.ended = true;
  }

  /** A placeholder named its body: its length (and the result's id) applies to the bytes from now on. False: the session failed. */
  private expectBody(frame: Frame): boolean {
    const [key, total] = frame.z!;
    let body = this.inboundBodies.get(key);
    if (!body) {
      if (this.inboundBodies.size >= MAX_OPEN_BODIES) { this.fail(new Error('AGENT_NET_SESSION_BACKLOG')); return false; }
      body = { chunks: [], length: 0, ended: false };
      this.inboundBodies.set(key, body);
    }
    if (body.total !== undefined || body.length > total) { this.fail(new Error('AGENT_NET_SESSION_FRAME_INVALID')); return false; }
    body.total = total;
    if (this.abandonedKeys.has(key)) { body.ended = true; return true; }
    body.id = frame.i;
    if (body.id !== undefined && body.length > 0) this.options.onProgress?.(body.id, body.length, total);
    return true;
  }

  private ready(lane: number, frame: Frame): boolean {
    if (frame.z) {
      const body = this.inboundBodies.get(frame.z[0]);
      if (!body || (!body.ended && body.length < frame.z[1])) return false;
    }
    if (frame.p && frame.p.some((count, index) => index !== lane && this.deliveredPushes[index] < count)) return false;
    if (frame.r !== undefined && this.deliveredNormalRequests < frame.r) return false;
    if (frame.b !== undefined && this.deliveredMovedRequests < frame.b) return false;
    return true;
  }

  private pumping = false;
  private pumpAgain = false;

  /** Hands over every ready lane head. Iterative, so a long run of synchronous handlers does not grow the stack. */
  private pump(): void {
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (let lane = 0; lane < this.inbound.length && !this.closed; lane++) {
          const state = this.inbound[lane];
          while (!state.busy && !this.closed) {
            const head = state.queue[0];
            if (!head || !this.ready(lane, head.frame)) break;
            state.queue.shift();
            this.heldBytes -= head.bytes;
            let message = head.frame.m;
            if (head.frame.z) {
              const [key, total] = head.frame.z;
              const body = this.inboundBodies.get(key)!;
              this.inboundBodies.delete(key);
              this.heldBytes -= body.length;
              // Ended short: the sender gave it up because its caller had (a result, `abandonResult`). Nothing waits for it, and it
              // still counts as handed over, so what waits on its lane's counts goes on.
              if (body.length < total) { this.delivered(lane, head.frame); this.pumpAgain = true; continue; }
              try { message = JSON.parse(decoder.decode(join(body.chunks, body.length))); }
              catch { this.fail(new Error('AGENT_NET_SESSION_FRAME_INVALID')); return; }
            }
            state.busy = true;
            let result: void | Promise<void> = undefined;
            try { result = this.options.deliver(message, SESSION_LANES[lane]); } catch { result = undefined; }
            if (result && typeof (result as Promise<void>).then === 'function') {
              const settle = () => { this.delivered(lane, head.frame); this.pump(); };
              (result as Promise<void>).then(settle, settle);
            } else {
              this.delivered(lane, head.frame);
              this.pumpAgain = true;
            }
          }
        }
      } while (this.pumpAgain && !this.closed);
    } finally { this.pumping = false; }
  }

  private delivered(lane: number, frame: Frame): void {
    this.inbound[lane].busy = false;
    if (frame.c === 'push') this.deliveredPushes[lane]++;
    if (frame.c === 'request' && lane === LANE_INDEX.normal) this.deliveredNormalRequests++;
    if (frame.c === 'request' && frame.o === 1) this.deliveredMovedRequests++;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.options.onError(error);
  }
}

interface Inbound { chunks: Uint8Array[]; length: number; queue: Array<{ frame: Frame; bytes: number }>; busy: boolean }

function join(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** The first `count` buffered bytes (`count` <= buffered), without consuming them. */
function peek(state: Inbound, count: number): Uint8Array {
  const first = state.chunks[0];
  if (first.length >= count) return first.subarray(0, count);
  const out = new Uint8Array(count);
  let filled = 0;
  for (const chunk of state.chunks) {
    const part = chunk.subarray(0, count - filled);
    out.set(part, filled);
    filled += part.length;
    if (filled === count) break;
  }
  return out;
}

/** Consumes the first `count` buffered bytes (`count` <= buffered); copies only when they span chunks. */
function take(state: Inbound, count: number): Uint8Array {
  state.length -= count;
  const first = state.chunks[0];
  if (first.length >= count) {
    if (first.length === count) state.chunks.shift();
    else state.chunks[0] = first.subarray(count);
    return first.subarray(0, count);
  }
  const out = new Uint8Array(count);
  let filled = 0, used = 0;
  while (filled < count) {
    const chunk = state.chunks[used];
    const part = chunk.subarray(0, count - filled);
    out.set(part, filled);
    filled += part.length;
    if (part.length === chunk.length) used++;
    else state.chunks[used] = chunk.subarray(part.length);
  }
  state.chunks.splice(0, used);
  return out;
}
