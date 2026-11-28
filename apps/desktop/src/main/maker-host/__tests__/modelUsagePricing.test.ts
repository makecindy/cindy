import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { captureUsagePricing, clearUsagePricing, createUsagePricingObserver, registerUsagePricing } from '../model-usage-pricing.js';

afterEach(() => clearUsagePricing('session'));
const usage = { inputTokens: 30, outputTokens: 5, cacheReadTokens: 10 };
const response = { usage: { input_tokens: 30, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } } };

it('matches completed requests by thread and usage, consumes once, and isolates runtime restarts', () => {
  const resolve = registerUsagePricing('session');
  const oldRequest = captureUsagePricing('session', 'priority', 'thread-1');
  captureUsagePricing('session', 'standard', 'thread-2')(response);
  oldRequest(response);
  expect(resolve({ ...usage, threadId: 'unknown' })).toBeUndefined();
  expect(resolve({ ...usage, threadId: 'thread-1', outputTokens: 6 })).toBeUndefined();
  expect(resolve({ ...usage, threadId: 'thread-1' })).toBe('priority');
  expect(resolve({ ...usage, threadId: 'thread-1' })).toBeUndefined();
  expect(resolve({ ...usage, threadId: 'thread-2' })).toBe('standard');
  clearUsagePricing('session');
  const resumed = registerUsagePricing('session');
  oldRequest(response);
  expect(resumed({ ...usage, threadId: 'thread-1' })).toBeUndefined();
});

it.each(['application/json', 'text/event-stream'])('accepts split %s native responses and chat usage', contentType => {
  const resolve = registerUsagePricing('session');
  const sink = createUsagePricingObserver(contentType, captureUsagePricing('session', 'standard'));
  const value = JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } } });
  const wire = contentType === 'application/json' ? value : `data: ${value}\r\n\r\ndata: [DONE]\r\n\r\n`;
  for (const byte of Buffer.from(wire)) sink.onData?.(Buffer.from([byte]));
  sink.onEnd?.();
  expect(resolve(usage)).toBe('standard');
  expect(resolve(usage)).toBeUndefined();
});

it('keeps final usage after oversized or malformed SSE content without retaining response text', () => {
  const resolve = registerUsagePricing('session');
  const sink = createUsagePricingObserver('text/event-stream', captureUsagePricing('session', 'priority'));
  sink.onData?.(Buffer.from('data: ' + 'x'.repeat(1024 * 1024 + 1)));
  sink.onData?.(Buffer.from('\n\ndata: {broken "usage"\n\n'));
  sink.onData?.(Buffer.from('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n'));
  sink.onEnd?.();
  expect(resolve(usage)).toBe('priority');
});

// Codex subscription HTTP fallback permits SSE without Content-Type (the proxy
// already forwards it). The old observer parsed the entire stream as JSON and
// silently lost the receipt. Exercise the production observer with split bytes.
it.each(['', '  Text/Event-Stream; charset=utf-8  '])('reads streamed receipts with MIME %j', contentType => {
  const resolve = registerUsagePricing('session');
  const sink = createUsagePricingObserver(contentType, captureUsagePricing('session', 'standard'));
  const wire = '\uFEFF: keepalive\r\n\r\nevent: response.completed\r\ndata: '
    + JSON.stringify({ type: 'response.completed', response }) + '\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const byte of Buffer.from(wire)) sink.onData?.(Buffer.from([byte]));
  // Settle while the connection is still open, so the next request sees usage.
  expect(resolve(usage)).toBe('standard');
  sink.onEnd?.();
  expect(resolve(usage)).toBeUndefined();
});

it('keeps untyped JSON receipts and does not sniff explicitly non-SSE content', () => {
  const resolve = registerUsagePricing('session');
  const json = createUsagePricingObserver('', captureUsagePricing('session', 'standard'));
  json.onData?.(Buffer.from(JSON.stringify(response)));
  json.onEnd?.();
  expect(resolve(usage)).toBe('standard');
  const text = createUsagePricingObserver('text/plain', captureUsagePricing('session', 'standard'));
  text.onData?.(Buffer.from('data: ' + JSON.stringify(response) + '\n\n'));
  text.onEnd?.();
  expect(resolve(usage)).toBeUndefined();
});

it('carries the served response model only for an unambiguous usage receipt', () => {
  const resolve = registerUsagePricing('routed', true);
  const capture = captureUsagePricing('routed', 'priority');
  const key = { inputTokens: 23, outputTokens: 4, cacheReadTokens: 0 };
  const add = (model: string) => capture({ model, usage: { input_tokens: 23, output_tokens: 4 } });
  add('actual-model');
  expect(resolve(key)).toEqual({ model: 'actual-model', priceVariant: 'priority' });
  add('model-a');
  add('model-b');
  expect(resolve(key)?.model).toBeUndefined();
  expect(resolve(key)?.model).toBeUndefined();
  clearUsagePricing('routed');
});

it('captures model without overriding priceVariant when non-xAI routes pass undefined priceVariant', () => {
  const resolve = registerUsagePricing('codex-gateway', true);
  const capture = captureUsagePricing('codex-gateway', undefined, 'thread-gw');
  capture({
    type: 'response.completed',
    response: {
      model: 'gpt-5.4',
      usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 80 },
    },
  });
  expect(resolve({ threadId: 'thread-gw', inputTokens: 120, outputTokens: 45, cacheReadTokens: 80 })).toEqual({
    model: 'gpt-5.4',
  });
  clearUsagePricing('codex-gateway');
});

it.each([
  ['gzip', (buf: Buffer) => gzipSync(buf)],
  ['deflate', (buf: Buffer) => deflateSync(buf)],
  ['br', (buf: Buffer) => brotliCompressSync(buf)],
  ['zstd', (buf: Buffer) => zstdCompressSync(buf)],
] as const)('decompresses %s encoded JSON and SSE responses without throwing on corrupt payloads', async (encoding, compress) => {
  const resolve = registerUsagePricing('compressed', true);
  const jsonPayload = JSON.stringify({
    model: 'gpt-5.4-codex',
    usage: { input_tokens: 30, output_tokens: 5, prompt_cache_hit_tokens: 10 },
  });
  const jsonSink = createUsagePricingObserver(
    'application/json',
    captureUsagePricing('compressed', undefined, 'thread-json'),
    encoding,
  );
  jsonSink.onData?.(compress(Buffer.from(jsonPayload)));
  jsonSink.onEnd?.();
  expect(resolve({ ...usage, threadId: 'thread-json' })).toEqual({ model: 'gpt-5.4-codex' });

  const ssePayload = `data: ${JSON.stringify({ type: 'response.completed', response: { ...response, model: 'gpt-5.4-sse' } })}\n\n`;
  const sseSink = createUsagePricingObserver(
    'text/event-stream',
    captureUsagePricing('compressed', undefined, 'thread-sse'),
    encoding,
  );
  const compressedSse = compress(Buffer.from(ssePayload));
  sseSink.onData?.(compressedSse.subarray(0, Math.floor(compressedSse.length / 2)));
  sseSink.onData?.(compressedSse.subarray(Math.floor(compressedSse.length / 2)));
  sseSink.onEnd?.();
  await new Promise(resolveWait => setTimeout(resolveWait, 30));
  expect(resolve({ ...usage, threadId: 'thread-sse' })).toEqual({ model: 'gpt-5.4-sse' });

  const corruptSink = createUsagePricingObserver(
    'application/json',
    captureUsagePricing('compressed', undefined, 'thread-corrupt'),
    encoding,
  );
  corruptSink.onData?.(Buffer.from('not-actually-compressed'));
  corruptSink.onEnd?.();
  expect(resolve({ ...usage, threadId: 'thread-corrupt' })).toBeUndefined();
  clearUsagePricing('compressed');
});
