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

  it('drops an unsupported built-in web_search tool and continues upstream', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([
        { type: 'function', function: { name: 'exec', parameters: { type: 'object' } } },
      ]);
      return streamResponse([
        { id: 'chat_1', choices: [{ delta: { content: 'ok' } }] },
        { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;
    const warn = vi.fn();
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl, logger: { warn } });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'custom-model',
        input: [{ type: 'message', role: 'user', content: 'search' }],
        tools: [
          { type: 'function', name: 'exec', parameters: { type: 'object' } },
          { type: 'web_search' },
        ],
      },
      res: res as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.chunks.join('')).toContain('ok');
    expect(res.ended).toBe(true);
    expect(warn).toHaveBeenCalledWith('responses-chat bridge dropped unsupported built-in tool', {
      model: 'custom-model',
      tool: 'web_search',
      index: 1,
      action: 'continue_without_tool',
    });
  });

  it('rejects an explicit tool_choice for a dropped web_search tool', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const warn = vi.fn();
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl, logger: { warn } });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'custom-model',
        input: [{ type: 'message', role: 'user', content: 'search' }],
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'function', name: 'web_search' },
      },
      res: res as never,
    });

    expect(res.status).toBe(400);
    expect(res.chunks.join('')).toContain('unsupported_feature');
    expect(res.chunks.join('')).toContain('tool_choice.web_search');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('responses-chat bridge rejected unsupported feature', {
      model: 'custom-model',
      feature: 'tool_choice.web_search',
    });
  });

  it('rejects a required tool_choice when the only tool is a dropped web_search', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const warn = vi.fn();
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl, logger: { warn } });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'custom-model',
        input: [{ type: 'message', role: 'user', content: 'search' }],
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
      },
      res: res as never,
    });

    expect(res.status).toBe(400);
    expect(res.chunks.join('')).toContain('unsupported_feature');
    expect(res.chunks.join('')).toContain('tool_choice.web_search');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a required tool_choice when another tool survives beside web_search', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([
        { type: 'function', function: { name: 'exec', parameters: { type: 'object' } } },
      ]);
      expect(body.tool_choice).toBe('required');
      return streamResponse([
        { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'custom-model',
        input: [{ type: 'message', role: 'user', content: 'do it' }],
        tools: [
          { type: 'function', name: 'exec', parameters: { type: 'object' } },
          { type: 'web_search' },
        ],
        tool_choice: 'required',
      },
      res: res as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('keeps a same-named retained function tool selectable beside web_search', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([
        { type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } },
      ]);
      expect(body.tool_choice).toEqual({
        type: 'function',
        function: { name: 'web_search' },
      });
      return streamResponse([
        { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'custom-model',
        input: [{ type: 'message', role: 'user', content: 'call the function' }],
        tools: [
          { type: 'function', name: 'web_search', parameters: { type: 'object' } },
          { type: 'web_search' },
        ],
        tool_choice: { type: 'function', name: 'web_search' },
      },
      res: res as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('keeps a same-named string custom tool selectable beside web_search', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools?.map((tool: { function: { name: string } }) => tool.function.name))
        .toContain('web_search');
      expect(body.tool_choice).toEqual({
        type: 'function',
        function: { name: 'web_search' },
      });
      return streamResponse([
        { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'custom-model',
        input: [{ type: 'message', role: 'user', content: 'call the custom tool' }],
        tools: ['web_search', { type: 'web_search' }],
        tool_choice: { type: 'custom', name: 'web_search' },
      },
      res: res as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('keeps a nested same-named function selectable beside web_search', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools?.map((tool: { function: { name: string } }) => tool.function.name))
        .toContain('web_search');
      expect(body.tool_choice).toEqual({
        type: 'function',
        function: { name: 'web_search' },
      });
      return streamResponse([
        { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: {
        model: 'custom-model',
        input: [{ type: 'message', role: 'user', content: 'call the nested function' }],
        tools: [
          { type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } },
          { type: 'web_search' },
        ],
        tool_choice: { type: 'function', name: 'web_search' },
      },
      res: res as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
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

  it('posts image_url content by default without logging image data', async () => {
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

  it('translates non-streaming Chat JSON into a non-streaming Responses response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'chat_json',
      model: 'real-model',
      choices: [{
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'm', input: 'hi', stream: false },
      res: res as never,
    });
    const response = JSON.parse(res.chunks.join('')) as {
      status: string;
      output: Array<{ type: string; content?: Array<{ text: string }> }>;
      usage: { total_tokens: number };
    };
    expect(res.status).toBe(200);
    expect(response.status).toBe('completed');
    expect(response.output[0].content?.[0].text).toBe('hello');
    expect(response.usage.total_tokens).toBe(3);
  });

  it('returns only the terminal Responses object when a non-streaming request receives SSE', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([
      { id: 'chat_sse_json', choices: [{ delta: { content: 'hello ' } }] },
      { id: 'chat_sse_json', choices: [{ delta: { content: 'world' } }] },
      { id: 'chat_sse_json', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'm', input: 'hi', stream: false },
      res: res as never,
    });
    const response = JSON.parse(res.chunks.join('')) as {
      status: string;
      output: Array<{ type: string; content?: Array<{ text: string }> }>;
    };
    expect(res.status).toBe(200);
    expect(response.status).toBe('completed');
    expect(response.output.find((item) => item.type === 'message')?.content?.[0]?.text).toBe('hello world');
    expect(res.chunks.join('')).not.toContain('response.output_text.delta');
  });

  it('adapts a JSON response even when a streaming provider ignores stream=true', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 'chat_json',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'm', input: 'hi' },
      res: res as never,
    });
    expect(res.status).toBe(200);
    expect(res.chunks.join('')).toContain('event: response.completed');
  });

  it('cancels an oversized non-SSE body after parsing the bounded JSON prefix', async () => {
    const json = JSON.stringify({
      id: 'chat_bounded',
      choices: [{ message: { role: 'assistant', content: 'bounded' }, finish_reason: 'stop' }],
    });
    const encoder = new TextEncoder();
    const padding = new Uint8Array(1024 * 1024).fill(0x20);
    let paddingChunks = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(json));
      },
      pull(controller) {
        paddingChunks += 1;
        if (paddingChunks <= 17) controller.enqueue(padding);
        else controller.close();
      },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();

    await handler.handle({
      parsedBody: { model: 'm', input: 'hi', stream: false },
      res: res as never,
    });

    const response = JSON.parse(res.chunks.join('')) as {
      output: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(res.status).toBe(200);
    expect(response.output[0].content?.[0].text).toBe('bounded');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
