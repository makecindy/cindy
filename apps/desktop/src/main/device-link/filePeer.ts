import { app, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  FILE_PEER_CHUNK_BYTES,
  FILE_PEER_MAX_BYTES,
  FILE_PEER_CHANNEL,
  parseFilePeerRequest,
  parseFilePeerFile,
  type FilePeerFile,
} from '@cindy/device-link';
import { FILE_PEER_LOCAL, type FilePeerCommand } from '../../shared/filePeer';
import { DesktopCaptureWindow } from '../remote-desktop/captureWindow';
import { loadDesktopIceServers } from '../remote-desktop/iceConfig';
import { resolveAuthorizedMedia } from './mediaFetch';
import { readDeviceLinkSettings } from './settings-store';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';

type Owner = ReturnType<typeof captureDataOwnerBroadcastScope>;
interface Connection {
  peer: string;
  owner: Owner;
  timer: ReturnType<typeof setTimeout>;
  incoming: boolean;
  opening?: boolean;
}
interface Source {
  connection: string;
  file: FileHandle;
  size: number;
  mtime: number;
  offset: number;
  busy: boolean;
}
interface Sink {
  connection: string;
  file: FileHandle;
  size: number;
  offset: number;
  busy: boolean;
}
interface Outgoing {
  id: string;
  remote?: string;
  busy: boolean;
  invoke: Invoke;
}
const outgoing = new Map<string, Outgoing>();
const connections = new Map<string, Connection>();
const sources = new Map<string, Source>();
const sinks = new Map<string, Sink>();
const replies = new Map<
  string,
  {
    connection: string;
    resolve(value?: string): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const host = new DesktopCaptureWindow(() => stopFilePeers(), 'files');
let starting: Promise<void> | null = null;

function touch(id: string) {
  const c = connections.get(id);
  if (!c || !isDataOwnerBroadcastScopeCurrent(c.owner)) throw new Error('FILE_PEER_CLOSED');
  const settings = readDeviceLinkSettings();
  if (
    c.incoming &&
    (!settings.remoteControlEnabled || settings.revokedControllers.includes(c.peer))
  ) {
    stopConnection(id);
    throw new Error('FILE_PEER_REVOKED');
  }
  clearTimeout(c.timer);
  c.timer = setTimeout(() => stopConnection(id), 30_000);
  c.timer.unref();
  return c;
}
function track(id: string, peer: string, incoming: boolean) {
  if (connections.size >= 4) throw new Error('FILE_PEER_BUSY');
  const timer = setTimeout(() => stopConnection(id), 30_000);
  timer.unref();
  connections.set(id, { peer, incoming, owner: captureDataOwnerBroadcastScope(), timer });
}
function stopConnection(id: string) {
  const c = connections.get(id);
  if (!c) return;
  connections.delete(id);
  clearTimeout(c.timer);
  const out = outgoing.get(c.peer);
  if (out?.id === id) {
    outgoing.delete(c.peer);
    if (out.remote && isDataOwnerBroadcastScopeCurrent(c.owner))
      void out
        .invoke(c.peer, FILE_PEER_CHANNEL, [{ action: 'close', connection: out.remote }])
        .catch(() => {});
  }
  for (const [ticket, source] of sources)
    if (source.connection === id) {
      sources.delete(ticket);
      void source.file.close().catch(() => {});
    }
  for (const [ticket, sink] of sinks)
    if (sink.connection === id) {
      sinks.delete(ticket);
      void sink.file.close().catch(() => {});
    }
  if (host.contents && !host.contents.isDestroyed())
    host.contents.send(FILE_PEER_LOCAL.COMMAND, randomUUID(), { action: 'close', connection: id });
  for (const [key, p] of replies)
    if (p.connection === id) {
      replies.delete(key);
      clearTimeout(p.timer);
      p.reject(new Error('FILE_PEER_CLOSED'));
    }
  if (!connections.size) {
    host.dispose();
    for (const p of replies.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('FILE_PEER_CLOSED'));
    }
    replies.clear();
  }
}
export function stopFilePeers(peer?: string) {
  for (const [id, c] of connections) if (!peer || peer === c.peer) stopConnection(id);
}
async function command(c: FilePeerCommand): Promise<string | undefined> {
  touch(c.connection);
  if (!host.contents) {
    if (!starting)
      starting = host.start().finally(() => {
        starting = null;
      });
    await starting;
  } else if (starting) await starting;
  touch(c.connection);
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(
      () => {
        replies.delete(id);
        stopConnection(c.connection);
        reject(new Error('FILE_PEER_TIMEOUT'));
      },
      c.action === 'receive' ? 600_000 : 15_000,
    );
    timer.unref();
    replies.set(id, { connection: c.connection, resolve, reject, timer });
    host.contents!.send(FILE_PEER_LOCAL.COMMAND, id, c);
  });
}

export async function requestFilePeer(peer: string, value: unknown): Promise<unknown> {
  const r = parseFilePeerRequest(value);
  if (r.action === 'caps') return { version: 1 };
  if (r.action === 'offer') {
    const id = randomUUID();
    track(id, peer, true);
    try {
      const sdp = await command({
        action: 'accept',
        connection: id,
        servers: await loadDesktopIceServers(),
        sdp: r.sdp,
      });
      return { connection: id, sdp };
    } catch (error) {
      stopConnection(id);
      throw error;
    }
  }
  const c = touch(r.connection);
  if (!c.incoming || c.peer !== peer) throw new Error('FILE_PEER_DENIED');
  if (r.action === 'close') {
    stopConnection(r.connection);
    return { ok: true };
  }
  if (c.opening || [...sources.values()].some((s) => s.connection === r.connection))
    throw new Error('FILE_PEER_BUSY');
  c.opening = true;
  try {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const authorized = await Promise.race([
      resolveAuthorizedMedia({ url: r.url }, FILE_PEER_MAX_BYTES),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          stopConnection(r.connection);
          reject(new Error('FILE_PEER_TIMEOUT'));
        }, 20_000);
        deadline.unref();
      }),
    ]).finally(() => clearTimeout(deadline));
    touch(r.connection);
    const file = await fs.open(
      authorized.absPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await file.stat();
      touch(r.connection);
      if (!stat.isFile() || stat.size > (authorized.maxBytes ?? FILE_PEER_MAX_BYTES))
        throw new Error('FILE_PEER_SIZE');
      const ticket = randomUUID();
      const ext = (authorized.uploadExtHint ?? path.extname(authorized.absPath)).toLowerCase();
      const mimeType =
        authorized.mimeType ??
        (
          {
            '.html': 'text/html',
            '.htm': 'text/html',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.gif': 'image/gif',
            '.pdf': 'application/pdf',
          } as Record<string, string>
        )[ext] ??
        'application/octet-stream';
      sources.set(ticket, {
        connection: r.connection,
        file,
        size: stat.size,
        mtime: stat.mtimeMs,
        offset: 0,
        busy: false,
      });
      return { ticket, size: stat.size, mimeType };
    } catch (error) {
      await file.close();
      throw error;
    }
  } finally {
    c.opening = false;
  }
}

export function registerFilePeerIpc() {
  ipcMain.handle(FILE_PEER_LOCAL.REGISTER, (e) => host.registered(e));
  ipcMain.handle(FILE_PEER_LOCAL.REPLY, (e, id: unknown, ok: unknown, value: unknown) => {
    host.assertSender(e);
    if (
      typeof id !== 'string' ||
      typeof ok !== 'boolean' ||
      (value !== undefined && (typeof value !== 'string' || value.length > 128 * 1024))
    )
      throw new Error('FILE_PEER_REPLY');
    const pending = replies.get(id);
    if (!pending) return;
    replies.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(value as string | undefined);
    else pending.reject(new Error('FILE_PEER_UNAVAILABLE'));
  });
  ipcMain.handle(
    FILE_PEER_LOCAL.READ,
    async (e, connection: unknown, ticket: unknown, offset: unknown) => {
      host.assertSender(e);
      if (
        typeof connection !== 'string' ||
        typeof ticket !== 'string' ||
        !Number.isSafeInteger(offset)
      )
        throw new Error('FILE_PEER_BLOCK');
      const s = sources.get(ticket);
      if (!s || s.connection !== connection || s.busy || offset !== s.offset)
        throw new Error('FILE_PEER_BLOCK');
      touch(connection);
      s.busy = true;
      try {
        const stat = await s.file.stat();
        if (stat.size !== s.size || stat.mtimeMs !== s.mtime) throw new Error('FILE_PEER_CHANGED');
        const bytes = Buffer.alloc(Math.min(FILE_PEER_CHUNK_BYTES, s.size - s.offset));
        if (bytes.length) {
          const read = await s.file.read(bytes, 0, bytes.length, s.offset);
          if (read.bytesRead !== bytes.length) throw new Error('FILE_PEER_CHANGED');
        }
        touch(connection);
        if (sources.get(ticket) !== s) throw new Error('FILE_PEER_CLOSED');
        s.offset += bytes.length;
        if (!bytes.length) {
          sources.delete(ticket);
          await s.file.close();
        }
        return bytes.toString('base64');
      } catch (error) {
        stopConnection(connection);
        throw error;
      } finally {
        s.busy = false;
      }
    },
  );
  ipcMain.handle(
    FILE_PEER_LOCAL.WRITE,
    async (e, id: unknown, offset: unknown, base64: unknown) => {
      host.assertSender(e);
      if (typeof id !== 'string' || typeof base64 !== 'string' || base64.length > 22000)
        throw new Error('FILE_PEER_BLOCK');
      const s = sinks.get(id),
        bytes = Buffer.from(base64, 'base64');
      if (
        !s ||
        s.busy ||
        offset !== s.offset ||
        bytes.length > FILE_PEER_CHUNK_BYTES ||
        s.offset + bytes.length > s.size ||
        bytes.toString('base64') !== base64
      )
        throw new Error('FILE_PEER_BLOCK');
      touch(s.connection);
      s.busy = true;
      try {
        const written = await s.file.write(bytes, 0, bytes.length, s.offset);
        touch(s.connection);
        if (written.bytesWritten !== bytes.length || sinks.get(id) !== s)
          throw new Error('FILE_PEER_CLOSED');
        s.offset += bytes.length;
      } finally {
        s.busy = false;
      }
    },
  );
  app.on('before-quit', () => stopFilePeers());
}

type Invoke = (
  peer: string,
  channel: string,
  args: unknown[],
) => Promise<{ ok: boolean; result?: unknown }>;
/** A caller owns the returned temporary file and must dispose it after consuming it. */
export async function tryPeerFile(peer: string, url: string, invoke: Invoke, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
  const owner = captureDataOwnerBroadcastScope();
  let out = outgoing.get(peer);
  if (out?.busy) return null;
  if (!out) {
    out = { id: randomUUID(), busy: false, invoke };
    outgoing.set(peer, out);
  }
  out.busy = true;
  const id = out.id;
  let remote = out.remote,
    directory: string | undefined,
    complete = false;
  const cancel = () => stopConnection(id);
  try {
    signal?.addEventListener('abort', cancel, { once: true });
    if (!remote) {
      const caps = await invoke(peer, FILE_PEER_CHANNEL, [{ action: 'caps' }]);
      if (signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner))
        throw new Error('FILE_PEER_CANCELLED');
      if (!caps.ok || (caps.result as { version?: unknown })?.version !== 1) return null;
      track(id, peer, false);
      const offer = await command({
        action: 'offer',
        connection: id,
        servers: await loadDesktopIceServers(),
      });
      const response = await invoke(peer, FILE_PEER_CHANNEL, [{ action: 'offer', sdp: offer }]);
      const r = response.result as { connection?: string; sdp?: string };
      if (
        !response.ok ||
        !r ||
        typeof r.connection !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(r.connection) ||
        typeof r.sdp !== 'string' ||
        r.sdp.length > 128 * 1024
      )
        throw new Error('FILE_PEER_ANSWER');
      remote = r.connection;
      out.remote = remote;
      await command({ action: 'answer', connection: id, sdp: r.sdp });
    }
    touch(id);
    const opened = await invoke(peer, FILE_PEER_CHANNEL, [
      { action: 'open', connection: remote, url },
    ]);
    if (!opened.ok) throw new Error('FILE_PEER_OPEN');
    const file: FilePeerFile = parseFilePeerFile(opened.result);
    touch(id);
    directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'cindy-file-peer-'));
    const destination = path.join(directory, 'file');
    const handle = await fs.open(destination, 'wx', 0o600),
      sink = randomUUID();
    sinks.set(sink, { connection: id, file: handle, offset: 0, size: file.size, busy: false });
    try {
      await command({
        action: 'receive',
        connection: id,
        ticket: file.ticket,
        size: file.size,
        sink,
      });
      if (
        sinks.get(sink)?.offset !== file.size ||
        signal?.aborted ||
        !isDataOwnerBroadcastScopeCurrent(owner)
      )
        throw new Error('FILE_PEER_SIZE');
    } finally {
      sinks.delete(sink);
      await handle.close().catch(() => {});
    }
    if (signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner))
      throw new Error('FILE_PEER_CLOSED');
    touch(id);
    const ownedDirectory = directory;
    directory = undefined;
    complete = true;
    return {
      path: destination,
      size: file.size,
      mimeType: file.mimeType,
      dispose: () => fs.rm(ownedDirectory, { recursive: true, force: true }),
    };
  } catch {
    if (signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner))
      throw new Error('FILE_PEER_CANCELLED');
    return null;
  } finally {
    signal?.removeEventListener('abort', cancel);
    out.busy = false;
    if (!complete) {
      stopConnection(id);
      if (outgoing.get(peer) === out) outgoing.delete(peer);
      if (remote && isDataOwnerBroadcastScopeCurrent(owner))
        void invoke(peer, FILE_PEER_CHANNEL, [{ action: 'close', connection: remote }]).catch(
          () => {},
        );
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}
