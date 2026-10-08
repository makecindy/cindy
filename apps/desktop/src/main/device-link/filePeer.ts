import { app, ipcMain } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  createFileReadQueue,
  createPeerTransferCooldown,
  canUsePeerInvoke,
  canServePeerInvoke,
  type InvokeResultPayload,
  uploadPeerAttachment,
  FILE_PEER_CHUNK_BYTES,
  FILE_PEER_MAX_BYTES,
  RPC_BODY_MAX_BYTES,
  canSendPeerAttachment,
  FILE_PEER_IDLE_MS,
  FILE_PEER_CHANNEL,
  parseFilePeerRequest,
  parseFilePeerFile,
  type FilePeerFile,
  type FilePeerRequest,
} from '@cindy/device-link';
import { FILE_PEER_LOCAL, type FilePeerCommand } from '../../shared/filePeer';
import { DesktopCaptureWindow } from '../remote-desktop/captureWindow';
import { loadDesktopIceServers } from '../remote-desktop/iceConfig';
import { resolveAuthorizedMedia } from './mediaFetch';
import { readDeviceLinkSettings } from './settings-store';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';
import { createLogger } from '../logger.js';
import { handlePeerAttachment } from './peerAttachmentStore';

// Local-only diagnostics (scope is not upload-allowlisted): stages, sizes and timings, never paths.
const log = createLogger('device-link:filePeer');
const short = (id: string | undefined) => (id ?? '?').slice(0, 8);
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

type Owner = ReturnType<typeof captureDataOwnerBroadcastScope>;
interface Connection {
  peer: string;
  owner: Owner;
  timer: ReturnType<typeof setTimeout>;
  incoming: boolean;
  opening?: boolean;
  invoke?: (channel: string, args: unknown[]) => Promise<unknown>;
}
interface Source {
  connection: string;
  file: FileHandle;
  size: number;
  mtime: number;
  offset: number;
  busy: boolean;
  openedAt: number;
}
interface Sink {
  connection: string;
  file: FileHandle;
  size: number;
  offset: number;
  busy: boolean;
  reportProgress(): void;
}
interface Outgoing {
  id: string;
  remote?: string;
  busy: boolean;
  invoke: Invoke;
  rpc?: boolean;
  attachments?: boolean;
  /** 对端接收直连附件不设固定上限(只看磁盘空间);旧端仍按 OSS 上限拒收更大的附件。 */
  largeAttachments?: boolean;
  /** 对端接受多块在途与二进制写入;旧端仍逐块等确认、按 base64 发送。 */
  streamAttachments?: boolean;
}
const outgoing = new Map<string, Outgoing>();
const cooldown = createPeerTransferCooldown();
let cooldownOwner: Owner | undefined;
function refreshCooldownOwner() {
  if (!cooldownOwner || !isDataOwnerBroadcastScopeCurrent(cooldownOwner)) {
    cooldown.clear();
    cooldownOwner = captureDataOwnerBroadcastScope();
  }
}
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
    /** Diagnostics probe: transfer progress must never refresh its timeout. */
    probe?: boolean;
  }
>();
const host = new DesktopCaptureWindow(() => stopFilePeers(), 'files');
let starting: Promise<void> | null = null;
/** Transfers slower than one sample interval log runtime stats once per interval. */
const PROGRESS_SAMPLE_MS = 1_000;
/** After EOF, keep sampling until the data channel buffer drains, at most this long. */
const DRAIN_SAMPLE_MS = 30_000;
const monitors = new Map<string, { connection: string; stop(): void }>();

/**
 * Diagnostics-only stats probe. Unlike command(), it neither renews the idle timer nor
 * stops the connection on timeout, and its pending entry is marked `probe` so transfer
 * chunks cannot stretch the 5s budget. Sampling can neither keep alive nor break a
 * transfer.
 */
function probeStats(connection: string): Promise<string | null> {
  if (!connections.has(connection) || !host.contents || host.contents.isDestroyed())
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      replies.delete(id);
      resolve(null);
    }, 5_000);
    timer.unref();
    replies.set(id, {
      connection,
      resolve: (value) => resolve(value ?? null),
      reject: () => resolve(null),
      timer,
      probe: true,
    });
    try {
      host.contents!.send(FILE_PEER_LOCAL.COMMAND, id, { action: 'stats', connection });
    } catch {
      replies.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
}
function bufferedAmountOf(stats: string | null): number | null {
  try {
    const value = stats ? JSON.parse(stats)?.channel?.bufferedAmount : undefined;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}
function startMonitor(key: string, connection: string, sample: () => Promise<boolean>) {
  monitors.get(key)?.stop();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sample()
      .then((keep) => {
        if (!keep) stop();
      }, stop)
      .finally(() => {
        busy = false;
      });
  }, PROGRESS_SAMPLE_MS);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    if (monitors.get(key)?.stop === stop) monitors.delete(key);
  };
  monitors.set(key, { connection, stop });
  return stop;
}
/** Host → controller send: progress while reading, then SCTP buffer drain after EOF. */
function monitorSend(ticket: string, s: Source) {
  const tag = `conn=${short(s.connection)}`;
  // Only one file drains a connection at a time: bufferedAmount covers the whole
  // channel, so a previous file's monitor cannot attribute the next transfer's
  // buffered bytes once its send starts.
  for (const [key, monitor] of [...monitors])
    if (key.startsWith('send:') && monitor.connection === s.connection) {
      log.debug(`send drain superseded ${tag} ticket=${short(ticket)}`);
      monitor.stop();
    }
  void probeStats(s.connection).then((stats) =>
    log.debug(`send start ${tag} size=${s.size} stats=${stats ?? 'unavailable'}`),
  );
  let eofAt: number | undefined;
  startMonitor(`send:${ticket}`, s.connection, async () => {
    if (sources.get(ticket) !== s) {
      // Closed before EOF: stopConnection already logged the unfinished byte count.
      if (s.offset < s.size || !connections.has(s.connection)) return false;
      eofAt ??= Date.now();
    }
    const stats = await probeStats(s.connection);
    const now = Date.now();
    if (!stats) {
      // One failed probe skips its sample only; monitoring continues while the
      // transfer (or the bounded drain phase) is still active.
      if (eofAt !== undefined && now - eofAt >= DRAIN_SAMPLE_MS) {
        log.debug(`send drain unobserved ${tag} buffered=unknown afterEofMs=${now - eofAt}`);
        return false;
      }
      return true;
    }
    log.debug(
      `send progress ${tag} sent=${s.offset}/${s.size}B elapsedMs=${now - s.openedAt}` +
        (eofAt === undefined ? '' : ` afterEofMs=${now - eofAt}`) +
        ` stats=${stats}`,
    );
    if (eofAt === undefined) return true;
    const buffered = bufferedAmountOf(stats);
    if (buffered === 0) {
      log.debug(`send drained ${tag} ms=${now - s.openedAt} afterEofMs=${now - eofAt}`);
      return false;
    }
    if (buffered === null || now - eofAt >= DRAIN_SAMPLE_MS) {
      log.debug(
        `send drain unobserved ${tag} buffered=${buffered ?? 'unknown'} afterEofMs=${now - eofAt}`,
      );
      return false;
    }
    return true;
  });
}

function touch(id: string) {
  const c = connections.get(id);
  if (!c || !isDataOwnerBroadcastScopeCurrent(c.owner)) throw new Error('FILE_PEER_CLOSED');
  const settings = readDeviceLinkSettings();
  if (
    c.incoming &&
    (!settings.remoteControlEnabled || settings.revokedControllers.includes(c.peer))
  ) {
    stopConnection(id, 'revoked');
    throw new Error('FILE_PEER_REVOKED');
  }
  clearTimeout(c.timer);
  c.timer = setTimeout(() => stopConnection(id, 'idle'), FILE_PEER_IDLE_MS);
  c.timer.unref();
  return c;
}
/**
 * 等待单次请求期间按空闲时限的一半刷新连接:大附件的摘要校验可能超过空闲时限,
 * 进行中的请求不能被当成空闲关掉。连接已关闭或被撤权时停止刷新。
 */
function keepAlive(id: string): () => void {
  const timer = setInterval(() => {
    try {
      touch(id);
    } catch {
      clearInterval(timer);
    }
  }, FILE_PEER_IDLE_MS / 2);
  timer.unref();
  return () => clearInterval(timer);
}
function track(id: string, peer: string, incoming: boolean) {
  if (connections.size >= 4) throw new Error('FILE_PEER_BUSY');
  const timer = setTimeout(() => stopConnection(id, 'idle'), FILE_PEER_IDLE_MS);
  timer.unref();
  connections.set(id, { peer, incoming, owner: captureDataOwnerBroadcastScope(), timer });
}
function stopConnection(id: string, reason: string) {
  const c = connections.get(id);
  if (!c) return;
  connections.delete(id);
  const unfinished = [...sources.values()].filter((s) => s.connection === id && s.offset < s.size);
  const detail = `conn=${short(id)} peer=${short(c.peer)} incoming=${c.incoming} reason=${reason}`;
  if (unfinished.length)
    log.warn(
      `closed with unfinished send ${detail} sent=${unfinished.map((s) => `${s.offset}/${s.size}B`).join(',')}`,
    );
  else log.debug(`closed ${detail}`);
  clearTimeout(c.timer);
  for (const monitor of [...monitors.values()]) if (monitor.connection === id) monitor.stop();
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
  for (const [id, c] of connections) if (!peer || peer === c.peer) stopConnection(id, 'stop');
}
async function prepareHost(connection: string): Promise<void> {
  touch(connection);
  if (!host.contents) {
    if (!starting)
      starting = host.start().finally(() => {
        starting = null;
      });
    await starting;
  } else if (starting) await starting;
  touch(connection);
}
async function command(c: FilePeerCommand): Promise<string | undefined> {
  await prepareHost(c.connection);
  const stopKeepAlive = c.action === 'invoke' ? keepAlive(c.connection) : undefined;
  try {
    return await sendCommand(c);
  } finally {
    stopKeepAlive?.();
  }
}
function sendCommand(c: FilePeerCommand): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(
      () => {
        replies.delete(id);
        log.warn(`host ${c.action} timed out conn=${short(c.connection)}`);
        // An RPC timeout must not cancel a concurrent file transfer on this peer.
        if (c.action !== 'invoke') stopConnection(c.connection, `${c.action}-timeout`);
        reject(new Error('FILE_PEER_TIMEOUT'));
      },
      c.action === 'receive'
        ? 60_000
        : c.action === 'invoke' && c.timeoutMs && c.timeoutMs > 15_000
          ? c.timeoutMs
          : 15_000,
    );
    timer.unref();
    replies.set(id, { connection: c.connection, resolve, reject, timer });
    host.contents!.send(FILE_PEER_LOCAL.COMMAND, id, c);
  });
}

export async function requestFilePeer(
  peer: string,
  value: unknown,
  invoke?: Connection['invoke'],
): Promise<unknown> {
  const startedAt = Date.now();
  let action = 'invalid';
  try {
    const r = parseFilePeerRequest(value);
    action = r.action;
    const result = await handleFilePeerRequest(peer, r, invoke);
    const opened = r.action === 'open' ? (result as { size?: number; mimeType?: string }) : null;
    const connection =
      r.action === 'offer'
        ? (result as { connection?: string }).connection
        : 'connection' in r
          ? r.connection
          : undefined;
    log.debug(
      `request ${action} ok peer=${short(peer)} ms=${Date.now() - startedAt}` +
        (connection ? ` conn=${short(connection)}` : '') +
        (opened ? ` size=${opened.size} mime=${opened.mimeType}` : ''),
    );
    return result;
  } catch (error) {
    log.warn(
      `request ${action} failed peer=${short(peer)} ms=${Date.now() - startedAt} error=${errorText(error)}`,
    );
    throw error;
  }
}

async function handleFilePeerRequest(
  peer: string,
  r: FilePeerRequest,
  invoke?: Connection['invoke'],
): Promise<unknown> {
  if (r.action === 'caps')
    return {
      version: 1,
      maxBytes: FILE_PEER_MAX_BYTES,
      streaming: true,
      attachments: true,
      largeAttachments: true,
      streamAttachments: true,
    };
  if (r.action === 'offer') {
    const id = randomUUID();
    track(id, peer, true);
    connections.get(id)!.invoke = invoke;
    try {
      // Cold host readiness and TURN configuration share the outer 30s RPC
      // budget: max(10s, 8s) + 15s command leaves transport headroom.
      const readyStartedAt = Date.now();
      const [, servers] = await Promise.all([prepareHost(id), loadDesktopIceServers()]);
      log.debug(
        `offer host ready conn=${short(id)} ms=${Date.now() - readyStartedAt} iceServers=${servers.length}`,
      );
      const sdp = await command({
        action: 'accept',
        connection: id,
        servers,
        sdp: r.sdp,
      });
      return { connection: id, sdp };
    } catch (error) {
      stopConnection(id, 'offer-failed');
      throw error;
    }
  }
  const c = touch(r.connection);
  if (!c.incoming || c.peer !== peer) throw new Error('FILE_PEER_DENIED');
  if (r.action === 'attachment') return handlePeerAttachment(peer, r.request);
  if (r.action === 'close') {
    stopConnection(r.connection, 'peer-close');
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
          stopConnection(r.connection, 'open-timeout');
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
      const source: Source = {
        connection: r.connection,
        file,
        size: stat.size,
        mtime: stat.mtimeMs,
        offset: 0,
        busy: false,
        openedAt: Date.now(),
      };
      sources.set(ticket, source);
      monitorSend(ticket, source);
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
  ipcMain.handle(FILE_PEER_LOCAL.INVOKE, async (e, id: unknown, text: unknown, body: unknown) => {
    host.assertSender(e);
    if (
      typeof id !== 'string' ||
      typeof text !== 'string' ||
      text.length > 4 * 1024 * 1024 ||
      (body !== undefined &&
        (!(body instanceof Uint8Array) || !body.length || body.length > RPC_BODY_MAX_BYTES))
    )
      throw new Error('FILE_PEER_DENIED');
    const c = touch(id);
    const payload = JSON.parse(text);
    if (
      !c.incoming ||
      !c.invoke ||
      typeof payload.channel !== 'string' ||
      !Array.isArray(payload.args) ||
      !canServePeerInvoke(payload.channel, payload.args)
    )
      throw new Error('FILE_PEER_DENIED');
    if (body !== undefined) {
      // Only an attachment block write carries a body; it replaces the base64 `data` field.
      const request = (payload.args[0] as { action?: unknown; request?: unknown }).request as
        Record<string, unknown> | undefined;
      if (
        payload.channel !== FILE_PEER_CHANNEL ||
        !request ||
        typeof request !== 'object' ||
        request.op !== 'write' ||
        request.data !== undefined
      )
        throw new Error('FILE_PEER_DENIED');
      request.data = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    }
    const stopKeepAlive = keepAlive(id);
    let result: unknown;
    try {
      result = await c.invoke(payload.channel, payload.args);
    } finally {
      stopKeepAlive();
    }
    touch(id);
    return JSON.stringify(result);
  });
  ipcMain.handle(FILE_PEER_LOCAL.REGISTER, (e) => host.registered(e));
  ipcMain.handle(FILE_PEER_LOCAL.REPLY, (e, id: unknown, ok: unknown, value: unknown) => {
    host.assertSender(e);
    if (
      typeof id !== 'string' ||
      typeof ok !== 'boolean' ||
      (value !== undefined && (typeof value !== 'string' || value.length > 4 * 1024 * 1024))
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
        // Receive deadlines measure stalled disk/network progress, not total file
        // duration. Diagnostic probes keep their own 5s budget instead: chunk
        // refreshes must not stretch a stalled getStats() past its timeout.
        for (const pending of replies.values())
          if (pending.connection === s.connection && !pending.probe) pending.timer.refresh();
        if (!bytes.length) {
          sources.delete(ticket);
          await s.file.close();
          log.debug(
            `send done conn=${short(connection)} size=${s.size} ms=${Date.now() - s.openedAt}`,
          );
        }
        return bytes.toString('base64');
      } catch (error) {
        log.warn(
          `send failed conn=${short(connection)} sent=${s.offset}/${s.size}B error=${errorText(error)}`,
        );
        stopConnection(connection, 'read-failed');
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
        s.reportProgress();
        // Same as READ: transfer progress never refreshes diagnostic probe timers.
        for (const pending of replies.values())
          if (pending.connection === s.connection && !pending.probe) pending.timer.refresh();
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
const queuePeerRead = createFileReadQueue();
export function tryPeerFile(
  peer: string,
  url: string,
  invoke: Invoke,
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
) {
  const owner = captureDataOwnerBroadcastScope();
  if (!cooldownOwner || !isDataOwnerBroadcastScopeCurrent(cooldownOwner)) {
    cooldown.clear();
    cooldownOwner = owner;
  }
  return queuePeerRead(
    peer,
    () => {
      if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
      return receivePeerFile(peer, url, invoke, signal, onProgress);
    },
    signal,
  );
}
async function receivePeerFile(
  peer: string,
  url: string | null,
  invoke: Invoke,
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
) {
  refreshCooldownOwner();
  if (signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
  const remaining = cooldown.remaining(peer);
  if (remaining) {
    log.debug(`fallback peer=${short(peer)} reason=cooldown remainingMs=${remaining}`);
    return null;
  }
  const startedAt = Date.now();
  let step = 'setup';
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
  const cancel = () => stopConnection(id, 'aborted');
  try {
    signal?.addEventListener('abort', cancel, { once: true });
    if (!remote) {
      const caps = await invoke(peer, FILE_PEER_CHANNEL, [{ action: 'caps' }]);
      if (signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner))
        throw new Error('FILE_PEER_CANCELLED');
      if (!caps.ok || (caps.result as { version?: unknown })?.version !== 1) {
        cooldown.fail(peer);
        log.debug(`fallback peer=${short(peer)} reason=unsupported`);
        return null;
      }
      out.rpc = (caps.result as { streaming?: unknown }).streaming === true;
      out.attachments = (caps.result as { attachments?: unknown }).attachments === true;
      out.largeAttachments =
        (caps.result as { largeAttachments?: unknown }).largeAttachments === true;
      out.streamAttachments =
        (caps.result as { streamAttachments?: unknown }).streamAttachments === true;
      track(id, peer, false);
      const [, servers] = await Promise.all([prepareHost(id), loadDesktopIceServers()]);
      const offer = await command({
        action: 'offer',
        connection: id,
        servers,
        streaming: (caps.result as { streaming?: unknown }).streaming === true,
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
      log.debug(
        `connected peer=${short(peer)} setupMs=${Date.now() - startedAt} stats=${(await probeStats(id)) ?? 'unavailable'}`,
      );
    }
    step = 'open';
    touch(id);
    if (url === null) {
      complete = true;
      cooldown.success(peer);
      return null;
    }
    const opened = await invoke(peer, FILE_PEER_CHANNEL, [
      { action: 'open', connection: remote, url },
    ]);
    if (!opened.ok) throw new Error('FILE_PEER_OPEN');
    const file: FilePeerFile = parseFilePeerFile(opened.result);
    touch(id);
    const space = await fs.statfs(app.getPath('temp'));
    if (space.bavail * space.bsize < 2 * file.size + 256 * 1024 * 1024) return null;
    directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'cindy-file-peer-'));
    const destination = path.join(directory, 'file');
    const handle = await fs.open(destination, 'wx', 0o600),
      sink = randomUUID();
    const receiving: Sink = {
      connection: id,
      file: handle,
      offset: 0,
      size: file.size,
      busy: false,
      reportProgress: () => {
        if (signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner)) return;
        // An observer must never fail a disk write or trigger a transport fallback.
        try {
          onProgress?.(receiving.offset, receiving.size);
        } catch {
          /* observer only */
        }
      },
    };
    sinks.set(sink, receiving);
    receiving.reportProgress();
    step = 'receive';
    const transferStartedAt = Date.now();
    const stopProgress = startMonitor(`receive:${sink}`, id, async () => {
      const stats = await probeStats(id);
      // One failed probe skips its sample only; stopProgress() below bounds the
      // monitor, so a stats hiccup cannot silence the rest of the transfer.
      if (!stats) return sinks.has(sink);
      log.debug(
        `receive progress peer=${short(peer)} conn=${short(id)} written=${sinks.get(sink)?.offset ?? '?'}/${file.size}B elapsedMs=${Date.now() - transferStartedAt} stats=${stats}`,
      );
      return sinks.has(sink);
    });
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
      stopProgress();
      sinks.delete(sink);
      await handle.close().catch(() => {});
    }
    if (signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner))
      throw new Error('FILE_PEER_CLOSED');
    touch(id);
    const ownedDirectory = directory;
    directory = undefined;
    complete = true;
    cooldown.success(peer);
    const transferMs = Date.now() - transferStartedAt;
    log.debug(
      `received peer=${short(peer)} bytes=${file.size} transferMs=${transferMs} totalMs=${Date.now() - startedAt} bytesPerSecond=${Math.round((file.size * 1000) / Math.max(1, transferMs))}`,
    );
    return {
      path: destination,
      size: file.size,
      mimeType: file.mimeType,
      dispose: () => fs.rm(ownedDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner))
      throw new Error('FILE_PEER_CANCELLED');
    const delay = step === 'open' ? 0 : cooldown.fail(peer);
    log.debug(
      `fallback peer=${short(peer)} stage=${step} cooldownMs=${delay} reason=${errorText(error)}`,
    );
    return null;
  } finally {
    signal?.removeEventListener('abort', cancel);
    out.busy = false;
    if (!complete) {
      stopConnection(id, 'incomplete');
      if (outgoing.get(peer) === out) outgoing.delete(peer);
      if (remote && isDataOwnerBroadcastScopeCurrent(owner))
        void invoke(peer, FILE_PEER_CHANNEL, [{ action: 'close', connection: remote }]).catch(
          () => {},
        );
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

interface PeerAttachmentCaps {
  attachments?: boolean;
  largeAttachments?: boolean;
}
/** 已有连接直接复用其能力;否则只发一次 caps 查询(走既有通道,不建 WebRTC 连接)。 */
async function peerAttachmentCaps(
  peer: string,
  invoke: Invoke,
): Promise<PeerAttachmentCaps | undefined> {
  const existing = outgoing.get(peer);
  if (existing?.remote) return existing;
  const caps = await invoke(peer, FILE_PEER_CHANNEL, [{ action: 'caps' }]);
  const result = caps.ok
    ? (caps.result as { version?: unknown; attachments?: unknown; largeAttachments?: unknown })
    : undefined;
  if (result?.version !== 1) return undefined;
  return {
    attachments: result.attachments === true,
    largeAttachments: result.largeAttachments === true,
  };
}

/** Settles with `promise`, or rejects FILE_PEER_CANCELLED as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('FILE_PEER_CANCELLED'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const warming = new Set<string>();
/**
 * Upload only bytes; the eventual message still uses its original WSS acceptance semantics.
 * Aborting `signal` stops hashing or sending within one block, discards the receiver's partial
 * staging and rejects with FILE_PEER_CANCELLED instead of returning null (no OSS fallback, no
 * failure cooldown).
 */
export async function tryUploadPeerAttachment(
  peer: string,
  source: string | Buffer,
  mimeType: string | undefined,
  invoke: Invoke,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  refreshCooldownOwner();
  const owner = captureDataOwnerBroadcastScope();
  const check = () => {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
  };
  // Block-level checkpoints also honour the caller's cancellation; the cleanup RPC below
  // (uploadPeerAttachment's `cancel`) only needs the owner check.
  const checkActive = () => {
    check();
    if (signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
  };
  const upload = async () => {
    checkActive();
    if (cooldown.remaining(peer)) return null;
    let handle: FileHandle | undefined;
    let active: Outgoing | undefined;
    try {
      if (typeof source === 'string')
        handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const size = handle ? (await handle.stat()).size : (source as Buffer).length;
      if (!size) return null;
      // 读整份文件算摘要之前先确认对端能收:对端离线、旧版或不支持时不白读一遍(随后还要走 OSS)。
      // The probe is the one wait with no checkpoint of its own; a late answer is ignored.
      const caps = await untilAborted(peerAttachmentCaps(peer, invoke), signal);
      if (!canSendPeerAttachment(caps, size)) return null;
      checkActive();
      const read = async (offset: number, length: number) => {
        checkActive();
        if (!handle) return (source as Buffer).subarray(offset, offset + length);
        const bytes = Buffer.alloc(length);
        if ((await handle.read(bytes, 0, length, offset)).bytesRead !== length)
          throw new Error('FILE_PEER_CHANGED');
        return bytes;
      };
      // 能力确认后先算摘要再建链:大文件摘要可能超过连接空闲时限,建好的连接不能在 begin 前被闲置关掉。
      const hash = createHash('sha256');
      for (let offset = 0; offset < size; offset += 1024 * 1024)
        hash.update(await read(offset, Math.min(1024 * 1024, size - offset)));
      const sha256 = hash.digest('hex');
      // Cancelling during connection setup stops that setup (without a failure cooldown) and does
      // not wait for its signalling RPC; that late answer is ignored. Only this peer's connection
      // being set up is torn down — other peers and their transfers are untouched.
      await untilAborted(receivePeerFile(peer, null, invoke, signal), signal);
      checkActive();
      const out = outgoing.get(peer);
      if (!out?.remote || !canSendPeerAttachment(out, size)) return null;
      active = out;
      out.busy = true;
      const transferStartedAt = Date.now();
      const result = await uploadPeerAttachment(
        { size, sha256, mimeType },
        async (offset, length) => (await read(offset, length)).toString('base64'),
        async (request, timeoutMs, body) => {
          check();
          const send = (r: Record<string, unknown>) =>
            command({
              action: 'invoke',
              connection: out.id,
              ...(timeoutMs ? { timeoutMs } : {}),
              ...(body === undefined ? {} : { body }),
              payload: JSON.stringify({
                channel: FILE_PEER_CHANNEL,
                args: [{ action: 'attachment', connection: out.remote, request: r }],
              }),
            });
          const sent = send(request);
          // A begin answered only after cancellation: the target created a ticket nobody will
          // cancel, so drop it here (cleanup otherwise starts once the ticket is known).
          if (request.op === 'begin')
            void sent
              .then((raw) => {
                const ticket = signal?.aborted ? JSON.parse(raw!)?.result?.ticket : undefined;
                if (typeof ticket === 'string') return send({ op: 'cancel', ticket });
              })
              .catch(() => {});
          // A cancelled upload stops waiting for in-flight blocks at once; their late replies are
          // ignored and the connection stays up, so the `cancel` request still reaches the target.
          const response = JSON.parse((await untilAborted(sent, signal))!);
          check();
          if (!response.ok) throw new Error('FILE_PEER_UPLOAD');
          return response.result;
        },
        checkActive,
        onProgress,
        out.streamAttachments === true,
      );
      const ms = Date.now() - transferStartedAt;
      log.debug(
        `uploaded peer=${short(peer)} bytes=${size} transferMs=${ms} bytesPerSecond=${Math.round((size * 1000) / Math.max(1, ms))}`,
      );
      return result;
    } catch {
      check();
      if (signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
      cooldown.fail(peer);
      const failed = outgoing.get(peer);
      if (failed) stopConnection(failed.id, 'upload-failed');
      return null;
    } finally {
      if (active) active.busy = false;
      await handle?.close();
    }
  };
  // Cancellation is prompt because every wait inside `upload` honours the signal (queue, probe,
  // hashing, setup, blocks) — never by racing the caller ahead: the call settles only after its
  // `finally` has closed the source file, so the caller may delete it straight away (Windows).
  return queuePeerRead(peer, upload, signal);
}
/** Cold reads use WSS immediately; a single background setup prepares subsequent reads. */
export async function tryPeerInvoke(
  peer: string,
  channel: string,
  args: unknown[],
  invoke: Invoke,
): Promise<InvokeResultPayload | null> {
  refreshCooldownOwner();
  if (!canUsePeerInvoke(channel, args)) return null;
  if (cooldown.remaining(peer)) return null;
  const owner = captureDataOwnerBroadcastScope();
  const out = outgoing.get(peer);
  if (!out?.remote || !out.rpc) {
    if (!out?.remote && !warming.has(peer)) {
      warming.add(peer);
      void queuePeerRead(peer, async () => {
        if (isDataOwnerBroadcastScopeCurrent(owner)) await receivePeerFile(peer, null, invoke);
      })
        .catch(() => {})
        .finally(() => warming.delete(peer));
    }
    return null;
  }
  try {
    const result = await command({
      action: 'invoke',
      connection: out.id,
      payload: JSON.stringify({ channel, args }),
    });
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
    const response = JSON.parse(result!);
    if (!response || typeof response.ok !== 'boolean') throw new Error('FILE_PEER_REPLY');
    return response;
  } catch {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
    cooldown.fail(peer);
    if (!out.busy) stopConnection(out.id, 'rpc-failed');
    return null;
  }
}
