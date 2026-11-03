/** Node-only device transport primitives; not exported from the cross-platform entry. */
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';

export interface CompressionStats {
  originalBytes: number;
  gzipBytes: number;
  wireBytes: number;
  compressionMs: number;
}

function result(input: Buffer, compressed: Buffer, started: number, base64: boolean) {
  const stats: CompressionStats = {
    originalBytes: input.length,
    gzipBytes: compressed.length,
    wireBytes: base64 ? 4 * Math.ceil(compressed.length / 3) : compressed.length,
    compressionMs: performance.now() - started,
  };
  return { compressed, stats };
}

/** Retains synchronous send/error contracts in existing device-link transports. */
export function compressGzipSync(input: Buffer, level: number, base64 = false) {
  const started = performance.now();
  return result(input, gzipSync(input, { level }), started, base64);
}

export function gunzipBase64TextBounded(base64: string, maxChars: number): string {
  // A UTF-16 code unit needs at most three UTF-8 bytes. Bound allocation in zlib,
  // then enforce the existing character-based device-link wire contract.
  const text = gunzipSync(Buffer.from(base64, 'base64'), { maxOutputLength: maxChars * 3 }).toString('utf8');
  if (text.length > maxChars) throw new RangeError('decompressed text exceeds limit');
  return text;
}
