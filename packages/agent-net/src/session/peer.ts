/**
 * One Agent-Net session with one peer (docs/agent-net-session-plan.md §10.1): requests with results, pushes, opening
 * and closing the control link, presence. Runs on the three lanes of `SessionLanes` over the peer's encrypted
 * connection; delivery and retransmission belong to the core, so nothing here acknowledges, resends or resets on
 * slowness. Independent of Device Link: it knows channels and payloads only as opaque values, and the caller decides
 * which lane a channel uses (`laneFor`).
 */
import { SessionLanes, type SessionLane, type SessionSendOptions } from './lanes.js';
import type { SessionWire } from '../types.js';

export type SessionResult = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

/** `extra`: request fields beyond channel and args that the caller's protocol carries (e.g. transfer options). */
export interface SessionRequest { id: string; channel: string; args: unknown[]; lane: SessionLane; extra?: Record<string, unknown> }

type Message =
  | { t: 'open'; id: string; payload: unknown }
  | { t: 'accept'; id: string; payload: unknown; at?: number }
  | { t: 'reject'; id: string; code: string; message: string }
  | { t: 'close'; reason: string }
  // `deadline`: optional deadline on the receiver's monotonic clock, derived from a link acceptance. Older peers use `at` and `ms`.
  | { t: 'invoke'; id: string; channel: string; args: unknown[]; x?: Record<string, unknown>; at?: number; ms?: number; deadline?: number }
  /** The caller gave up on this request (its time limit passed): if it has not been handed to the business yet, it never is. */
  | { t: 'cancel'; id: string }
  | { t: 'result'; id: string; result: SessionResult }
  | { t: 'push'; channel: string; payload: unknown }
  | { t: 'presence'; payload: unknown };

/**
 * Which end of the control link this side may be. `both` (the default) between devices that control each other. A session
 * inside a delegation (a guest admitted to one resource) is one-way: `call` on the guest, which opens, requests, cancels
 * and closes; `serve` on the resource's computers, which accept or reject, answer, push and close. A message the peer may
 * not send is dropped before any handler sees it, and this side's own calls outside its role fail with `FORBIDDEN`: the
 * same boundary as the scoped Device Link frames these sessions replace (`scopedRoutes.ts`).
 */
export type SessionRole = 'both' | 'call' | 'serve';
const SENDS: Record<Exclude<SessionRole, 'both'>, ReadonlySet<string>> = {
  call: new Set(['open', 'invoke', 'cancel', 'close']),
  serve: new Set(['accept', 'reject', 'result', 'push', 'close']),
};
const RECEIVES: Record<Exclude<SessionRole, 'both'>, ReadonlySet<string>> = { call: SENDS.serve, serve: SENDS.call };

export interface SessionPeerOptions {
  wire: SessionWire;
  role?: SessionRole;
  /** Lane for a request channel (and its result). Pushes always use the normal lane in v1 (one order across topics). */
  laneFor(channel: string, background?: boolean): SessionLane;
  /** The peer opened its control link to us (Device Link's `link-open`); answer with `accept` or `reject`. */
  onOpen?(id: string, payload: unknown): void | Promise<void>;
  onClose?(reason: string): void | Promise<void>;
  onRequest?(request: SessionRequest): void | Promise<void>;
  onPush?(channel: string, payload: unknown): void | Promise<void>;
  onPresence?(payload: unknown): void | Promise<void>;
  /** The session is unusable (bad frame, backlog, connection gone); pending requests have been failed. */
  onBroken?(code: string): void;
}

/** What the upper layer handles for one peer's session; everything except the wire, lane policy and role. */
export type SessionHandlers = Omit<SessionPeerOptions, 'wire' | 'laneFor' | 'role'>;
/**
 * Turns sessions on for a socket: the lane policy for requests and the handlers for each peer. `handlers` gets the peer's
 * session key: the device id between devices of one account; inside a delegation, the scoped peer the delegation names
 * (the same key a scoped Device Link frame from that peer decodes to). `delegatedOnly`: sessions only inside delegations,
 * for a socket that serves shared resources and must not carry control between devices of one account.
 */
export interface SessionConfig {
  laneFor(channel: string, background?: boolean): SessionLane;
  handlers(deviceId: string): SessionHandlers;
  delegatedOnly?: boolean;
}

/**
 * `lane` overrides `laneFor`: the session in the Agent-Net worker gets the lane Main chose for the request.
 * `onSettled` is called synchronously the moment the result is known, before the returned promise resolves: a host that
 * forwards results (the Agent-Net worker to Main) passes them on in the same turn, so a push the peer sent after the result
 * cannot overtake it (a promise callback would run only after the lanes have handed over the next message).
 */
export interface SessionRequestOptions {
  timeoutMs?: number; background?: boolean; lane?: SessionLane; extra?: Record<string, unknown>;
  /**
   * The request id, instead of a new one: the same request sent again on a new session after the previous one broke with it
   * in flight. The peer's business keys its duplicate check by this id (Desktop dispatch: the result it remembers, or the run
   * still in progress), so the request runs at most once and its result reaches the caller, as Device Link's resend does.
   */
  id?: string;
  /**
   * An idempotent read: it neither waits for an earlier request moved to the background lane for its size nor makes later
   * ones wait for it (lanes.ts). Writes keep their order.
   */
  unordered?: boolean;
  onSettled?(result: SessionResult): void;
}
/** See `SessionRequestOptions.onSettled`: the same for opening a link. */
export type SessionOpenOutcome = { opened: unknown } | { error: Error };

/** What the business side uses of a session, the same whether it runs on this thread or in the Agent-Net worker. */
export type SessionHandle = Pick<SessionPeer, 'open' | 'accept' | 'reject' | 'close' | 'presence' | 'request' | 'respond' | 'push'
  | 'dispose' | 'bufferedAmount' | 'closedReason'>;

interface Pending { resolve(result: SessionResult): void; timer: ReturnType<typeof setTimeout> | null; written: boolean }

/** Cancelled request ids kept until the request arrives; one entry per timed-out request, oldest dropped first. */
const MAX_CANCELLED_REQUESTS = 1024;

let nextId = 0;
const newId = () => `s${Date.now().toString(36)}-${(++nextId).toString(36)}`;
/** A new request id for `SessionRequestOptions.id` (unique within this process, as the ones a session makes itself). */
export const newSessionRequestId = newId;

export class SessionPeer {
  private readonly lanes: SessionLanes;
  private readonly pending = new Map<string, Pending>();
  private readonly opening = new Map<string, { resolve(payload: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  /** Lane each inbound request arrived on, so its result goes back on the same lane. */
  private readonly inboundLane = new Map<string, SessionLane>();
  private broken: string | null = null;
  private readonly cancelled = new Set<string>();
  /**
   * Smallest (this side's clock when a request arrived − the sender's clock when it wrote it) on this session: the offset
   * between the two clocks plus the fastest trip. How much later than that a request arrives is how long it was held up
   * (a stalled path, a retransmission, a wait in this side's lane queue); neither clock has to agree with the other.
   */
  private lagFloor: number | null = null;
  /** Receiver clock minus sender clock, measured from an authenticated link acceptance. Travel time makes this a lower bound. */
  private peerClockLowerBound: number | undefined;

  constructor(private readonly options: SessionPeerOptions) {
    this.lanes = new SessionLanes({
      write: (lane, bytes) => options.wire.write(lane, bytes),
      deliver: (message, lane) => this.deliver(message as Message, lane),
      onError: (error) => this.dispose(error.message),
    });
    options.wire.onData((lane, bytes) => this.lanes.receive(lane, bytes));
  }

  get bufferedAmount(): number { return this.options.wire.bufferedAmount; }
  get closedReason(): string | null { return this.broken; }

  /** Ask the peer for its control link; resolves with its accept payload. */
  open(payload: unknown, timeoutMs: number, onSettled?: (outcome: SessionOpenOutcome) => void): Promise<unknown> {
    const fail = (error: Error) => { onSettled?.({ error }); return Promise.reject(error); };
    if (this.broken) return fail(new SessionError(this.broken, 'session closed'));
    if (!this.maySend('open')) return fail(forbidden('open'));
    const id = newId();
    return new Promise((resolve, reject) => {
      const accepted = (opened: unknown) => { onSettled?.({ opened }); resolve(opened); };
      const refused = (error: Error) => { onSettled?.({ error }); reject(error); };
      const timer = setTimeout(() => { this.opening.delete(id); refused(new SessionError('LINK_TIMEOUT', 'no answer to session open')); }, timeoutMs);
      this.opening.set(id, { resolve: accepted, reject: refused, timer });
      this.send('control', 'control', { t: 'open', id, payload });
    });
  }
  accept(id: string, payload: unknown): void { this.send('control', 'control', { t: 'accept', id, payload, at: performance.now() }); }
  reject(id: string, code: string, message: string): void { this.send('control', 'control', { t: 'reject', id, code, message }); }
  close(reason: string): void { if (!this.broken) this.send('control', 'control', { t: 'close', reason }, { afterEarlier: true }); }
  presence(payload: unknown): void { if (!this.broken) this.send('control', 'control', { t: 'presence', payload }); }

  /**
   * Calls a channel on the peer. A request that was never written fails with `NOT_SENT` and is safe to retry; one that was
   * written and then lost to a timeout or a dropped connection may have run (`INVOKE_TIMEOUT` / `DEVICE_OFFLINE`).
   * After a timeout the peer does not start it any more (docs/agent-net-session-plan.md §5.4): a cancel goes out on the
   * control lane, and a request that reaches the peer later than its time limit is dropped there, which also covers a
   * cancel overtaken by the request's own retransmission after a stall.
   */
  request(channel: string, args: unknown[], options: SessionRequestOptions = {}): Promise<SessionResult> {
    const settled = (result: SessionResult) => { options.onSettled?.(result); return Promise.resolve(result); };
    if (this.broken) return settled(failure(this.broken, 'session closed'));
    if (!this.maySend('invoke')) return settled(failure('FORBIDDEN', forbidden('invoke').message));
    const id = options.id ?? newId();
    if (this.pending.has(id)) return settled(failure('NOT_SENT', 'request id already in flight on this session'));
    const lane = options.lane ?? this.options.laneFor(channel, options.background);
    return new Promise<SessionResult>((done) => {
      const resolve = (result: SessionResult) => { options.onSettled?.(result); done(result); };
      const entry: Pending = { resolve, timer: null, written: false };
      const timeoutMs = options.timeoutMs;
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          if (entry.written && !this.broken) {
            try { this.send('control', 'control', { t: 'cancel', id }); } catch { /* the session is closing; the peer drops it as late */ }
          }
          resolve(failure('INVOKE_TIMEOUT', `no result within ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        const now = performance.now();
        const deadline = timeoutMs !== undefined && this.peerClockLowerBound !== undefined
          ? now + timeoutMs + this.peerClockLowerBound : undefined;
        this.send(lane, 'request', { t: 'invoke', id, channel, args, ...(options.extra ? { x: options.extra } : {}),
          at: Math.round(now), ...(timeoutMs !== undefined ? { ms: timeoutMs } : {}), ...(deadline !== undefined ? { deadline } : {}) },
        { unordered: options.unordered });
        entry.written = true;
      } catch (error) {
        this.settle(id, failure(error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'NOT_SENT', String(error)));
      }
    });
  }

  respond(id: string, result: SessionResult): void {
    const lane = this.inboundLane.get(id) ?? 'normal';
    this.send(lane, 'result', { t: 'result', id, result });
    this.inboundLane.delete(id);
  }

  push(channel: string, payload: unknown): void { this.send('normal', 'push', { t: 'push', channel, payload }); }

  /** The connection is gone or unusable: fail everything still waiting. Idempotent. */
  dispose(code: string): void {
    if (this.broken) return;
    this.broken = code;
    this.lanes.close();
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(failure(entry.written ? 'DEVICE_OFFLINE' : 'NOT_SENT', `session ${code}`));
    }
    for (const [id, open] of this.opening) { clearTimeout(open.timer); this.opening.delete(id); open.reject(new SessionError('DEVICE_OFFLINE', `session ${code}`)); }
    this.inboundLane.clear();
    this.options.onBroken?.(code);
  }

  private send(lane: SessionLane, kind: 'control' | 'request' | 'result' | 'push', message: Message, options?: SessionSendOptions): SessionLane {
    if (this.broken) throw new SessionError(this.broken, 'session closed');
    if (!this.maySend(message.t)) throw forbidden(message.t);
    return this.lanes.send(lane, kind, message, options);
  }

  private maySend(type: Message['t']): boolean {
    const role = this.options.role ?? 'both';
    return role === 'both' || SENDS[role].has(type);
  }

  /** The caller cancelled this request, or its time limit passed before it got here (see `lagFloor`). */
  private lateOrCancelled(message: { id: string; at?: unknown; ms?: unknown; deadline?: unknown }): boolean {
    if (this.cancelled.delete(message.id)) return true;
    if (typeof message.deadline === 'number' && Number.isFinite(message.deadline)) {
      return performance.now() >= message.deadline;
    }
    const arrivedLag = lag(message);
    if (arrivedLag === null) return false;
    this.lagFloor = this.lagFloor === null ? arrivedLag : Math.min(this.lagFloor, arrivedLag);
    return typeof message.ms === 'number' && arrivedLag - this.lagFloor >= message.ms;
  }

  private settle(id: string, result: SessionResult): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(result);
  }

  private deliver(message: Message, arrivedOn: SessionLane): void | Promise<void> {
    const role = this.options.role ?? 'both';
    // Not the peer's to send in a one-way session: dropped here, the same as an out-of-scope Device Link frame.
    if (role !== 'both' && !RECEIVES[role].has(message?.t)) return;
    switch (message?.t) {
      case 'invoke': {
        if (typeof message.id !== 'string' || typeof message.channel !== 'string' || !Array.isArray(message.args)) return;
        // The caller has already given up: it reported a timeout (`INVOKE_TIMEOUT`, may have run), so nothing waits for a result.
        if (this.lateOrCancelled(message)) return;
        // The result goes back on the lane the request came on: the caller chose it (including its background hint).
        this.inboundLane.set(message.id, arrivedOn);
        const extra = message.x && typeof message.x === 'object' && !Array.isArray(message.x) ? message.x : undefined;
        return this.options.onRequest?.({ id: message.id, channel: message.channel, args: message.args, lane: arrivedOn, ...(extra ? { extra } : {}) });
      }
      case 'result': this.settle(message.id, message.result); return;
      case 'push': return this.options.onPush?.(message.channel, message.payload);
      case 'open': return this.options.onOpen?.(message.id, message.payload);
      case 'accept': case 'reject': {
        const open = this.opening.get(message.id);
        if (!open) return;
        this.opening.delete(message.id);
        clearTimeout(open.timer);
        if (message.t === 'accept') {
          this.peerClockLowerBound = typeof message.at === 'number' && Number.isFinite(message.at)
            ? message.at - performance.now() : undefined;
          open.resolve(message.payload);
        } else open.reject(new SessionError(message.code, message.message));
        return;
      }
      case 'cancel': {
        // Already with the business: too late to stop, the result goes back and the caller ignores it.
        if (typeof message.id !== 'string' || this.inboundLane.has(message.id)) return;
        if (this.cancelled.size >= MAX_CANCELLED_REQUESTS) this.cancelled.delete(this.cancelled.values().next().value as string);
        this.cancelled.add(message.id);
        return;
      }
      case 'close': return this.options.onClose?.(message.reason);
      case 'presence': return this.options.onPresence?.(message.payload);
    }
  }
}

/** `at` and `ms` are what `SessionPeer.request` stamps on an invoke; peers that do not send them are never treated as late. */
function lag(message: { at?: unknown; ms?: unknown }): number | null {
  return typeof message.at === 'number' && Number.isFinite(message.at) ? performance.now() - message.at : null;
}

export class SessionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const failure = (code: string, message: string): SessionResult => ({ ok: false, error: { code, message } });
const forbidden = (type: string) => new SessionError('FORBIDDEN', `this side of a one-way session does not send ${type}`);
