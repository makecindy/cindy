import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { DirectMediaRequest } from '@cindy/agent-net-protocol';

/**
 * Where attachment ciphertext is kept. The relay holds the metadata (owner, recipient, size, bytes confirmed) in its
 * state and moves bytes only through this interface; it never holds plaintext. Object IDs are random UUIDs.
 */
export interface RelayMediaStorage {
  /** Bytes stored for the object; 0 when there are none yet. */
  length(id: string): Promise<number>;
  /**
   * Appends `data` at `offset` and returns the stored length. Bytes past `offset` can only be left by an earlier
   * attempt at this same chunk whose confirmation was lost: an implementation either discards them, or (when it
   * cannot) accepts the retry if the stored bytes already end exactly where this chunk ends. Anything else is a
   * RelayMediaStorageError.
   */
  append(id: string, offset: number, data: Uint8Array): Promise<number>;
  /** Inclusive byte range of a complete object. */
  read(id: string, start: number, end: number): Promise<Readable>;
  /** Idempotent. */
  remove(id: string): Promise<void>;
  /**
   * Present when clients can reach the storage themselves: the relay authorizes each request, and the bytes no
   * longer pass through it. Every request is bound to one object and expires within DIRECT_GRANT_MAX_MS.
   */
  direct?: RelayDirectMedia;
}
/**
 * Longest a direct request may stay valid. With direct storage the relay keeps a removed or expired upload's record
 * this much longer, so a write granted before the removal that lands afterwards is removed with it.
 */
export const DIRECT_GRANT_MAX_MS = 10 * 60_000;
export interface RelayDirectMedia {
  /**
   * Appends exactly the chunk of `size` bytes whose MD5 (base64) is `contentMd5`, at `offset`: the storage must
   * refuse any other body, length or position, since the relay checks the size against the upload and its quota.
   */
  append(id: string, offset: number, size: number, contentMd5: string): Promise<DirectMediaRequest>;
  /** Range reads of the complete object. */
  read(id: string): Promise<DirectMediaRequest>;
}
export class RelayMediaStorageError extends Error {
  constructor(readonly code: 'MEDIA_OFFSET_MISMATCH' | 'MEDIA_DATA_MISSING') { super(code); }
}
/** The storage failed (I/O error, object store unreachable or refusing): retryable for the client, not a contract answer. */
export class RelayMediaStorageUnavailableError extends Error {
  constructor(readonly reason: unknown) { super('MEDIA_STORAGE_UNAVAILABLE'); }
}
/** Every call either answers, refuses with RelayMediaStorageError, or fails with RelayMediaStorageUnavailableError. */
export function guardMediaStorage(storage: RelayMediaStorage): RelayMediaStorage {
  const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await call(...args); } catch (error) {
      if (error instanceof RelayMediaStorageError || error instanceof RelayMediaStorageUnavailableError) throw error;
      throw new RelayMediaStorageUnavailableError(error);
    }
  };
  const direct = storage.direct;
  return {
    length: guard(id => storage.length(id)), append: guard((id, offset, data) => storage.append(id, offset, data)),
    read: guard((id, start, end) => storage.read(id, start, end)), remove: guard(id => storage.remove(id)),
    ...(direct ? { direct: { append: guard((id, offset, size, md5) => direct.append(id, offset, size, md5)), read: guard(id => direct.read(id)) } } : {}),
  };
}

/** One file per object under `dir` (the default; replicas of one cluster must share the directory). */
export async function createLocalMediaStorage(dir: string): Promise<RelayMediaStorage> {
  if (!path.isAbsolute(dir)) throw new Error('MEDIA_DIR_MUST_BE_ABSOLUTE');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (id: string) => path.join(dir, id);
  return {
    async length(id) {
      try { return (await stat(file(id))).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    },
    async append(id, offset, data) {
      const handle = await open(file(id), 'r+').catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' && offset === 0 ? open(file(id), 'wx+', 0o600) : Promise.reject(error));
      try {
        if ((await handle.stat()).size < offset) throw new RelayMediaStorageError('MEDIA_DATA_MISSING');
        // Discard bytes from a write whose confirmation was interrupted. Never recopy previous chunks.
        await handle.truncate(offset);
        let written = 0;
        while (written < data.length) written += (await handle.write(data, written, data.length - written, offset + written)).bytesWritten;
        await handle.sync();
        return offset + data.length;
      } finally { await handle.close(); }
    },
    async read(id, start, end) { return createReadStream(file(id), { start, end }); },
    async remove(id) { await rm(file(id), { force: true }); },
  };
}
