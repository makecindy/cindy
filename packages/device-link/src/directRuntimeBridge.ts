import { MAX_FRAME_BYTES } from './protocol.js';
import { byteLength } from './transport.js';
import { DIRECT_LINK_MAX_PEERS, DIRECT_LINK_MAX_SDP, type DirectRuntime,
  type DirectRuntimeEvents, type DirectRuntimeSession } from './directNegotiation.js';

export type DirectRuntimeCommand = { id: string; connection: string } & (
  | { action: 'offer' | 'close' }
  | { action: 'accept' | 'answer'; sdp: string }
  | { action: 'send'; text: string; sequence: number }
);
export type DirectRuntimeEvent =
  | { type: 'reply'; id: string; ok: boolean; value?: string }
  | { type: 'open' | 'closed'; connection: string }
  | { type: 'message'; connection: string; text: string }
  | { type: 'buffer'; connection: string; sequence: number; buffered: number };

/** Same bridge on Desktop IPC and Mobile WebView. Buffers include messages still
 * crossing the native bridge; a frozen renderer cannot look like an empty channel. */
export function createDirectRuntimeBridge() {
  let transport: ((command: DirectRuntimeCommand) => void) | undefined;
  let nextId = 0;
  const sessions = new Map<string, { events: DirectRuntimeEvents; buffered: number;
    queue: Map<number, number>; sequence: number; acknowledged: number; open: boolean }>();
  const pending = new Map<string, { connection: string; resolve(value: string): void;
    reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const close = (connection: string, notify = true) => {
    const s = sessions.get(connection);
    if (!s) return;
    sessions.delete(connection);
    for (const [id, p] of pending) if (p.connection === connection) {
      pending.delete(id); clearTimeout(p.timer); p.reject(new Error('DIRECT_CHANNEL_CLOSED'));
    }
    if (notify) { try { transport?.({ id: String(++nextId), action: 'close', connection }); } catch { /* Host gone. */ } }
    s.events.closed();
  };
  const invoke = (connection: string, action: 'offer' | 'accept' | 'answer', sdp?: string) => new Promise<string>((resolve, reject) => {
    if (!sessions.has(connection) || !transport) { reject(new Error('DIRECT_RUNTIME_UNAVAILABLE')); return; }
    const id = String(++nextId);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('DIRECT_RUNTIME_TIMEOUT')); close(connection); }, 10_000);
    pending.set(id, { connection, resolve, reject, timer });
    try {
      transport(action === 'offer' ? { id, connection, action } : { id, connection, action, sdp: sdp! });
    } catch { close(connection); }
  });
  const runtime: DirectRuntime = { create(connection, events): DirectRuntimeSession {
    if (!transport || sessions.has(connection) || sessions.size >= DIRECT_LINK_MAX_PEERS) throw new Error('DIRECT_RUNTIME_UNAVAILABLE');
    const s = { events, buffered: 0, queue: new Map<number, number>(), sequence: 0, acknowledged: 0, open: false };
    sessions.set(connection, s);
    return {
      offer: () => invoke(connection, 'offer'), accept: (sdp) => invoke(connection, 'accept', sdp),
      answer: async (sdp) => { await invoke(connection, 'answer', sdp); },
      send(text) {
        const bytes = byteLength(text);
        if (sessions.get(connection) !== s || !s.open || !transport || bytes > MAX_FRAME_BYTES
          || s.buffered + [...s.queue.values()].reduce((a, b) => a + b, 0) + bytes > 3 * MAX_FRAME_BYTES) throw new Error('DIRECT_CHANNEL_CLOSED');
        const sequence = ++s.sequence;
        s.queue.set(sequence, bytes);
        try { transport({ id: String(++nextId), action: 'send', connection, text, sequence }); }
        catch (error) { close(connection); throw error; }
      },
      get bufferedAmount() { return s.buffered + [...s.queue.values()].reduce((a, b) => a + b, 0); },
      close: () => close(connection),
    };
  } };
  return {
    runtime,
    attach(send: (command: DirectRuntimeCommand) => void) {
      transport = send;
      return () => {
        if (transport !== send) return;
        transport = undefined;
        for (const connection of sessions.keys()) close(connection, false);
      };
    },
    receive(value: unknown) {
      if (!value || typeof value !== 'object') return;
      const e = value as Record<string, unknown>;
      if (e.type === 'reply' && typeof e.id === 'string') {
        const p = pending.get(e.id);
        if (!p) return;
        pending.delete(e.id); clearTimeout(p.timer);
        if (e.ok === true && (e.value === undefined || (typeof e.value === 'string' && e.value.length <= DIRECT_LINK_MAX_SDP))) p.resolve((e.value as string) ?? '');
        else { p.reject(new Error('DIRECT_RUNTIME_FAILED')); close(p.connection); }
        return;
      }
      if (typeof e.connection !== 'string') return;
      const s = sessions.get(e.connection);
      if (!s) return;
      if (e.type === 'open') { if (!s.open) { s.open = true; s.events.open(); } }
      else if (e.type === 'closed') close(e.connection, false);
      else if (e.type === 'message') {
        if (!s.open || typeof e.text !== 'string' || e.text.length > MAX_FRAME_BYTES || byteLength(e.text) > MAX_FRAME_BYTES) close(e.connection);
        else s.events.message(e.text);
      } else if (e.type === 'buffer' && Number.isSafeInteger(e.sequence) && Number.isFinite(e.buffered)
        && (e.sequence as number) >= s.acknowledged && (e.sequence as number) <= s.sequence
        && (e.buffered as number) >= 0 && (e.buffered as number) <= 8 * MAX_FRAME_BYTES) {
        for (const sequence of s.queue.keys()) if (sequence <= (e.sequence as number)) s.queue.delete(sequence);
        s.acknowledged = e.sequence as number;
        s.buffered = e.buffered as number;
        // IPC/WebView delivery may be synchronous in hosts/tests; don't reenter sendReliableFrames.
        void Promise.resolve().then(() => { if (sessions.get(e.connection as string) === s) s.events.drained(); });
      }
    },
  };
}

/** Runs only in the data-only browser process. Only the host creates connection IDs. */
export function createDirectRuntimeHost(runtime: DirectRuntime, emit: (event: DirectRuntimeEvent) => void) {
  const sessions = new Map<string, { session: DirectRuntimeSession; sequence: number }>();
  const close = (id: string) => { const s = sessions.get(id); sessions.delete(id); s?.session.close(); };
  return {
    async command(c: DirectRuntimeCommand) {
      if (!c || typeof c.connection !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(c.connection) || typeof c.id !== 'string') return;
      try {
        let s = sessions.get(c.connection);
        if (c.action === 'offer' || c.action === 'accept') {
          if (s || sessions.size >= DIRECT_LINK_MAX_PEERS) throw new Error();
          const session = runtime.create(c.connection, {
            open: () => emit({ type: 'open', connection: c.connection }),
            message: (text) => emit({ type: 'message', connection: c.connection, text }),
            drained: () => { const current = sessions.get(c.connection); if (current) emit({ type: 'buffer', connection: c.connection, sequence: current.sequence, buffered: current.session.bufferedAmount }); },
            closed: () => { if (sessions.has(c.connection)) { sessions.delete(c.connection); emit({ type: 'closed', connection: c.connection }); } },
          });
          s = { session, sequence: 0 };
          sessions.set(c.connection, s);
        }
        if (c.action === 'close') { close(c.connection); return; }
        if (!s) throw new Error();
        let value: string | undefined;
        if (c.action === 'offer') value = await s.session.offer();
        else if (c.action === 'accept' || c.action === 'answer') {
          if (typeof c.sdp !== 'string' || !c.sdp || c.sdp.length > DIRECT_LINK_MAX_SDP) throw new Error();
          if (c.action === 'accept') value = await s.session.accept(c.sdp);
          else await s.session.answer(c.sdp);
        } else if (c.action === 'send') {
          if (typeof c.text !== 'string' || byteLength(c.text) > MAX_FRAME_BYTES || c.sequence !== s.sequence + 1) throw new Error();
          s.session.send(c.text);
          s.sequence = c.sequence;
          emit({ type: 'buffer', connection: c.connection, sequence: s.sequence, buffered: s.session.bufferedAmount });
          return;
        } else throw new Error();
        emit({ type: 'reply', id: c.id, ok: true, ...(value ? { value } : {}) });
      } catch {
        emit({ type: 'reply', id: c.id, ok: false });
        close(c.connection);
        emit({ type: 'closed', connection: c.connection });
      }
    },
    dispose() { for (const id of sessions.keys()) close(id); },
  };
}
