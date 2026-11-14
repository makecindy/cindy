import { MEDIA_ENCRYPTED_HEADER_BYTES as HEADER, MEDIA_PLAINTEXT_CHUNK_BYTES as BLOCK, MAX_MEDIA_OBJECT_BYTES, MAX_MEDIA_BINARY_CHUNK_BYTES } from '@cindy/agent-net-protocol';
import { concatBytes, fromBase64Url, toBase64Url } from './portableBytes.js';
import type { NativeEnginePort } from './nativeTransport.js';

export interface NativeMediaApi {
  request<T>(method: string, resource: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<T>;
  /** Starts an upload, offering direct transfer to the relay's storage when the client supports it. */
  createMedia?(recipient: string, size: number, signal?: AbortSignal): Promise<{ id: string; chunkBytes: number }>;
  putMediaChunk(id: string, offset: number, bytes: Uint8Array, signal?: AbortSignal): Promise<{ received: number; complete: boolean }>;
  /** Keep cancellation and the range deadline through the consumer's body read. */
  withMediaResponse<T>(id: string, range: string, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export interface NativeMediaOptions { signal?: AbortSignal; assertCurrent?(): void; onProgress?(bytes: number, total: number): void; binding?: string; }
interface MediaSession { id: number; header: string; size: number; encryptedSize: number; headerSha256: string; binding?: string; }
function check(options: NativeMediaOptions, engine: NativeEnginePort): void {
  if (options.binding !== undefined && !/^[\x21-\x7e]{1,256}$/.test(options.binding)) throw new Error('INVALID_MEDIA_BINDING');
  if (options.signal?.aborted) throw new Error('MEDIA_CANCELLED');
  options.assertCurrent?.(); engine.assertCurrent?.();
}
function sessionValid(value: MediaSession, size?: number): boolean {
  return Number.isSafeInteger(value.id) && value.id > 0 && Number.isSafeInteger(value.size) && value.size >= 0
    && value.size <= 2 * 1024 * 1024 * 1024 && (size === undefined || value.size === size)
    && value.encryptedSize === HEADER + value.size + Math.ceil(value.size / BLOCK) * 16
    && value.encryptedSize <= MAX_MEDIA_OBJECT_BYTES && /^[a-f0-9]{64}$/.test(value.headerSha256);
}
/** One 1 MiB plaintext block at a time; the data key stays in native memory. */
export async function uploadNativeMedia(api: NativeMediaApi, engine: NativeEnginePort, recipient: string, recipientKey: string,
  size: number, read: (offset: number, length: number) => Promise<Uint8Array>, options: NativeMediaOptions = {},
): Promise<{ id: string; sha256: string; headerSha256: string }> {
  check(options, engine);
  const session = await engine.command<MediaSession>({ op: 'mediaCreateUpload', recipientKey, size, ...(options.binding ? { binding: options.binding } : {}) });
  let id: string | undefined;
  try {
    check(options, engine);
    if (!sessionValid(session, size)) throw new Error('INVALID_MEDIA_SESSION');
    if (options.binding !== undefined && session.binding !== options.binding) throw new Error('AGENT_NET_NATIVE_UPDATE_REQUIRED');
    const created = api.createMedia ? await api.createMedia(recipient, session.encryptedSize, options.signal)
      : await api.request<{ id: string; chunkBytes: number }>('POST', '/media', { recipient, size: session.encryptedSize, chunkFormat: 'binary-v1' }, { signal: options.signal });
    id = created.id; check(options, engine);
    if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(created.chunkBytes) || created.chunkBytes < BLOCK + 16
      || created.chunkBytes > MAX_MEDIA_BINARY_CHUNK_BYTES) throw new Error('MEDIA_STREAM_UNSUPPORTED');
    let batch = [fromBase64Url(session.header)], batchBytes = HEADER, written = 0;
    const flush = async () => {
      check(options, engine);
      const response = await api.putMediaChunk(id!, written, concatBytes(batch), options.signal); check(options, engine);
      written += batchBytes;
      if (response.received !== written) throw new Error('MEDIA_OFFSET_MISMATCH');
      batch = []; batchBytes = 0;
    };
    for (let offset = 0; offset < size; offset += BLOCK) {
      check(options, engine);
      const plain = await read(offset, Math.min(BLOCK, size - offset)); check(options, engine);
      if (plain.length !== Math.min(BLOCK, size - offset)) throw new Error('MEDIA_SOURCE_CHANGED');
      const encoded = await engine.command<string>({ op: 'mediaEncrypt', id: session.id, data: toBase64Url(plain) });
      check(options, engine);
      const cipher = fromBase64Url(encoded);
      if (cipher.length !== plain.length + 16) throw new Error('INVALID_MEDIA_CHUNK');
      if (batchBytes + cipher.length > created.chunkBytes) await flush();
      batch.push(cipher); batchBytes += cipher.length;
      options.onProgress?.(Math.min(size, offset + plain.length), size);
    }
    if (batchBytes) await flush();
    if (written !== session.encryptedSize) throw new Error('MEDIA_SIZE_MISMATCH');
    const finished = await engine.command<{ sha256: string }>({ op: 'mediaFinish', id: session.id }); check(options, engine);
    if (!/^[a-f0-9]{64}$/.test(finished.sha256)) throw new Error('INVALID_MEDIA_HASH');
    return { id, sha256: finished.sha256, headerSha256: session.headerSha256 };
  } catch (error) {
    if (id) { const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
      try { await api.request('DELETE', '/media/' + id, undefined, { signal: controller.signal }); } catch { /* Owner-bound cleanup can be retried by TTL. */ }
      finally { clearTimeout(timer); } }
    throw error;
  } finally { await engine.command({ op: 'mediaClose', id: session.id }).catch(() => undefined); }
}
async function range(api: NativeMediaApi, engine: NativeEnginePort, id: string, start: number, end: number,
  total: number | undefined, options: NativeMediaOptions): Promise<{ bytes: Uint8Array; total: number }> {
  check(options, engine);
  const consume = async (response: Response) => {
    check(options, engine);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== end
      || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) > MAX_MEDIA_OBJECT_BYTES
      || (total !== undefined && Number(match[3]) !== total)) {
      await response.body?.cancel(); throw new Error('INVALID_MEDIA_RANGE');
    }
    const needed = end - start + 1, reader = response.body?.getReader?.();
    let bytes: Uint8Array;
    if (reader) {
      bytes = new Uint8Array(needed); let received = 0;
      try { for (;;) {
        const chunk = await reader.read(); check(options, engine);
        if (chunk.done) break;
        if (received + chunk.value.length > needed) throw new Error('INVALID_MEDIA_CHUNK');
        bytes.set(chunk.value, received); received += chunk.value.length;
      } if (received !== needed) throw new Error('MEDIA_INCOMPLETE'); }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } else { bytes = new Uint8Array(await response.arrayBuffer()); check(options, engine); }
    if (bytes.length !== needed) throw new Error('MEDIA_INCOMPLETE');
    return { bytes, total: Number(match[3]) };
  };
  const requestRange = `bytes=${start}-${end}`;
  return api.withMediaResponse(id, requestRange, consume, options.signal);
}
/** Authenticated, seekable blocks. The sink owns file IO and its cancellation
 * cleanup. No partial plaintext is returned before its AEAD tag is verified. */
export async function openNativeMediaReader(api: NativeMediaApi | (() => NativeMediaApi), engine: NativeEnginePort,
  id: string, headerSha256: string, options: NativeMediaOptions = {}) {
  const currentApi = () => typeof api === 'function' ? api() : api;
  const first = await range(currentApi(), engine, id, 0, HEADER - 1, undefined, options);
  const session = await engine.command<MediaSession>({ op: 'mediaOpen', header: toBase64Url(first.bytes), headerSha256,
    ...(options.binding ? { binding: options.binding } : {}) });
  let closed = false;
  const blocks = new Map<number, Uint8Array>();
  const close = async () => {
    if (closed) return; closed = true;
    for (const block of blocks.values()) block.fill(0); blocks.clear();
    await engine.command({ op: 'mediaClose', id: session.id }).catch(() => undefined);
  };
  try {
    check(options, engine);
    if (!sessionValid(session) || session.encryptedSize !== first.total) throw new Error('INVALID_MEDIA_HEADER');
    if (options.binding !== undefined && session.binding !== options.binding) throw new Error('AGENT_NET_NATIVE_UPDATE_REQUIRED');
    return { size: session.size, close, async read(start: number, requestedEnd: number, write: (bytes: Uint8Array, offset: number) => Promise<void>) {
      if (closed) throw new Error('MEDIA_CLOSED'); check(options, engine);
      if (session.size === 0 && start === 0 && requestedEnd === -1) return { size: 0, start: 0, end: -1 };
      const end = Math.min(requestedEnd, session.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= session.size) throw new Error('INVALID_MEDIA_RANGE');
      for (let index = Math.floor(start / BLOCK); index <= Math.floor(end / BLOCK); index++) {
        const plainSize = Math.min(BLOCK, session.size - index * BLOCK), cipherStart = HEADER + index * (BLOCK + 16);
        let plain = blocks.get(index);
        if (!plain) {
          const encrypted = await range(currentApi(), engine, id, cipherStart, cipherStart + plainSize + 15, session.encryptedSize, options);
          const decoded = await engine.command<string>({ op: 'mediaDecrypt', id: session.id, index, data: toBase64Url(encrypted.bytes) });
          check(options, engine); if (closed) throw new Error('MEDIA_CLOSED');
          plain = fromBase64Url(decoded);
          if (plain.length !== plainSize) throw new Error('INVALID_MEDIA_CHUNK');
          const old = blocks.get(index); if (old) old.fill(0);
          blocks.set(index, plain);
          while (blocks.size > 2) { const first = blocks.keys().next().value!; blocks.get(first)!.fill(0); blocks.delete(first); }
        }
        const from = Math.max(0, start - index * BLOCK), to = Math.min(plain.length, end - index * BLOCK + 1);
        await write(plain.slice(from, to), Math.max(start, index * BLOCK) - start); check(options, engine);
        options.onProgress?.(Math.min(end - start + 1, index * BLOCK + to - start), end - start + 1);
      }
      return { size: session.size, start, end };
    } };
  } catch (error) { await close(); throw error; }
}
export async function readNativeMedia(api: NativeMediaApi, engine: NativeEnginePort, id: string, headerSha256: string,
  write: (bytes: Uint8Array, offset: number) => Promise<void>, options: NativeMediaOptions & { start?: number; end?: number } = {},
): Promise<{ size: number; start: number; end: number }> {
  const reader = await openNativeMediaReader(api, engine, id, headerSha256, options);
  try { return await reader.read(options.start ?? 0, options.end ?? reader.size - 1, write); }
  finally { await reader.close(); }
}
