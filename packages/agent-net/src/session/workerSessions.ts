/**
 * Agent-Net sessions when the core runs in a worker (Desktop's `AgentNetWorkerSocket`, docs/agent-net-session-plan.md
 * §10.1). The session itself — framing, cross-lane order, JSON — runs in the worker beside the core, so a large result
 * is parsed off Main; Main gets decoded messages. Main acknowledges each delivered message once its handler settled,
 * and only then does that lane hand over its next message: the same serial delivery as a session on one thread.
 * Main chooses every request's lane, so the worker needs no channel policy. Messages here cross threads of one process;
 * none of this is on the wire.
 */
import type { SessionLane } from './lanes.js';
import type { SessionConfig, SessionHandle, SessionHandlers, SessionPeer, SessionRequest, SessionRequestOptions, SessionResult } from './peer.js';
import { SessionError } from './peer.js';

type Call =
  | { op: 'open'; payload: unknown; timeoutMs: number }
  | { op: 'accept'; id: string; payload: unknown }
  | { op: 'reject'; id: string; code: string; message: string }
  | { op: 'close'; reason: string }
  | { op: 'presence'; payload: unknown }
  | { op: 'request'; channel: string; args: unknown[]; timeoutMs?: number; lane: SessionLane; extra?: Record<string, unknown>; id?: string; unordered?: boolean }
  | { op: 'respond'; id: string; result: SessionResult }
  | { op: 'push'; channel: string; payload: unknown }
  | { op: 'dispose'; code: string };
type CallMessage = Call & { type: 'session-call'; peer: string; call: number; bytes: number };

type Event =
  | { event: 'open'; id: string; payload: unknown }
  | { event: 'close'; reason: string }
  | { event: 'request'; request: SessionRequest }
  | { event: 'push'; channel: string; payload: unknown }
  | { event: 'presence'; payload: unknown };

const failure = (code: string, message: string): SessionResult => ({ ok: false, error: { code, message } });
/**
 * While a session's lanes still hold data, the worker reports their backlog again this often until it is gone. Main reads it
 * as the link's queue depth (Device Link's reliable window) and holds text pushes back while it is high; heard only after
 * Main's own calls, a backlog that drained with nothing new to send stayed "full" and remote text stopped (2026-11-17 review).
 */
export const SESSION_BACKLOG_REPORT_MS = 50;

/** What the worker needs of its socket: the session side of `PortableSocket`. */
export interface SessionHost {
  useSessions(config: SessionConfig): void;
  session(key: string): SessionPeer | null;
  /** `deviceId`: the connection the session runs on (differs from the key inside a delegation). */
  onSession(listener: (key: string, session: SessionPeer, deviceId: string) => void): void;
  connectSession?(key: string): Promise<boolean>;
}

/**
 * Worker side. Returns the handler for Main's session messages (`true` when it was one). The returned promises of the
 * session handlers resolve on Main's acknowledgement, which holds the lane; a broken session releases its waiting ones.
 */
export function serveWorkerSessions(socket: SessionHost, send: (message: unknown) => void): (message: any) => boolean {
  const acks = new Map<number, { peer: string; resolve(): void }>();
  let sequence = 0;
  const toMain = (peer: string, event: Event) => new Promise<void>((resolve) => {
    const seq = ++sequence;
    acks.set(seq, { peer, resolve });
    send({ type: 'session-event', peer, seq, ...event });
  });
  const backlogs = new Map<string, ReturnType<typeof setTimeout>>();
  const taken = (peer: string, bytes: number) => {
    const buffered = socket.session(peer)?.bufferedAmount ?? 0;
    send({ type: 'session-taken', peer, bytes, buffered });
    if (buffered > 0 && !backlogs.has(peer)) {
      const timer = setTimeout(() => { backlogs.delete(peer); taken(peer, 0); }, SESSION_BACKLOG_REPORT_MS);
      (timer as { unref?: () => void }).unref?.();
      backlogs.set(peer, timer);
    }
  };
  let used = false;
  return (message) => {
    if (message?.type === 'session-ack') {
      const ack = acks.get(message.seq);
      if (ack) { acks.delete(message.seq); ack.resolve(); }
      return true;
    }
    if (message?.type === 'session-connect') {
      void Promise.resolve(socket.connectSession?.(String(message.peer)) ?? false).catch(() => false)
        .then((connected) => send({ type: 'session-connected', call: message.call, connected }));
      return true;
    }
    if (message?.type === 'session-use') {
      if (used) return true;
      used = true;
      socket.onSession((peer, _session, device) => send({ type: 'session-up', peer, device }));
      socket.useSessions({ laneFor: () => 'normal', delegatedOnly: message.delegatedOnly === true, handlers: (peer) => ({
        onOpen: (id, payload) => toMain(peer, { event: 'open', id, payload }),
        onClose: (reason) => toMain(peer, { event: 'close', reason }),
        onRequest: (request) => toMain(peer, { event: 'request', request }),
        onPush: (channel, payload) => toMain(peer, { event: 'push', channel, payload }),
        onPresence: (payload) => toMain(peer, { event: 'presence', payload }),
        onBroken: (code) => {
          for (const [seq, ack] of acks) if (ack.peer === peer) { acks.delete(seq); ack.resolve(); }
          send({ type: 'session-broken', peer, code });
        },
      }) });
      return true;
    }
    if (message?.type !== 'session-call') return false;
    const call = message as CallMessage, session = socket.session(call.peer);
    const reply = (value: Record<string, unknown>) => send({ type: 'session-reply', call: call.call, ...value });
    if (!session) {
      if (call.op === 'request') reply({ result: failure('NOT_SENT', 'no session') });
      if (call.op === 'open') reply({ error: { code: 'DEVICE_OFFLINE', message: 'no session' } });
      taken(call.peer, call.bytes);
      return true;
    }
    try {
      switch (call.op) {
        // Replies go out the moment the session settles them (not from a promise callback): a push the peer sent after the
        // result or the accept is handed over to Main after it, in the same order the peer sent them.
        case 'open': session.open(call.payload, call.timeoutMs, (outcome) => reply('opened' in outcome ? { opened: outcome.opened }
          : { error: { code: outcome.error instanceof SessionError ? outcome.error.code : 'DEVICE_OFFLINE', message: String(outcome.error?.message ?? outcome.error) } }))
          .catch(() => { /* replied above */ });
          break;
        case 'request': void session.request(call.channel, call.args, { timeoutMs: call.timeoutMs, lane: call.lane, extra: call.extra, id: call.id, unordered: call.unordered,
          onSettled: (result) => reply({ result }) });
          break;
        case 'accept': session.accept(call.id, call.payload); break;
        case 'reject': session.reject(call.id, call.code, call.message); break;
        case 'close': session.close(call.reason); break;
        case 'presence': session.presence(call.payload); break;
        case 'push': session.push(call.channel, call.payload); break;
        case 'dispose': session.dispose(call.code); break;
        case 'respond':
          try { session.respond(call.id, call.result); }
          catch (error) {
            // Too large to frame: the caller gets a definite failure instead of waiting for its timeout.
            if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') session.respond(call.id, failure('PAYLOAD_TOO_LARGE', 'result too large'));
            else throw error;
          }
          break;
      }
    } catch { /* A closed session already failed its callers; Main hears of it from `session-broken`. */ }
    taken(call.peer, call.bytes);
    return true;
  };
}

/** Main side: the sessions of one `AgentNetWorkerSocket`. */
export class WorkerSessions {
  private config: SessionConfig | null = null;
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly calls = new Map<number, { session: WorkerSession; settle(value: any): void }>();
  private readonly connecting = new Map<number, (connected: boolean) => void>();
  /** Session key → the connection it runs on, as the worker announced it. */
  private readonly devices = new Map<string, string>();
  private nextCall = 0;

  constructor(private readonly post: (message: unknown) => void, private readonly announce: (key: string, session: SessionHandle) => void) {}

  use(config: SessionConfig): void {
    this.config = config;
    this.post({ type: 'session-use', delegatedOnly: config.delegatedOnly === true });
  }

  session(key: string): SessionHandle | null { return this.sessions.get(key) ?? null; }
  /** The connection (directory or delegation id) the live session for this key runs on. */
  device(key: string): string | null { return this.sessions.has(key) ? this.devices.get(key) ?? null : null; }

  /** See `PortableSocket.connectSession`; false once the worker is gone. */
  connect(key: string): Promise<boolean> {
    if (!this.config) return Promise.resolve(false);
    const id = ++this.nextCall;
    return new Promise((resolve) => {
      this.connecting.set(id, resolve);
      this.post({ type: 'session-connect', peer: key, call: id });
    });
  }

  /** Handles a message from the worker; `true` when it was a session message. */
  receive(message: any): boolean {
    switch (message?.type) {
      case 'session-up': {
        if (!this.config) return true;
        this.sessions.get(message.peer)?.broken('DEVICE_OFFLINE');
        const session = new WorkerSession(message.peer, this.config, this);
        this.sessions.set(message.peer, session);
        this.devices.set(message.peer, typeof message.device === 'string' ? message.device : message.peer);
        this.announce(message.peer, session);
        return true;
      }
      case 'session-connected': {
        const resolve = this.connecting.get(message.call);
        if (resolve) { this.connecting.delete(message.call); resolve(message.connected === true); }
        return true;
      }
      case 'session-event': {
        const session = this.sessions.get(message.peer);
        const ack = () => this.post({ type: 'session-ack', seq: message.seq });
        if (!session) { ack(); return true; }
        let settled: void | Promise<void>;
        try { settled = session.deliver(message as Event); } catch { settled = undefined; }
        if (settled && typeof settled.then === 'function') settled.then(ack, ack); else ack();
        return true;
      }
      case 'session-reply': {
        const call = this.calls.get(message.call);
        if (call) { this.calls.delete(message.call); call.settle(message); }
        return true;
      }
      case 'session-taken': {
        this.sessions.get(message.peer)?.taken(message.bytes, message.buffered);
        return true;
      }
      case 'session-broken': {
        const session = this.sessions.get(message.peer);
        if (session) { this.sessions.delete(message.peer); session.broken(message.code); }
        return true;
      }
    }
    return false;
  }

  /** The worker is gone: every session with it is too. */
  closeAll(code: string): void {
    for (const session of [...this.sessions.values()]) session.broken(code);
    this.sessions.clear();
    this.devices.clear();
    for (const resolve of this.connecting.values()) resolve(false);
    this.connecting.clear();
  }

  /** @internal */
  call(session: WorkerSession, call: Call, bytes: number, settle?: (value: any) => void): void {
    const id = ++this.nextCall;
    if (settle) this.calls.set(id, { session, settle });
    this.post({ type: 'session-call', peer: session.deviceId, call: id, bytes, ...call });
  }

  /** @internal */
  forget(session: WorkerSession, code: string): void {
    if (this.sessions.get(session.deviceId) === session) { this.sessions.delete(session.deviceId); this.devices.delete(session.deviceId); }
    for (const [id, call] of this.calls) {
      if (call.session !== session) continue;
      this.calls.delete(id);
      call.settle({ result: failure('DEVICE_OFFLINE', `session ${code}`), error: { code: 'DEVICE_OFFLINE', message: `session ${code}` } });
    }
  }
}

class WorkerSession implements SessionHandle {
  private reason: string | null = null;
  private readonly handlers: SessionHandlers;
  /** Bytes posted to the worker that it has not taken yet, and what its lanes still hold. */
  private posted = 0;
  private remote = 0;

  constructor(readonly deviceId: string, private readonly config: SessionConfig, private readonly owner: WorkerSessions) {
    this.handlers = config.handlers(deviceId);
  }

  get bufferedAmount(): number { return this.posted + this.remote; }
  get closedReason(): string | null { return this.reason; }

  open(payload: unknown, timeoutMs: number): Promise<unknown> {
    if (this.reason) return Promise.reject(new SessionError(this.reason, 'session closed'));
    return new Promise((resolve, reject) => this.send({ op: 'open', payload, timeoutMs }, payload, (reply) => {
      if (reply.error) reject(new SessionError(reply.error.code, reply.error.message)); else resolve(reply.opened);
    }));
  }
  accept(id: string, payload: unknown): void { this.send({ op: 'accept', id, payload }, payload); }
  reject(id: string, code: string, message: string): void { this.send({ op: 'reject', id, code, message }, message); }
  close(reason: string): void { if (!this.reason) this.send({ op: 'close', reason }, reason); }
  presence(payload: unknown): void { if (!this.reason) this.send({ op: 'presence', payload }, payload); }
  request(channel: string, args: unknown[], options: SessionRequestOptions = {}): Promise<SessionResult> {
    if (this.reason) return Promise.resolve(failure(this.reason, 'session closed'));
    const lane = options.lane ?? this.config.laneFor(channel, options.background);
    return new Promise((resolve) => this.send({ op: 'request', channel, args, timeoutMs: options.timeoutMs, lane, extra: options.extra, ...(options.id ? { id: options.id } : {}), ...(options.unordered ? { unordered: true } : {}) }, args,
      (reply) => resolve(reply.result as SessionResult)));
  }
  respond(id: string, result: SessionResult): void { this.send({ op: 'respond', id, result }, result); }
  push(channel: string, payload: unknown): void { this.send({ op: 'push', channel, payload }, payload); }
  dispose(code: string): void {
    if (this.reason) return;
    this.owner.call(this, { op: 'dispose', code }, 0);
    this.broken(code);
  }

  /** @internal */
  deliver(event: Event): void | Promise<void> {
    if (this.reason) return;
    switch (event.event) {
      case 'open': return this.handlers.onOpen?.(event.id, event.payload);
      case 'close': return this.handlers.onClose?.(event.reason);
      case 'request': return this.handlers.onRequest?.(event.request);
      case 'push': return this.handlers.onPush?.(event.channel, event.payload);
      case 'presence': return this.handlers.onPresence?.(event.payload);
    }
  }
  /** @internal */
  taken(bytes: number, remote: number): void { this.posted = Math.max(0, this.posted - bytes); this.remote = remote; }
  /** @internal */
  broken(code: string): void {
    if (this.reason) return;
    this.reason = code;
    this.posted = 0; this.remote = 0;
    this.owner.forget(this, code);
    this.handlers.onBroken?.(code);
  }

  private send(call: Call, payload: unknown, settle?: (reply: any) => void): void {
    if (this.reason) throw new SessionError(this.reason, 'session closed');
    const bytes = roughBytes(payload);
    this.posted += bytes;
    this.owner.call(this, call, bytes, settle);
  }
}

/**
 * About how many bytes a payload takes once framed, without serializing it on Main: strings by length, the rest by a
 * bounded walk. Only for `bufferedAmount`, which callers use to back off; the worker reports the exact backlog.
 */
export function roughBytes(value: unknown, budget = { nodes: 10_000 }): number {
  if (typeof value === 'string') return value.length + 2;
  if (value === null || typeof value !== 'object') return 8;
  if (--budget.nodes < 0) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength * 4;
  let total = 2;
  if (Array.isArray(value)) { for (const item of value) total += roughBytes(item, budget) + 1; return total; }
  for (const key in value as Record<string, unknown>) total += key.length + 3 + roughBytes((value as Record<string, unknown>)[key], budget);
  return total;
}
