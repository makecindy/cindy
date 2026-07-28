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

  it('preserves the upstream base query when applying the chat path', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    ) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/gateway?tenant=acme',
      chatCompletionsPath: '/infer?stream=1&next=%2fadmin',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://provider.example/gateway/infer?tenant=acme&stream=1&next=%2fadmin',
      expect.anything(),
    );
  });

  it('trims a long trailing-slash run in linear time before applying the chat path', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    ) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: `https://provider.example/v1${'/'.repeat(4_096)}`,
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();

    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://provider.example/v1/chat/completions',
      expect.anything(),
    );
  });

  it.each([
    ['an invalid upstream base URL', 'ftp://provider.example/v1', '/chat/completions'],
    ['an invalid chat path', 'https://provider.example/v1', '//attacker.example/chat'],
    ['a raw non-ASCII chat path', 'https://provider.example/v1', '/café'],
    ['a control character in the chat path', 'https://provider.example/v1', '/chat\u007f'],
    ['a backslash in the chat path', 'https://provider.example/v1', '/v1\\chat'],
    ['a dot segment in the chat path', 'https://provider.example/v1', '/../admin'],
    ['an encoded dot segment in the chat path', 'https://provider.example/v1', '/%2e%2e/admin'],
    ['an encoded slash in the chat path', 'https://provider.example/v1', '/%2e%2e%2fadmin'],
    ['an encoded backslash in the chat path', 'https://provider.example/v1', '/safe%5Cpart'],
    ['a WHATWG-normalized character in the chat path', 'https://provider.example/v1', '/a<b'],
    ['an incomplete percent escape', 'https://provider.example/v1', '/chat%2'],
    ['an invalid percent escape', 'https://provider.example/v1', '/%ZZ'],
    ['an oversized chat path', 'https://provider.example/v1', `/${'a'.repeat(2_048)}`],
  ])('reports %s as configuration failure before fetching', async (_case, upstreamBase, chatCompletionsPath) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const buildHeaders = vi.fn(async () => ({ authorization: 'Bearer secret' }));
    const handler = createResponsesChatHandler({
      upstreamBase,
      chatCompletionsPath,
      buildHeaders,
    }, { fetchImpl });
    const res = new FakeResponse();

    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });

    expect(res.status).toBe(502);
    expect(res.chunks.join('')).toContain('invalid_upstream_config');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(buildHeaders).not.toHaveBeenCalled();
  });

  it('posts capability-gated image_url content without logging image data', async () => {
    const imageUrl = 'data:image/png;base64,SECRET_IMAGE_DATA';
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'kimi-k3',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
      });
      return streamResponse([
        { id: 'chat_image', model: 'kimi-k3', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://api.moonshot.cn/v1',
      buildHeaders: async () => ({ authorization: 'Bearer secret' }),
      capabilities: { imageInput: 'image_url' },
    }, { fetchImpl, logger });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'kimi-k3',
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: imageUrl },
          ],
        }],
      },
      res: res as never,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    const logCalls = [
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    expect(JSON.stringify(logCalls)).not.toContain('SECRET_IMAGE_DATA');
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

  it('keeps image input disabled by default and rejects it before credentials or network', async () => {
    const buildHeaders = vi.fn(async () => ({ authorization: 'Bearer secret' }));
    const fetchImpl = vi.fn<typeof fetch>();
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders,
    }, { fetchImpl });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'm',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,eA==' }],
        }],
      },
      res: res as never,
    });

    expect(res.status).toBe(400);
    expect(res.chunks.join('')).toContain('unsupported_feature');
    expect(buildHeaders).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
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
