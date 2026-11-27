import { StringDecoder } from 'node:string_decoder';
import type { Transform } from 'node:stream';
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib';
import type { ResponseObserverSink } from '@cindy/anthropic-compat-proxy';

type PriceVariant = 'standard' | 'priority';
interface UsageKey {
  threadId?: string;
  /** Total prompt tokens, including cached tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}
type ObservedUsage = { priceVariant?: PriceVariant; model?: string };
type Receipt = UsageKey & ObservedUsage;
const sessions = new Map<string, Receipt[]>();
const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_COMPRESSED_BUFFER_BYTES = 2 * 1024 * 1024;
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Each runtime gets its own receipt list, so delayed responses cannot affect a resumed runtime. */
export function registerUsagePricing(sessionId: string): (usage: UsageKey) => PriceVariant | undefined;
export function registerUsagePricing(sessionId: string, includeModel: true): (usage: UsageKey) => ObservedUsage | undefined;
export function registerUsagePricing(sessionId: string, includeModel = false) {
  const receipts: Receipt[] = [];
  sessions.set(sessionId, receipts);
  return (usage: UsageKey) => {
    const matches = (receipt: Receipt) =>
      (includeModel || receipt.priceVariant !== undefined)
      && receipt.threadId === usage.threadId
      && receipt.inputTokens === usage.inputTokens && receipt.outputTokens === usage.outputTokens
      && receipt.cacheReadTokens === usage.cacheReadTokens;
    const index = receipts.findIndex(matches);
    if (index < 0) return undefined;
    const [receipt] = receipts.splice(index, 1);
    if (!includeModel) return receipt.priceVariant;
    const ambiguous = receipts.filter(matches);
    if (ambiguous.some(other => other.model !== receipt.model)) {
      // The provider did not supply a request ID in the matching notification.
      for (const other of ambiguous) other.model = undefined;
      return receipt.priceVariant ? { priceVariant: receipt.priceVariant } : {};
    }
    return {
      ...(receipt.priceVariant ? { priceVariant: receipt.priceVariant } : {}),
      ...(receipt.model ? { model: receipt.model } : {}),
    };
  };
}

export function clearUsagePricing(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Capture the runtime and dispatch choice, never re-read the catalog or Fast preference at completion. */
export function captureUsagePricing(sessionId: string, priceVariant?: PriceVariant, threadId?: string) {
  const receipts = sessions.get(sessionId);
  return (value: unknown): void => {
    if (!receipts || !value || typeof value !== 'object') return;
    const body = recordOf(value);
    if (!body) return;
    if (typeof body.type === 'string' && body.type.startsWith('response.')
      && body.type !== 'response.completed' && body.type !== 'response.incomplete') return;
    const response = recordOf(body.response) ?? body;
    const usage = recordOf(response.usage);
    if (!usage) return;
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens;
    const cacheReadTokens =
      recordOf(usage.input_tokens_details)?.cached_tokens ??
      recordOf(usage.prompt_tokens_details)?.cached_tokens ??
      usage.cache_read_input_tokens ??
      usage.prompt_cache_hit_tokens ??
      0;
    const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!validCount(inputTokens) || !validCount(outputTokens) || !validCount(cacheReadTokens)) return;
    // Bound unmatched receipts (cancelled requests, compaction, or delayed agent notifications).
    if (receipts.length >= 64) receipts.shift();
    const model = typeof response.model === 'string' && response.model.length <= 256 ? response.model.trim() || undefined : undefined;
    receipts.push({ threadId, inputTokens, outputTokens, cacheReadTokens, priceVariant, model });
  };
}

type SupportedEncoding = 'gzip' | 'deflate' | 'br' | 'zstd';

function parseContentEncoding(contentEncoding: string): SupportedEncoding | 'identity' | 'unsupported' {
  const tokens = contentEncoding
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return 'identity';
  if (tokens.length > 1) return 'unsupported';
  const encoding = tokens[0]!;
  if (encoding === 'identity') return 'identity';
  if (encoding === 'gzip' || encoding === 'x-gzip') return 'gzip';
  if (encoding === 'deflate') return 'deflate';
  if (encoding === 'br') return 'br';
  if (encoding === 'zstd') return 'zstd';
  return 'unsupported';
}

function decompressBufferSync(encoding: SupportedEncoding, data: Buffer): Buffer | null {
  try {
    if (encoding === 'gzip') return gunzipSync(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    if (encoding === 'deflate') return inflateSync(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    if (encoding === 'br') return brotliDecompressSync(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    return zstdDecompressSync(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch {
    return null;
  }
}

function createStreamingDecompressor(encoding: SupportedEncoding): Transform {
  if (encoding === 'gzip') return createGunzip({ maxOutputLength: MAX_DECOMPRESSED_BYTES });
  if (encoding === 'deflate') return createInflate({ maxOutputLength: MAX_DECOMPRESSED_BYTES });
  if (encoding === 'br') return createBrotliDecompress({ maxOutputLength: MAX_DECOMPRESSED_BYTES });
  return createZstdDecompress({ maxOutputLength: MAX_DECOMPRESSED_BYTES });
}

/** Read-only tee of native JSON/SSE responses; token/content bytes reach the harness unchanged. */
export function createUsagePricingObserver(
  contentType: string,
  record: (value: unknown) => void,
  contentEncoding = '',
): ResponseObserverSink {
  const encoding = parseContentEncoding(contentEncoding);
  if (encoding === 'unsupported') return { onData: () => {}, onEnd: () => {} };
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  let mode: 'sse' | 'json' | 'detect' = mime === 'text/event-stream' ? 'sse' : mime ? 'json' : 'detect';
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let overflow = false;
  const parse = (value: string): void => {
    if (!value.includes('"usage"')) return;
    try { record(JSON.parse(value)); } catch { /* Malformed frames remain the harness's responsibility. */ }
  };
  const ingest = (text: string): void => {
    pending += text;
    // Codex's subscription HTTP fallback can omit Content-Type. The forwarding
    // layer accepts these streams, so their receipts must follow the same path.
    // Wait for a recognizable prefix across chunks; never override an explicit
    // MIME type or retain an unbounded body while detecting the format.
    if (mode === 'detect') {
      const prefix = pending.trimStart();
      if (/^(?:data:|event:|id:|retry:|:)/.test(prefix)) mode = 'sse';
      else if (prefix.startsWith('{') || prefix.startsWith('[')) mode = 'json';
    }
    if (mode === 'sse') {
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (!overflow) parse(frame.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
        overflow = false;
      }
    }
    if (pending.length > MAX_DECOMPRESSED_BYTES) { pending = ''; overflow = true; }
  };
  const finish = (): void => {
    ingest(decoder.end());
    if (mode === 'sse') ingest('\n\n');
    else if (!overflow) parse(pending);
  };
  if (encoding === 'identity') {
    return {
      onData: chunk => ingest(decoder.write(chunk)),
      onEnd: finish,
    };
  }
  if (mode === 'json') {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let compressedOverflow = false;
    return {
      onData: chunk => {
        if (compressedOverflow) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_COMPRESSED_BUFFER_BYTES) {
          compressedOverflow = true;
          chunks.length = 0;
          return;
        }
        chunks.push(Buffer.from(chunk));
      },
      onEnd: () => {
        if (compressedOverflow || chunks.length === 0) return;
        const plain = decompressBufferSync(encoding, Buffer.concat(chunks));
        if (!plain) return;
        ingest(decoder.write(plain));
        finish();
      },
    };
  }
  const decompressor = createStreamingDecompressor(encoding);
  let failed = false;
  decompressor.on('data', (chunk: Buffer) => {
    if (!failed) ingest(decoder.write(chunk));
  });
  decompressor.on('end', () => {
    if (!failed) finish();
  });
  decompressor.on('error', () => {
    failed = true;
  });
  return {
    onData: chunk => {
      if (failed) return;
      try { decompressor.write(chunk); } catch { failed = true; }
    },
    onEnd: () => {
      if (failed) return;
      try { decompressor.end(); } catch { failed = true; }
    },
  };
}
