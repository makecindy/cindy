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
