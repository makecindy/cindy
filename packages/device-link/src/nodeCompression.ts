/** Node-only device transport primitives; not exported from the cross-platform entry. */
import { performance } from 'node:perf_hooks';
import { deflateRawSync, gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';

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

/** Push encoding (pushTransfer.ts): raw DEFLATE primed with an ASCII preset dictionary. */
export function deflateRawBase64Sync(text: string, level: number, dictionary: string) {
  const started = performance.now();
  const input = Buffer.from(text, 'utf8');
  return result(input, deflateRawSync(input, { level, dictionary: dictionaryBytes(dictionary) }), started, true);
}

export function inflateRawBase64TextBounded(base64: string, maxChars: number, dictionary: string): string {
  const text = inflateRawSync(Buffer.from(base64, 'base64'), {
    dictionary: dictionaryBytes(dictionary),
    maxOutputLength: maxChars * 3,
  }).toString('utf8');
  if (text.length > maxChars) throw new RangeError('decompressed text exceeds limit');
  return text;
}

// Pushes run on the main process hot path; convert each (tiny, fixed) dictionary once.
const dictionaries = new Map<string, Buffer>();
function dictionaryBytes(dictionary: string): Buffer {
  let bytes = dictionaries.get(dictionary);
  if (!bytes) {
    bytes = Buffer.from(dictionary, 'latin1');
    if (dictionaries.size >= 4) dictionaries.clear();
    dictionaries.set(dictionary, bytes);
  }
  return bytes;
}
