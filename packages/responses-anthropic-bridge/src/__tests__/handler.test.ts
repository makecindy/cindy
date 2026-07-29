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
        tools: [
          {
            type: 'namespace',
            name: 'a',
            tools: [{ type: 'function', name: 'b__c', parameters: {} }],
          },
          {
            type: 'namespace',
            name: 'a__b',
            tools: [{ type: 'function', name: 'c', parameters: {} }],
          },
        ],
      },
      ctx,
      res: res as never,
    });
    expect(res.status).toBe(400);
    expect(res.chunks.join('')).toContain('"code":"invalid_request"');
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
});
