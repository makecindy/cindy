import { compressImageBuffer, detectSupportedImageMime, imageCompressionCacheKey, isCompressedImageOutput, rememberCompressedImage } from '@cindy/maker-core/image-compressor';
import { acceptsWebpImageInput } from '@cindy/model-providers';

import type { ImageRouteInfo, InlineImagePreprocessor, PreparedImage } from '@cindy/anthropic-compat-proxy';
export type { ImageRouteInfo, InlineImagePreprocessor, PreparedImage } from '@cindy/anthropic-compat-proxy';
type Input = { bytes: Buffer; mimeType: string; route: ImageRouteInfo; signal: AbortSignal };

/** Hidden runtime override: XDT_IMAGE_COMPRESSION_DISABLE=1 disables compression;
 * Unset enables the current default. No preferences are written; removing
 * the environment override restores the default. Read for each call, including
 * cache hits. This switch is independent of the proxy's request-size recovery.
 * Memory-only derived cache: at most 64 MiB / 512 entries, no media disk store.
 */
export function createInlineImagePreprocessor(
  enabled: () => boolean = () => process.env.XDT_IMAGE_COMPRESSION_DISABLE !== '1',
  encode: typeof compressImageBuffer = compressImageBuffer,
): InlineImagePreprocessor {
  const cache = new Map<string, PreparedImage | null>();
  const pending = new Map<string, Promise<PreparedImage | null>>();
  let cachedBytes = 0;
  let active = 0;
  const waiters: Array<() => void> = [];
  const run = async (input: Input, maxBytes?: number): Promise<PreparedImage | null> => {
    if (!enabled() || input.signal.aborted) return null;
    // Returning null preserves the original bytes, including EXIF orientation.
    // Do this before cache lookup or encoder scheduling; tighten is unaffected.
    if (maxBytes === undefined && detectSupportedImageMime(input.bytes) === 'image/jpeg') return null;
    const denied = input.route.deniedMimeTypes ?? [];
    const acceptsWebp = Boolean(input.route.providerId?.trim()) && !denied.includes('image/webp') && acceptsWebpImageInput(input.route);
    const request = { bytes: input.bytes, mimeType: input.mimeType, route: { acceptsWebp }, budget: maxBytes === undefined ? undefined : { maxBytes } };
    const key = imageCompressionCacheKey(input.bytes, request) + ':' + [...denied].sort().join(',');
    // A result fed back through a later request must never be JPEG-recompressed.
    if (maxBytes === undefined && isCompressedImageOutput(input.bytes)) return null;
    if (cache.has(key)) {
      const hit = cache.get(key)!;
      cache.delete(key);
      cache.set(key, hit);
      if (hit) rememberCompressedImage(hit.bytes);
      return hit;
    }
    let work = pending.get(key);
    if (!work) {
      // Bound queued source buffers too; overload simply keeps the original.
      if (active >= 2 && waiters.length >= 32) return null;
      work = (async () => {
        if (active >= 2) await new Promise<void>(resolve => waiters.push(resolve));
        else active++;
        try {
          if (input.signal.aborted || !enabled()) return null;
          const result = await encode(request);
          const accepted = result.changed && !denied.includes(result.mimeType)
            && (maxBytes === undefined || result.bytes.length <= maxBytes) ? result : null;
          // An aborted caller never publishes a late result into the cache.
          if (input.signal.aborted || !enabled()) return null;
          if (!accepted || accepted.bytes.length <= 64 * 1024 * 1024) {
            cache.set(key, accepted);
            cachedBytes += accepted?.bytes.length ?? 0;
            if (accepted) rememberCompressedImage(accepted.bytes);
            while (cachedBytes > 64 * 1024 * 1024 || cache.size > 512) {
              const oldest = cache.keys().next().value!;
              cachedBytes -= cache.get(oldest)?.bytes.length ?? 0;
              cache.delete(oldest);
            }
          }
          return accepted;
        } finally {
          const next = waiters.shift();
          if (next) next();
          else active--;
        }
      })().catch(() => null);
      pending.set(key, work);
      void work.finally(() => pending.delete(key));
    }
    // Abort returns promptly, but encoding retains its semaphore until finished.
    return new Promise(resolve => {
      const abort = () => { input.signal.removeEventListener('abort', abort); resolve(null); };
      input.signal.addEventListener('abort', abort, { once: true });
      void work!.then(result => {
        input.signal.removeEventListener('abort', abort);
        resolve(input.signal.aborted || !enabled() ? null : result);
      }, () => abort());
    });
  };
  return { prepare: input => run(input), tighten: input => run(input, input.maxBytes) };
}
