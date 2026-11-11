import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createResponsesAnthropicHandler } from '../handler.js';

class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  headersSent = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): this {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
    return this;
  }
}

function anthropicStream(): Response {
  const body = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":2}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const ctx = {
  method: 'POST',
  url: 'http://127.0.0.1/responses',
  headers: {},
};

describe('createResponsesAnthropicHandler', () => {
  it('posts an Anthropic request and emits Responses SSE', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'claude-sonnet-4-6',
        system: [{ type: 'text', text: 'be brief' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        max_tokens: 8192,
        stream: true,
      });
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('secret');
      expect((init?.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
      expect((init?.headers as Record<string, string>).accept).toBe('application/json');
      return anthropicStream();
    }) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({ 'x-api-key': 'secret' }),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'claude-sonnet-4-6',
        instructions: 'be brief',
        input: [{ role: 'user', content: 'hello' }],
      },
      ctx,
      res: res as never,
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://provider.example/v1/messages', expect.anything());
    expect(res.status).toBe(200);
    expect(res.chunks.join('')).toContain('event: response.output_text.delta');
    expect(res.chunks.join('')).toContain('event: response.completed');
    expect(res.chunks.join('')).toContain('"sequence_number":0');
    expect(res.ended).toBe(true);
  });

  it('normalizes provider header names before applying bridge-owned values', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        'anthropic-version': 'custom-version',
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': 'secret',
      });
      return anthropicStream();
    }) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({
        'Anthropic-Version': 'custom-version',
        'Content-Type': 'text/plain',
        Accept: 'text/event-stream',
        'X-Api-Key': 'secret',
      }),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('does not duplicate /v1 when a provider stores the versioned base URL', async () => {
    const fetchImpl = vi.fn(async () => anthropicStream()) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example/v1/',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    expect(fetchImpl).toHaveBeenCalledWith('https://provider.example/v1/messages', expect.anything());
  });

  it('converts a non-streaming JSON provider response into Responses SSE', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_json',
      type: 'message',
      model: 'claude',
      content: [{ type: 'text', text: 'json' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    const wire = res.chunks.join('');
    expect(wire).toContain('event: response.output_text.delta');
    expect(wire).toContain('event: response.completed');
  });

  it('sniffs a complete JSON body for a streaming caller when Content-Type is wrong', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_stream_json',
      type: 'message',
      model: 'claude',
      content: [{ type: 'text', text: 'buffered JSON' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    }), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    const wire = res.chunks.join('');
    expect(wire).toContain('event: response.output_text.delta');
    expect(wire).toContain('"delta":"buffered JSON"');
    expect(wire).toContain('event: response.completed');
    expect(wire).not.toContain('stream_truncated');
  });

  it('preserves an unmarked JSON error envelope for a streaming caller', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'busy' },
    }), { status: 200 })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    const wire = res.chunks.join('');
    expect(wire).toContain('event: response.failed');
    expect(wire).toContain('busy');
    expect(wire).not.toContain('stream_truncated');
  });

  it('maps a bodyless successful upstream response to a 502 bridge error', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    expect(res.status).toBe(502);
    expect(res.chunks.join('')).toContain('upstream_empty_response');
  });

  it('uses the SSE event name when the data object omits type', async () => {
    const body = [
      'event: message_start',
      'data: {"message":{"id":"msg_event_name","model":"claude"}}',
      '',
      'event: content_block_start',
      'data: {"index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"index":0,"delta":{"type":"text_delta","text":"fallback"}}',
      '',
      'event: content_block_stop',
      'data: {"index":0}',
      '',
      'event: message_delta',
      'data: {"delta":{"stop_reason":"end_turn"}}',
      '',
      'event: message_stop',
      'data: {}',
      '',
    ].join('\n');
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    const wire = res.chunks.join('');
    expect(wire).toContain('"delta":"fallback"');
    expect(wire).toContain('event: response.completed');
  });

  it('returns a JSON Responses object when the caller requests stream:false', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_json_non_stream',
      type: 'message',
      model: 'claude',
      content: [{ type: 'text', text: 'json' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'claude', stream: false, input: 'hi' },
      ctx,
      res: res as never,
    });
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.chunks.join('')) as { object: string; status: string };
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
  });

  it('sniffs an unmarked JSON body for a non-streaming caller', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_unmarked_json',
      type: 'message',
      model: 'claude',
      content: [{ type: 'text', text: 'json without a content type' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'claude', stream: false, input: 'hi' },
      ctx,
      res: res as never,
    });
    const body = JSON.parse(res.chunks.join('')) as {
      status: string;
      output: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(body.status).toBe('completed');
    expect(body.output[0]?.content?.[0]?.text).toBe('json without a content type');
  });

  it('cancels an oversized unmarked body before buffering it for a non-streaming caller', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024 * 1024 + 1)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'claude', stream: false, input: 'hi' },
      ctx,
      res: res as never,
    });
    expect(cancelled).toBe(true);
    expect(res.status).toBe(502);
    expect(res.chunks.join('')).toContain('upstream response exceeds 1 MiB');
  });

  it('counts UTF-8 bytes and cancels an oversized unmarked streaming frame', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('你'.repeat(350_000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'claude', input: 'hi' },
      ctx,
      res: res as never,
    });
    expect(cancelled).toBe(true);
    expect(res.chunks.join('')).toContain('event: response.failed');
    expect(res.chunks.join('')).toContain('upstream SSE frame exceeds 1 MiB');
  });

  it('retries one OAuth request after a provider 401 with refreshed headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(anthropicStream());
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const refreshHeaders = vi.fn(async () => ({ authorization: 'Bearer fresh' }));
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      authMode: 'oauth',
      buildHeaders: async () => ({ authorization: 'Bearer stale' }),
      refreshHeaders,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshHeaders).toHaveBeenCalledTimes(1);
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((second.headers as Record<string, string>).authorization).toBe('Bearer fresh');
    expect(res.status).toBe(200);
  });

  it('refreshes provider OAuth even when Claude request policy uses API-key mode', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(anthropicStream());
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const refreshHeaders = vi.fn(async () => ({ authorization: 'Bearer fresh' }));
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      authMode: 'api-key',
      buildHeaders: async () => ({ authorization: 'Bearer stale' }),
      refreshHeaders,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshHeaders).toHaveBeenCalledTimes(1);
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((second.headers as Record<string, string>).authorization).toBe('Bearer fresh');
    expect(res.status).toBe(200);
  });

  it('retries one 413 request with a lower image normalization tier', async () => {
    const maxEdges: number[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('too large', { status: 413 }))
      .mockResolvedValueOnce(anthropicStream());
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
      imageCodec: {
        normalize: async ({ maxEdge }) => {
          maxEdges.push(maxEdge);
          return { data: 'abc', mediaType: 'image/png' };
        },
      },
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'claude',
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }] }],
      },
      ctx,
      res: res as never,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maxEdges[0]).toBe(2000);
    expect(maxEdges).toContain(1024);
  });

  it('cancels an oversized 413 body before retrying image normalization', async () => {
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(16 * 1024 + 1)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(oversizedBody, { status: 413 }))
      .mockResolvedValueOnce(anthropicStream());
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
      imageCodec: {
        normalize: async () => ({ data: 'abc', mediaType: 'image/png' }),
      },
    }, { fetchImpl: fetchMock as unknown as typeof fetch });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'claude',
        input: [{
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }],
        }],
      },
      ctx,
      res: res as never,
    });
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('keeps refreshed OAuth headers across a following image-size retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('too large', { status: 413 }))
      .mockResolvedValueOnce(anthropicStream());
    const buildHeaders = vi.fn(async () => ({ authorization: 'Bearer stale' }));
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      authMode: 'oauth',
      buildHeaders,
      refreshHeaders: async () => ({ authorization: 'Bearer fresh' }),
      imageCodec: {
        normalize: async () => ({ data: 'abc', mediaType: 'image/png' }),
      },
    }, { fetchImpl: fetchMock as unknown as typeof fetch });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'claude',
        input: [{
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }],
        }],
      },
      ctx,
      res: res as never,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(buildHeaders).toHaveBeenCalledTimes(1);
    for (const call of fetchMock.mock.calls.slice(1)) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer fresh');
    }
    expect(res.status).toBe(200);
  });

  it('returns a Responses error for unsupported file_id images before fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'claude',
        input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }],
      },
      ctx,
      res: res as never,
    });
    expect(res.status).toBe(400);
    expect(res.chunks.join('')).toContain('unsupported_feature');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('distinguishes invalid tool requests from unsupported bridge features', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'claude',
        input: 'hi',
        stop: [123],
      },
      ctx,
      res: res as never,
    });
    expect(res.status).toBe(400);
    expect(res.chunks.join('')).toContain('"code":"invalid_request"');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects Responses sampling values outside the Anthropic range before fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'claude',
        input: 'hi',
        reasoning: { effort: 'none' },
        temperature: 1.5,
      },
      ctx,
      res: res as never,
    });
    expect(res.status).toBe(400);
    expect(res.chunks.join('')).toContain('"code":"invalid_request"');
    expect(res.chunks.join('')).toContain('temperature must be between 0 and 1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps upstream HTTP errors without leaking request credentials', async () => {
    const onUpstreamError = vi.fn();
    const fetchImpl = vi.fn(async () => new Response('bad key', { status: 401 })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({ authorization: 'Bearer secret' }),
      onUpstreamError,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    expect(res.status).toBe(401);
    expect(res.chunks.join('')).toContain('authentication_error');
    expect(onUpstreamError).toHaveBeenCalledWith(expect.objectContaining({ status: 401, body: 'bad key' }));
  });

  it('cancels and truncates an oversized upstream error body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`bad key:${'x'.repeat(16 * 1024 + 1)}`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const onUpstreamError = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 401 })) as typeof fetch;
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
      onUpstreamError,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
    expect(cancelled).toBe(true);
    expect(res.status).toBe(401);
    const body = onUpstreamError.mock.calls[0]?.[0]?.body as string;
    expect(new TextEncoder().encode(body).byteLength).toBe(16 * 1024);
    expect(res.chunks.join('').length).toBeLessThan(17 * 1024);
  });
});

/**
 * onUpstreamResponse —— 最终上游响应的元数据旁路(见 #2626)。
 * 桥不解释这些 header, 只保证「最终响应一次、重试的中间响应不报」。
 */
describe('createResponsesAnthropicHandler onUpstreamResponse', () => {
  it('reports the final headers once for a streaming success', async () => {
    const fetchImpl = vi.fn(async () => new Response(anthropicStream().body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-5h-utilization': '0.34',
      },
    })) as typeof fetch;
    const onUpstreamResponse = vi.fn();
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({ authorization: 'Bearer live' }),
      onUpstreamResponse,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });

    expect(onUpstreamResponse).toHaveBeenCalledTimes(1);
    const info = onUpstreamResponse.mock.calls[0][0];
    expect(info.status).toBe(200);
    expect(info.responseHeaders.get('anthropic-ratelimit-unified-5h-utilization')).toBe('0.34');
    // 请求头按发出去的那一份传出 —— 账号归属靠它
    expect(info.requestHeaders.authorization).toBe('Bearer live');
    expect(res.status).toBe(200);
  });

  it('reports once for a non-streaming success', async () => {
    const fetchImpl = vi.fn(async () => new Response(anthropicStream().body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed' },
    })) as typeof fetch;
    const onUpstreamResponse = vi.fn();
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
      onUpstreamResponse,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'claude', input: 'hi', stream: false },
      ctx,
      res: res as never,
    });

    expect(onUpstreamResponse).toHaveBeenCalledTimes(1);
    expect(onUpstreamResponse.mock.calls[0][0].responseHeaders.get('anthropic-ratelimit-unified-status'))
      .toBe('allowed');
  });

  it('reports the final non-2xx response too', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', {
      status: 429,
      headers: { 'anthropic-ratelimit-unified-status': 'rejected' },
    })) as typeof fetch;
    const onUpstreamResponse = vi.fn();
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
      onUpstreamResponse,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });

    expect(onUpstreamResponse).toHaveBeenCalledTimes(1);
    expect(onUpstreamResponse.mock.calls[0][0].status).toBe(429);
    expect(res.status).toBe(429);
  });

  it('skips the intermediate 401 and reports only the refreshed response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('expired', {
        status: 401,
        headers: { 'anthropic-ratelimit-unified-status': 'stale-should-not-be-reported' },
      }))
      .mockResolvedValueOnce(new Response(anthropicStream().body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed' },
      }));
    const onUpstreamResponse = vi.fn();
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({ authorization: 'Bearer stale' }),
      refreshHeaders: async () => ({ authorization: 'Bearer fresh' }),
      onUpstreamResponse,
    }, { fetchImpl: fetchMock as unknown as typeof fetch });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUpstreamResponse).toHaveBeenCalledTimes(1);
    const info = onUpstreamResponse.mock.calls[0][0];
    expect(info.status).toBe(200);
    expect(info.responseHeaders.get('anthropic-ratelimit-unified-status')).toBe('allowed');
    // 换过凭据后的请求头才是这次响应的归属依据
    expect(info.requestHeaders.authorization).toBe('Bearer fresh');
  });

  it('skips the intermediate 413 and reports only the downscaled retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('too large', { status: 413 }))
      .mockResolvedValueOnce(new Response(anthropicStream().body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed' },
      }));
    const onUpstreamResponse = vi.fn();
    const handler = createResponsesAnthropicHandler({
      upstreamBase: 'https://provider.example',
      buildHeaders: async () => ({}),
      imageCodec: { normalize: async () => ({ data: 'abc', mediaType: 'image/png' }) },
      onUpstreamResponse,
    }, { fetchImpl: fetchMock as unknown as typeof fetch });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'claude',
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }] }],
      },
      ctx,
      res: res as never,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUpstreamResponse).toHaveBeenCalledTimes(1);
    expect(onUpstreamResponse.mock.calls[0][0].status).toBe(200);
  });

  it('never lets a throwing or rejecting callback affect the response', async () => {
    const fetchImpl = vi.fn(async () => anthropicStream()) as typeof fetch;
    for (const onUpstreamResponse of [
      () => { throw new Error('sync boom'); },
      async () => { throw new Error('async boom'); },
    ]) {
      const handler = createResponsesAnthropicHandler({
        upstreamBase: 'https://provider.example',
        buildHeaders: async () => ({}),
        onUpstreamResponse,
      }, { fetchImpl });
      const res = new FakeResponse();
      await handler.handle({ parsedBody: { model: 'claude', input: 'hi' }, ctx, res: res as never });
      expect(res.status).toBe(200);
      expect(res.chunks.join('')).toContain('event: response.completed');
      expect(res.ended).toBe(true);
    }
  });
});
