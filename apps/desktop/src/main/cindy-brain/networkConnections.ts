import { randomUUID } from 'node:crypto';
import type { Agent } from 'node:http';
import WebSocket from 'ws';
import type { GhostNetworkEvent, GhostPipeNetworkResult } from '../../shared/ghost.js';

const CHUNK_BYTES = 64 * 1024;
const BUFFER_BYTES = 1024 * 1024;
const IDLE_MS = 5 * 60_000;

interface Connection {
  id: string;
  owner: string;
  assertCurrent(): void;
  events: GhostNetworkEvent[];
  bytes: number;
  sequence: number;
  closed: boolean;
  disposed: boolean;
  waiters: Set<() => void>;
  timer?: NodeJS.Timeout;
  socket?: WebSocket;
  stop(): void;
  detach(): void;
}

/** Host-owned live connections. Both launchers use this same cursor buffer and
 * lifetime implementation; transports never receive credentials or authority. */
export class HostNetworkConnections {
  private readonly entries = new Map<string, Connection>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly limit: number) {}

  count(owner: string): number {
    return [...this.entries.values()].filter(entry => entry.owner === owner).length;
  }

  private create(owner: string, assertCurrent: () => void, signal?: AbortSignal): Connection {
    assertCurrent();
    signal?.throwIfAborted();
    if (this.count(owner) >= this.limit) throw new Error('NETWORK_CONNECTION_LIMIT');
    const entry: Connection = {
      id: randomUUID(), owner, assertCurrent, events: [], bytes: 0, sequence: 0,
      closed: false, disposed: false, waiters: new Set(), stop: () => {}, detach: () => {},
    };
    const abort = () => this.remove(entry);
    signal?.addEventListener('abort', abort, { once: true });
    entry.detach = () => signal?.removeEventListener('abort', abort);
    this.entries.set(entry.id, entry);
    this.touch(entry);
    return entry;
  }

  private touch(entry: Connection): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.remove(entry), IDLE_MS);
    entry.timer.unref?.();
  }

  private wake(entry: Connection): void {
    for (const wake of [...entry.waiters]) wake();
  }

  private append(entry: Connection, event: Omit<GhostNetworkEvent, 'sequence'>): void {
    if (entry.disposed) return;
    try { entry.assertCurrent(); } catch { this.remove(entry); return; }
    const next = { ...event, sequence: ++entry.sequence };
    entry.events.push(next);
    entry.bytes += Buffer.byteLength(event.data ?? '', 'utf8');
    while (entry.bytes > BUFFER_BYTES || entry.events.length > 256) {
      const first = entry.events.shift()!;
      entry.bytes -= Buffer.byteLength(first.data ?? '', 'utf8');
    }
    this.wake(entry);
  }

  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
  }

  private remove(entry: Connection): void {
    if (entry.disposed) return;
    entry.disposed = true;
    this.entries.delete(entry.id);
    clearTimeout(entry.timer);
    entry.detach();
    entry.stop();
    this.wake(entry);
  }

  adoptStream(owner: string, input: {
    body: ReadableStream<Uint8Array> | null;
    assertCurrent(): void;
    signal?: AbortSignal;
    release(): Promise<void>;
  }): string {
    const entry = this.create(owner, input.assertCurrent, input.signal);
    const reader = input.body?.getReader();
    entry.stop = () => { this.track(reader?.cancel().catch(() => {}) ?? Promise.resolve()); };
    const pump = async () => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        while (reader && !entry.disposed) {
          entry.assertCurrent();
          const chunk = await reader.read();
          if (entry.disposed) break;
          entry.assertCurrent();
          if (chunk.done) break;
          for (let offset = 0; offset < chunk.value.byteLength; offset += CHUNK_BYTES) {
            const text = decoder.decode(chunk.value.subarray(offset, offset + CHUNK_BYTES), { stream: true });
            if (text) this.append(entry, { type: 'text', data: text });
          }
        }
        if (!entry.disposed) {
          const last = decoder.decode();
          if (last) this.append(entry, { type: 'text', data: last });
          entry.closed = true;
          this.append(entry, { type: 'end' });
        }
      } catch {
        entry.closed = true;
        this.append(entry, { type: 'error', errorCode: 'NETWORK_STREAM_FAILED' });
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
        await input.release();
      }
    };
    this.track(pump());
    return entry.id;
  }

  async openWebSocket(owner: string, input: {
    url: string;
    headers: Record<string, string>;
    protocols?: string[];
    agent?(): Promise<Agent | undefined>;
    assertCurrent(): void;
    signal?: AbortSignal;
  }): Promise<string> {
    const entry = this.create(owner, input.assertCurrent, input.signal);
    try {
      const agent = await input.agent?.();
      entry.assertCurrent();
      if (entry.disposed) throw new Error('NETWORK_CONNECTION_UNAVAILABLE');
      const socket = new WebSocket(input.url, input.protocols ?? [], {
        headers: input.headers, agent, followRedirects: false,
        handshakeTimeout: 30_000, maxPayload: CHUNK_BYTES, perMessageDeflate: false,
      });
      entry.socket = socket;
      entry.stop = () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        this.track(new Promise<void>(resolve => socket.once('close', () => resolve())));
        socket.terminate();
      };
      socket.on('message', (data, binary) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        this.append(entry, { type: binary ? 'binary' : 'text', data: bytes.toString(binary ? 'base64' : 'utf8') });
      });
      socket.on('close', code => {
        entry.closed = true;
        this.append(entry, { type: 'end', code });
      });
      socket.on('error', () => {
        entry.closed = true;
        this.append(entry, { type: 'error', errorCode: 'NETWORK_WEBSOCKET_FAILED' });
      });
      await new Promise<void>((resolve, reject) => {
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('NETWORK_WEBSOCKET_FAILED')); };
        const cleanup = () => { socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); };
        socket.once('open', opened); socket.once('error', failed); socket.once('close', failed);
      });
      entry.assertCurrent();
      if (entry.disposed) throw new Error('NETWORK_CONNECTION_UNAVAILABLE');
      return entry.id;
    } catch (error) {
      this.remove(entry);
      throw error;
    }
  }

  async handle(owner: string, payload: Record<string, unknown>): Promise<GhostPipeNetworkResult> {
    const entry = typeof payload.connectionId === 'string' ? this.entries.get(payload.connectionId) : undefined;
    if (!entry || entry.owner !== owner) return { ok: false, errorCode: 'NETWORK_CONNECTION_UNAVAILABLE', message: '连接不存在或已失效' };
    const invalid = (): GhostPipeNetworkResult => ({ ok: false, errorCode: 'NETWORK_INVALID_REQUEST', message: '连接请求参数不合法' });
    try {
      entry.assertCurrent();
      this.touch(entry);
      if (payload.op === 'close') {
        this.remove(entry);
        return { ok: true };
      }
      if (payload.op === 'send') {
        if (!entry.socket || entry.socket.readyState !== WebSocket.OPEN || entry.closed) return { ok: false, errorCode: 'NETWORK_CONNECTION_CLOSED', message: '连接已关闭或不支持发送' };
        if (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > CHUNK_BYTES) return invalid();
        if (payload.binary !== undefined && typeof payload.binary !== 'boolean') return invalid();
        if (payload.binary === true && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.data)) return invalid();
        if (entry.socket.bufferedAmount > BUFFER_BYTES) return { ok: false, errorCode: 'NETWORK_BUSY', message: '连接发送缓冲区正忙' };
        await new Promise<void>((resolve, reject) => entry.socket!.send(payload.binary === true ? Buffer.from(payload.data as string, 'base64') : payload.data as string,
          { binary: payload.binary === true }, error => error ? reject(error) : resolve()));
        entry.assertCurrent();
        if (entry.disposed) throw new Error('NETWORK_CONNECTION_UNAVAILABLE');
        return { ok: true };
      }
      if (payload.op !== 'read') return invalid();
      const cursor = payload.cursor ?? 0;
      const waitMs = payload.waitMs ?? 0;
      if (!Number.isSafeInteger(cursor) || (cursor as number) < 0 || (cursor as number) > entry.sequence ||
          typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 20_000) return invalid();
      if (entry.sequence <= (cursor as number) && !entry.closed && waitMs > 0) {
        if (entry.waiters.size >= this.limit) return { ok: false, errorCode: 'NETWORK_BUSY', message: '连接读取正忙' };
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); entry.waiters.delete(wake); resolve(); };
          const timer = setTimeout(wake, waitMs); timer.unref?.(); entry.waiters.add(wake);
        });
      }
      entry.assertCurrent();
      if (entry.disposed) throw new Error('NETWORK_CONNECTION_UNAVAILABLE');
      const events: GhostNetworkEvent[] = [];
      let bytes = 0;
      for (const event of entry.events) {
        if (event.sequence <= (cursor as number)) continue;
        bytes += Buffer.byteLength(event.data ?? '');
        if (events.length && bytes > CHUNK_BYTES * 2) break;
        events.push(event);
      }
      const nextCursor = events.at(-1)?.sequence ?? cursor as number;
      return { ok: true, events, nextCursor,
        closed: entry.closed && nextCursor === entry.sequence, resetRequired: (cursor as number) < (entry.events[0]?.sequence ?? 1) - 1 };
    } catch {
      this.remove(entry);
      return { ok: false, errorCode: 'NETWORK_CONNECTION_UNAVAILABLE', message: '连接或调用身份已失效' };
    }
  }

  disposeGhost(owner: string): void {
    for (const entry of [...this.entries.values()]) if (entry.owner === owner) this.remove(entry);
  }

  async disposeAll(): Promise<void> {
    for (const entry of [...this.entries.values()]) this.remove(entry);
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
