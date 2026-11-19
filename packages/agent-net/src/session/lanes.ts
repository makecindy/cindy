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

const LANE_INDEX: Record<SessionLane, number> = { control: 0, normal: 1, background: 2 };
const encoder = new TextEncoder(), decoder = new TextDecoder();

/**
 * Wire record: the message plus what it waits for. `p`: pushes delivered per lane; `r`: normal-lane requests delivered;
 * `b`: size-moved requests delivered; `o`: this is a size-moved request.
 */
interface Frame { m: unknown; c: SessionMessageClass; p?: [number, number, number]; r?: number; b?: number; o?: 1 }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFrame(value: unknown, lane: SessionLane): value is Frame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { c, p, r, b, o } = value as Record<string, unknown>;
  return (c === 'control' || c === 'request' || c === 'result' || c === 'push')
    && (p === undefined || (Array.isArray(p) && p.length === SESSION_LANES.length && p.every(isCount)))
    && (r === undefined || isCount(r))
    && (b === undefined || isCount(b))
    && (o === undefined || (o === 1 && c === 'request' && lane === 'background'));
}
/** See the module comment. */
export interface SessionSendOptions { unordered?: boolean; afterEarlier?: boolean }

export interface SessionLanesOptions {
  /** Write one framed message to the lane's core stream. */
  write(lane: SessionLane, bytes: Uint8Array): void;
  /** Hand a message to the business. Returning a promise holds the lane until it settles. */
  deliver(message: unknown, lane: SessionLane): void | Promise<void>;
  /** The peer sent something this side cannot parse or hold: the session must be closed and reopened. */
  onError(error: Error): void;
}

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

  constructor(private readonly options: SessionLanesOptions) {}

  /** Writes one message; returns the lane it actually went on (a bulk request moves to background, see BULK_REQUEST_BYTES). */
  send(lane: SessionLane, kind: SessionMessageClass, message: unknown, options: SessionSendOptions = {}): SessionLane {
    if (this.closed) throw new Error('AGENT_NET_SESSION_CLOSED');
    const frame: Frame = { m: message, c: kind };
    if (kind === 'result' || options.afterEarlier) frame.p = [...this.sentPushes] as [number, number, number];
    if ((kind === 'request' && lane === 'control') || options.afterEarlier) frame.r = this.sentNormalRequests;
    const ordered = (kind === 'request' && lane !== 'background' && !options.unordered) || options.afterEarlier;
    if (ordered && this.sentMovedRequests > 0) frame.b = this.sentMovedRequests;
    let body = encoder.encode(JSON.stringify(frame));
    let moved = false;
    if (kind === 'request' && lane !== 'background' && body.length > BULK_REQUEST_BYTES) {
      lane = 'background';
      moved = true;
      // Still after the normal-lane requests sent before it; size-moved requests keep their order on the background lane.
      frame.r = this.sentNormalRequests;
      delete frame.b;
      if (!options.unordered) frame.o = 1;
      body = encoder.encode(JSON.stringify(frame));
    }
    const index = LANE_INDEX[lane];
    if (body.length > MAX_SESSION_MESSAGE_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    const bytes = new Uint8Array(4 + body.length);
    new DataView(bytes.buffer).setUint32(0, body.length, false);
    bytes.set(body, 4);
    this.options.write(lane, bytes);
    if (kind === 'push') this.sentPushes[index]++;
    if (kind === 'request' && lane === 'normal') this.sentNormalRequests++;
    if (moved && !options.unordered) this.sentMovedRequests++;
    return lane;
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
      state.queue.push({ frame, bytes: length });
      this.heldBytes += length;
    }
    if (this.heldBytes + state.length > MAX_SESSION_HELD_BYTES) { this.fail(new Error('AGENT_NET_SESSION_BACKLOG')); return; }
    this.pump();
  }

  close(): void {
    this.closed = true;
    for (const state of this.inbound) { state.queue.length = 0; state.chunks = []; state.length = 0; }
    this.heldBytes = 0;
  }

  private ready(lane: number, frame: Frame): boolean {
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
            state.busy = true;
            let result: void | Promise<void> = undefined;
            try { result = this.options.deliver(head.frame.m, SESSION_LANES[lane]); } catch { result = undefined; }
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
