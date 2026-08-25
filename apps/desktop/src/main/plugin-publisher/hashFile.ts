/**
 * Streaming SHA-256 + size for a local file.
 *
 * Hashing is a visible, cancellable stage. Do not treat "128 MiB in a few
 * hundred milliseconds" as a promise — network disks and cloud hydration vary.
 */
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

export const PLUGIN_PUBLISHER_HASH_CHUNK_BYTES = 1024 * 1024;

export class PluginPublisherHashCancelledError extends Error {
  readonly code = 'HASH_CANCELLED' as const;

  constructor() {
    super('Plugin package hash was cancelled');
    this.name = 'PluginPublisherHashCancelledError';
  }
}

export interface HashLocalFileProgress {
  bytesRead: number;
  totalBytes: number;
}

export interface HashLocalFileResult {
  sizeBytes: number;
  sha256: string;
}

export async function hashLocalFile(
  handle: FileHandle,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: HashLocalFileProgress) => void;
    chunkBytes?: number;
  } = {},
): Promise<HashLocalFileResult> {
  const stat = await handle.stat();
  if (!stat.isFile()) {
    throw new Error('Plugin package path is not a regular file');
  }
  const totalBytes = stat.size;
  const chunkBytes = options.chunkBytes ?? PLUGIN_PUBLISHER_HASH_CHUNK_BYTES;
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.max(1, chunkBytes));
  let bytesRead = 0;
  let position = 0;

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) throw new PluginPublisherHashCancelledError();
  };

  throwIfAborted();
  options.onProgress?.({ bytesRead: 0, totalBytes });

  while (position < totalBytes) {
    throwIfAborted();
    const { bytesRead: n } = await handle.read(buffer, 0, buffer.length, position);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n));
    position += n;
    bytesRead += n;
    options.onProgress?.({ bytesRead, totalBytes });
    // Yield so a long hash can be cancelled between chunks.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throwIfAborted();
  if (bytesRead !== totalBytes) {
    throw new Error('Plugin package size changed while hashing');
  }
  return { sizeBytes: totalBytes, sha256: hash.digest('hex') };
}
