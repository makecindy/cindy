import { StringDecoder } from 'node:string_decoder';
import type { ResponseObserverSink } from '@cindy/anthropic-compat-proxy';

type PriceVariant = 'standard' | 'priority';
interface UsageKey {
  threadId?: string;
  /** Total prompt tokens, including cached tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}
type Receipt = UsageKey & { priceVariant: PriceVariant };
const sessions = new Map<string, Receipt[]>();
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Each runtime gets its own receipt list, so delayed responses cannot affect a resumed runtime. */
export function registerUsagePricing(sessionId: string): (usage: UsageKey) => PriceVariant | undefined {
  const receipts: Receipt[] = [];
  sessions.set(sessionId, receipts);
  return usage => {
    const index = receipts.findIndex(receipt => receipt.threadId === usage.threadId
      && receipt.inputTokens === usage.inputTokens && receipt.outputTokens === usage.outputTokens
      && receipt.cacheReadTokens === usage.cacheReadTokens);
    return index < 0 ? undefined : receipts.splice(index, 1)[0]?.priceVariant;
  };
}

export function clearUsagePricing(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Capture the runtime and dispatch choice, never re-read the catalog or Fast preference at completion. */
export function captureUsagePricing(sessionId: string, priceVariant: PriceVariant, threadId?: string) {
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
    const cacheReadTokens = recordOf(usage.input_tokens_details)?.cached_tokens ?? recordOf(usage.prompt_tokens_details)?.cached_tokens ?? 0;
    const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!validCount(inputTokens) || !validCount(outputTokens) || !validCount(cacheReadTokens)) return;
    // Bound unmatched receipts (cancelled requests, compaction, or delayed agent notifications).
    if (receipts.length >= 64) receipts.shift();
    receipts.push({ threadId, inputTokens, outputTokens, cacheReadTokens, priceVariant });
  };
}

/** Read-only tee of native JSON/SSE responses; token/content bytes reach the harness unchanged. */
export function createUsagePricingObserver(contentType: string, record: (value: unknown) => void): ResponseObserverSink {
  const sse = contentType.includes('text/event-stream');
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let overflow = false;
  const parse = (value: string): void => {
    if (!value.includes('"usage"')) return;
    try { record(JSON.parse(value)); } catch { /* Malformed frames remain the harness's responsibility. */ }
  };
  const ingest = (text: string): void => {
    pending += text;
    if (sse) {
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (!overflow) parse(frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
        overflow = false;
      }
    }
    if (pending.length > 1024 * 1024) { pending = ''; overflow = true; }
  };
  return {
    onData: chunk => ingest(decoder.write(chunk)),
    onEnd: () => {
      ingest(decoder.end());
      if (sse) ingest('\n\n');
      else if (!overflow) parse(pending);
    },
  };
}
