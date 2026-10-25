import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import {
  createNodeFilePeerRuntime, parseFilePeerRequest, parseFilePeerFile, canServePeerInvoke,
  FILE_PEER_CHANNEL, FILE_PEER_MAX_BYTES, FILE_PEER_CHUNK_BYTES, FILE_PEER_IDLE_MS,
  FILE_PEER_MAX_CONNECTIONS, FILE_PEER_WRITE_BATCH_BYTES,
  type FilePeerFile, type createNodeDirectRtcRuntime,
  type FilePeerRuntimeBridge,
} from '@cindy/device-link';
import { TerminalRemoteError, type TerminalRemoteContext } from './types.js';

type NativeRtc = Parameters<typeof createNodeDirectRtcRuntime>[0];
export type TerminalFilePeerRuntime = Pick<ReturnType<typeof createNodeFilePeerRuntime>, 'offer'|'accept'|'answer'|'receive'|'close'|'dispose'>;
interface FileSource {
  /** Already-open, authorized handle. Never resolve a remote string as a local path. */
  handle: FileHandle;
  mimeType: string;
  version?: string;
}
export interface TerminalFileSink<T> {
  write(offset: number, bytes: Uint8Array): Promise<void>;
  finish(metadata: FilePeerFile): Promise<T>;
  abort(): Promise<void>;
}
export interface TerminalFilePeerOptions {
  native: NativeRtc;
  createRuntime?(bridge: FilePeerRuntimeBridge): TerminalFilePeerRuntime;
  getOwnerScope(): string | null;
  getIceServers?(): Promise<RTCIceServer[]>;
  /** Performs file URL/owner/workspace authorization before opening the handle. */
  openFile?(url: string, context: TerminalRemoteContext): Promise<FileSource>;
  /** Must re-enter TerminalDeviceService.dispatchLocal, not raw business IPC. */
  invokeAuthorized(channel: string, args: unknown[], context: TerminalRemoteContext): Promise<unknown>;
  invokeRemote(peer: string, channel: string, args: unknown[]): Promise<unknown>;
  attachment?(request: Record<string, unknown>, context: TerminalRemoteContext): Promise<unknown>;
}
interface Connection {
  id: string; peer: string; incoming: boolean; check(): void; remote?: string;
  context?: TerminalRemoteContext; timer?: ReturnType<typeof setTimeout>; closed: boolean;
  opening?: boolean;
  detach?: () => void;
}
interface Source {
  connection: Connection; source: FileSource; size: number; mtime: number; ctime: number;
  offset: number; busy: boolean;
}
interface Sink {
  connection: Connection; size: number; offset: number; busy: boolean;
  write(offset: number, bytes: Uint8Array): Promise<void>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const failure = () => new TerminalRemoteError('FILE_PEER_UNAVAILABLE', 'File connection unavailable');

/** Native files-v1/v2 endpoint. Wire formats and backpressure are shared with
 * existing GUI/Mobile hosts. Filesystem/media ownership remains in the host. */
export class TerminalFilePeerService {
  private readonly connections = new Map<string, Connection>();
  private readonly sources = new Map<string, Source>();
  private readonly sinks = new Map<string, Sink>();
  private readonly runtime: TerminalFilePeerRuntime;

  constructor(private readonly options: TerminalFilePeerOptions) {
    this.runtime = (options.createRuntime ?? (bridge => createNodeFilePeerRuntime(bridge, options.native)))({
      closed: id => this.closeConnection(id),
      read: (id, ticket, offset) => this.read(id, ticket, offset),
      write: (id, offset, value) => this.write(id, offset, value),
      writeBatch: (id, offset, value) => this.write(id, offset, value),
      invoke: (id, payload, body) => this.rpc(id, payload, body),
    });
  }

  async request(value: unknown, context: TerminalRemoteContext): Promise<unknown> {
    context.assertCurrent();
    const request = parseFilePeerRequest(value);
    if (request.action === 'caps') return {
      version: 1, maxBytes: FILE_PEER_MAX_BYTES, streaming: true,
      attachments: !!this.options.attachment, largeAttachments: !!this.options.attachment,
      streamAttachments: !!this.options.attachment, idleMs: FILE_PEER_IDLE_MS,
      sessionBound: false,
    };
    if (request.action === 'offer') {
      const connection = this.track(context.source.peerId, true, () => context.assertCurrent(), context);
      try {
        const servers = await this.options.getIceServers?.() ?? []; connection.check();
        const sdp = await this.runtime.accept(connection.id, servers, request.sdp);
        connection.check(); this.touch(connection);
        return { connection: connection.id, sdp };
      } catch (error) { this.closeConnection(connection.id); throw error; }
    }
    const connection = this.connections.get(request.connection);
    if (!connection?.incoming || connection.peer !== context.source.peerId) throw failure();
    connection.check(); context.assertCurrent(); this.touch(connection);
    if (request.action === 'close') { this.closeConnection(connection.id); return { ok: true }; }
    if (request.action === 'attachment') {
      if (!this.options.attachment) throw failure();
      const result = await this.options.attachment(request.request, context);
      context.assertCurrent(); connection.check(); return result;
    }
    if (!this.options.openFile || connection.opening || [...this.sources.values()].some(source => source.connection === connection)) throw failure();
    connection.opening = true;
    let source: FileSource | undefined;
    try {
      source = await this.options.openFile(request.url, context);
      context.assertCurrent(); connection.check();
      const stat = await source.handle.stat();
      context.assertCurrent(); connection.check();
      if (!stat.isFile() || stat.size > FILE_PEER_MAX_BYTES || !/^[\w.+-]+\/[\w.+-]+$/.test(source.mimeType)) throw failure();
      const ticket = randomUUID();
      this.sources.set(ticket, { connection, source, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, offset: 0, busy: false });
      return { ticket, size: stat.size, mimeType: source.mimeType, ...(source.version ? { version: source.version } : {}) };
    } catch (error) { await source?.handle.close().catch(() => {}); throw error; }
    finally { connection.opening = false; }
  }

  /** A caller supplies its existing storage sink. No new media/cache directory
   * is created here. A successful sink owns its retained bytes; failure aborts. */
  async receive<T>(peer: string, url: string, makeSink: (metadata: FilePeerFile) => Promise<TerminalFileSink<T>>,
    signal?: AbortSignal): Promise<T> {
    const owner = this.options.getOwnerScope();
    if (!owner) throw failure();
    const check = () => {
      if (signal?.aborted || this.options.getOwnerScope() !== owner) throw failure();
    };
    check();
    const connection = this.track(peer, false, check);
    const cancel = () => this.closeConnection(connection.id);
    signal?.addEventListener('abort', cancel, { once: true });
    let sink: TerminalFileSink<T> | undefined;
    let retained = false;
    try {
      const caps = await this.options.invokeRemote(peer, FILE_PEER_CHANNEL, [{ action: 'caps' }]);
      connection.check();
      if (!object(caps) || caps.version !== 1) throw failure();
      const servers = await this.options.getIceServers?.() ?? []; connection.check();
      const offer = await this.runtime.offer(connection.id, servers, caps.streaming === true);
      connection.check();
      const accepted = await this.options.invokeRemote(peer, FILE_PEER_CHANNEL, [{ action: 'offer', sdp: offer }]);
      connection.check();
      if (!object(accepted) || typeof accepted.connection !== 'string' || !/^[a-f0-9-]{36}$/.test(accepted.connection)
        || typeof accepted.sdp !== 'string' || accepted.sdp.length > 128 * 1024) throw failure();
      connection.remote = accepted.connection;
      await this.runtime.answer(connection.id, accepted.sdp); connection.check();
      const metadata = parseFilePeerFile(await this.options.invokeRemote(peer, FILE_PEER_CHANNEL,
        [{ action: 'open', connection: connection.remote, url }]));
      connection.check();
      sink = await makeSink(metadata); connection.check();
      const sinkId = randomUUID();
      const state: Sink = { connection, size: metadata.size, offset: 0, busy: false, write: sink.write.bind(sink) };
      this.sinks.set(sinkId, state);
      await this.runtime.receive(connection.id, metadata.ticket, metadata.size, sinkId);
      connection.check();
      if (state.offset !== metadata.size) throw failure();
      const result = await sink.finish(metadata); connection.check(); retained = true;
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (sink && !retained) await sink.abort().catch(() => {});
      if (connection.remote && this.options.getOwnerScope() === owner) void this.options.invokeRemote(peer, FILE_PEER_CHANNEL,
        [{ action: 'close', connection: connection.remote }]).catch(() => {});
      this.closeConnection(connection.id);
    }
  }

  stop(peer?: string): void {
    for (const connection of [...this.connections.values()]) if (!peer || connection.peer === peer) this.closeConnection(connection.id);
    if (!peer) this.runtime.dispose();
  }

  private track(peer: string, incoming: boolean, guard: () => void, context?: TerminalRemoteContext): Connection {
    guard();
    if (this.connections.size >= FILE_PEER_MAX_CONNECTIONS) throw failure();
    const connection: Connection = { id: randomUUID(), peer, incoming, closed: false, context,
      check: () => { guard(); if (connection.closed || this.connections.get(connection.id) !== connection) throw failure(); } };
    this.connections.set(connection.id, connection);
    if (context) {
      const cancel = () => this.closeConnection(connection.id);
      context.signal.addEventListener('abort', cancel, { once: true });
      connection.detach = () => context.signal.removeEventListener('abort', cancel);
    }
    this.touch(connection); return connection;
  }
  private touch(connection: Connection): void {
    connection.check(); clearTimeout(connection.timer);
    connection.timer = setTimeout(() => this.closeConnection(connection.id), FILE_PEER_IDLE_MS);
    connection.timer.unref?.();
  }
  private closeConnection(id: string): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id); connection.closed = true;
    clearTimeout(connection.timer); connection.detach?.();
    this.runtime.close(id);
    for (const [ticket, source] of this.sources) if (source.connection === connection) {
      this.sources.delete(ticket); void source.source.handle.close().catch(() => {});
    }
    for (const [sink, value] of this.sinks) if (value.connection === connection) this.sinks.delete(sink);
  }
  private async read(id: string, ticket: string, offset: number): Promise<string> {
    const source = this.sources.get(ticket);
    if (!source || source.connection.id !== id || source.busy || source.offset !== offset) throw failure();
    source.connection.check(); this.touch(source.connection); source.busy = true;
    try {
      const stat = await source.source.handle.stat(); source.connection.check();
      if (stat.size !== source.size || stat.mtimeMs !== source.mtime || stat.ctimeMs !== source.ctime) throw failure();
      const bytes = Buffer.alloc(Math.min(FILE_PEER_CHUNK_BYTES, source.size - offset));
      if (bytes.length && (await source.source.handle.read(bytes, 0, bytes.length, offset)).bytesRead !== bytes.length) throw failure();
      source.connection.check(); source.offset += bytes.length; this.touch(source.connection);
      if (!bytes.length) { this.sources.delete(ticket); await source.source.handle.close(); }
      return bytes.toString('base64');
    } finally { source.busy = false; }
  }
  private async write(id: string, offset: number, value: string): Promise<void> {
    const sink = this.sinks.get(id);
    if (!sink || sink.busy || offset !== sink.offset || value.length > Math.ceil(FILE_PEER_WRITE_BATCH_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw failure();
    const bytes = Buffer.from(value, 'base64');
    if (sink.offset + bytes.length > sink.size) throw failure();
    sink.connection.check(); this.touch(sink.connection); sink.busy = true;
    try {
      await sink.write(offset, bytes); sink.connection.check(); sink.offset += bytes.length;
    } finally { sink.busy = false; }
  }
  private async rpc(id: string, text: string, body?: Uint8Array): Promise<string> {
    const connection = this.connections.get(id);
    if (!connection?.incoming || !connection.context || text.length > 4 * 1024 * 1024) throw failure();
    connection.check(); this.touch(connection);
    const payload: unknown = JSON.parse(text);
    if (!object(payload) || typeof payload.channel !== 'string' || !Array.isArray(payload.args)
      || !canServePeerInvoke(payload.channel, payload.args)) throw failure();
    if (body) {
      const arg = payload.args[0];
      if (payload.channel !== FILE_PEER_CHANNEL || !object(arg) || !object(arg.request)
        || arg.request.op !== 'write' || arg.request.data !== undefined) throw failure();
      arg.request.data = Buffer.from(body);
    }
    try {
      const result = await this.options.invokeAuthorized(payload.channel, payload.args, connection.context);
      connection.check();
      return JSON.stringify({ ok: true, result });
    } catch { connection.check(); return JSON.stringify({ ok: false, error: { code: 'IPC_ERROR', message: 'FILE_PEER_UNAVAILABLE' } }); }
  }
}
