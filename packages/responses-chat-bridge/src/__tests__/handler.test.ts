import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createResponsesChatHandler } from '../handler.js';

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

function streamResponse(lines: unknown[]): Response {
  const body = lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('createResponsesChatHandler', () => {
  it('posts translated Chat request and streams Responses events', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'real-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      });
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
      return streamResponse([
        { id: 'chat_1', model: 'real-model', choices: [{ delta: { content: 'hi' } }] },
        { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1/',
      buildHeaders: async () => ({ authorization: 'Bearer secret' }),
      rewriteModel: () => 'real-model',
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'wire/model',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      },
      res: res as never,
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://provider.example/v1/chat/completions', expect.anything());
    expect(res.status).toBe(200);
    const wire = res.chunks.join('');
    expect(wire).toContain('event: response.output_text.delta\n');
    expect(wire).toContain('event: response.completed\n');
    expect(wire).toContain('"sequence_number":0');
    expect(wire).toContain('"sequence_number":1');
    expect(res.ended).toBe(true);
  });

  it('accepts a final SSE data event without a trailing newline', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"id":"chat_tail","choices":[{"delta":{"content":"tail"},"finish_reason":"stop"}]}',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'm', input: 'hi' },
      res: res as never,
    });
    expect(res.chunks.join('')).toContain('"delta":"tail"');
  });

  it('fails a cleanly truncated SSE stream without finish_reason or DONE', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"id":"chat_partial","choices":[{"delta":{"content":"partial"}}]}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });
    const wire = res.chunks.join('');
    expect(wire).toContain('event: response.failed');
    expect(wire).not.toContain('event: response.completed');
  });

  it('accepts DONE as a terminal marker when finish_reason is absent', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"id":"chat_done","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });
    expect(res.chunks.join('')).toContain('event: response.completed');
  });

  it('broadcasts a streamed provider error before failing the Responses stream', async () => {
    const onUpstreamError = vi.fn(async () => undefined);
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({ authorization: 'Bearer secret' }),
      onUpstreamError,
    }, {
      fetchImpl: vi.fn(async () => new Response(
        'data: {"error":{"message":"rate limited","status":429}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch,
    });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });
    expect(onUpstreamError).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }));
    expect(res.chunks.join('')).toContain('event: response.failed');
  });

  it('fails a malformed SSE frame instead of silently completing', async () => {
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, {
      fetchImpl: vi.fn(async () => new Response(
        'data: {"id":"chat_partial","choices":[{"delta":{"content":"partial"}}]}\n\ndata: {not-json}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch,
    });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });
    const wire = res.chunks.join('');
    expect(wire).toContain('event: response.failed');
    expect(wire).not.toContain('event: response.completed');
  });

  it('rejects unsupported input before resolving credentials', async () => {
    const buildHeaders = vi.fn(async () => ({ authorization: 'Bearer secret' }));
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders,
    });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'm', input: [{ type: 'computer_call' }] },
      res: res as never,
    });
    expect(res.status).toBe(400);
    expect(res.chunks.join('')).toContain('unsupported_feature');
    expect(buildHeaders).not.toHaveBeenCalled();
  });

  it('runs the provider error callback before returning the original status', async () => {
    const order: string[] = [];
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({ authorization: 'Bearer secret' }),
      onUpstreamError: async ({ status, requestHeaders }) => {
        expect(status).toBe(429);
        expect(requestHeaders.authorization).toBe('Bearer secret');
        order.push('callback');
      },
    }, {
      fetchImpl: vi.fn(async () => new Response('{"error":"slow down"}', { status: 429 })) as typeof fetch,
    });
    const res = new FakeResponse();
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => {
      order.push('response');
      return originalWriteHead(status, headers);
    };
    await handler.handle({
      parsedBody: { model: 'm', input: 'hi' },
      res: res as never,
    });
    expect(order).toEqual(['callback', 'response']);
    expect(res.status).toBe(429);
    expect(res.chunks.join('')).toContain('slow down');
  });
});
