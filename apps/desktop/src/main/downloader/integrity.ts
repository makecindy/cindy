/**
 * unified-downloader — M3: Streaming SHA256 integrity check.
 * ---------------------------------------------------------------------------
 * Checksum verification and integrity errors are maintained in this module.
 *
 * Two entry points:
 *   - computeHash(filePath)        — one-shot file hash (used for fromCache check)
 *   - createStreamingHasher(part?) — incremental hasher; if `part` is passed,
 *                                    its existing bytes are pre-fed before live
 *                                    chunks (used by resumed downloads).
 *
 * digest() always returns lowercase hex.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

export function computeHash(filePath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { signal });
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export interface StreamingHasher {
  update(chunk: Buffer): Promise<void>;
  digest(): Promise<string>;
}

/**
 * Create a streaming SHA256 hasher.
 * - When `existingPartPath === null`: starts empty; just streams chunks fed via update().
 * - When `existingPartPath` is a path: reads the file contents into the hasher
 *   FIRST (the "prime" step), then live chunks are appended to the same hash.
 *
 * Both update() and digest() await the prime — calling digest() immediately is
 * safe even before the prime finishes.
 *
 * IMPORTANT — bounded prime read:
 * The prime read is BOUNDED to the file size at hasher-construction time
 * (`fs.statSync(existingPartPath).size - 1`). This is critical because the
 * caller (transport.ts) starts appending live network chunks to this same
 * `.part` file as soon as the response arrives, and `fs.createReadStream`
 * without an explicit `end` will keep reading past the original EOF if the
 * file grows. Without the bound, appended bytes get hashed twice (once during
 * prime, once via update()), producing a guaranteed CHECKSUM mismatch on every
 * resume — and CHECKSUM is non-retryable, so the whole download dies.
 */
export function createStreamingHasher(
  existingPartPath: string | null,
  signal?: AbortSignal,
): StreamingHasher {
  const hash = crypto.createHash('sha256');
  let primed: Promise<void>;

  if (existingPartPath === null) {
    primed = Promise.resolve();
  } else {
    primed = new Promise<void>((resolve, reject) => {
      let priorSize: number;
      try {
        priorSize = fs.statSync(existingPartPath).size;
      } catch (err) {
        reject(err as Error);
        return;
      }
      // Empty file → nothing to prime, but still need to resolve so update()
      // doesn't deadlock. Skip the read stream entirely.
      if (priorSize === 0) {
        resolve();
        return;
      }
      const stream = fs.createReadStream(existingPartPath, {
        signal,
        start: 0,
        end: priorSize - 1, // inclusive — pins the read to original EOF
      });
      stream.on('data', (chunk: string | Buffer) => {
        hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
  }

  // Observe early prime rejection even if opening the destination fails first.
  void primed.catch(() => {});

  return {
    /**
     * Feed a chunk into the streaming hash.
     *
     * Asynchronous in signature only: the `await primed` resolves immediately
     * (synchronously, microtask-tick) after the prime phase finishes. In the
     * `existingPartPath === null` branch `primed` is `Promise.resolve()` so
     * every update() is effectively synchronous from the start. In the resume
     * branch, only the FIRST update() actually waits for the prime read; once
     * the file has been hashed, all subsequent update() calls also resolve
     * immediately because `await Promise.resolve(undefined)` does not yield to
     * the event loop in a way that interleaves with other update() calls.
     *
     * Result: in JS's single-threaded event loop, write order is preserved
     * across update() calls even though the function is `async`. Do NOT
     * introduce true concurrent calls (e.g. via `Promise.all` over chunks);
     * the order guarantee depends on serial `await` resolution.
     */
    async update(chunk: Buffer): Promise<void> {
      await primed;
      signal?.throwIfAborted();
      hash.update(chunk);
    },
    async digest(): Promise<string> {
      await primed;
      signal?.throwIfAborted();
      return hash.digest('hex');
    },
  };
}
