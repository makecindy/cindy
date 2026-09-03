import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createResponsesChatHandler } from '../handler.js';
import type { ChatBridgeCapabilities, ChatCompletionsRequest, ResponsesRequest } from '../types.js';

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

function systemOrderError(status = 400, message = 'System message must be at the beginning.'): Response {
  return new Response(JSON.stringify({ error: { message, type: 'BadRequestError' } }), { status });
}

// Reduced shape of the real Codex capture: instructions + developer, user, user.
// Exact captured text is replayed separately against the official Qwen template.
function leadingSystemRequest(): ResponsesRequest {
  return {
    model: 'qwen3.8-27b-fp8',
    instructions: 'base instructions',
    input: [
      { role: 'developer', content: 'permission instructions' },
      { role: 'user', content: 'environment context' },
      { role: 'user', content: 'hello' },
    ],
  };
}

describe('createResponsesChatHandler', () => {
  it.each([undefined, 'coalesce-leading'] as const)(
    'retries a rejected consecutive system prefix (#3583), policy=%s',
    async (systemMessagePolicy) => {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body: ChatCompletionsRequest = JSON.parse(String(init?.body));
        expect(body).not.toHaveProperty('reasoning_effort');
        if (body.messages.slice(1).some((message) => message.role === 'system')) {
          return systemOrderError();
        }
        expect(body.messages).toEqual([
          { role: 'system', content: 'base instructions\n\npermission instructions' },
          { role: 'user', content: 'environment context' },
          { role: 'user', content: 'hello' },
        ]);
        return streamResponse([
          { id: 'chat_1', choices: [{ delta: { content: 'hi' } }] },
          { id: 'chat_1', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
      });
      const onUpstreamError = vi.fn();
      const handler = createResponsesChatHandler({
        upstreamBase: 'https://vllm.example/v1',
        buildHeaders: async () => ({}),
        capabilities: { systemMessagePolicy },
        onUpstreamError,
      }, { fetchImpl });
      const res = new FakeResponse();
      await handler.handle({
        parsedBody: { ...leadingSystemRequest(), reasoning: { effort: 'high' } },
        res: res as never,
      });
      expect(res.status).toBe(200);
      expect(res.chunks.join('')).toContain('event: response.completed');
      expect(fetchImpl).toHaveBeenCalledTimes(systemMessagePolicy ? 1 : 2);
      expect(onUpstreamError).not.toHaveBeenCalled();
    },
  );

  it('leaves a consecutive system prefix intact when the upstream accepts it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).messages).toEqual([
        { role: 'system', content: 'base instructions' },
        { role: 'system', content: 'permission instructions' },
        { role: 'user', content: 'environment context' },
        { role: 'user', content: 'hello' },
      ]);
      return streamResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    });
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1', buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: leadingSystemRequest(), res: res as never });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('preserves whitespace and repeated instructions without depending on a model alias', async () => {
    const bodies: ChatCompletionsRequest[] = [];
    const instruction = '  permission boundary\r\nkeep this text\n';
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return systemOrderError();
      return streamResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    });
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
      capabilities: { reasoningField: 'reasoning_effort', reasoningEffortMap: { high: 'xhigh' } },
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: {
        model: 'custom-alias', instructions: instruction, reasoning: { effort: 'high' },
        input: [
          { role: 'developer', content: instruction },
          { role: 'system', content: 'last instruction' },
          { role: 'user', content: 'hello' },
        ],
      },
      res: res as never,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toEqual({
      ...bodies[0],
      messages: [
        { role: 'system', content: `${instruction}\n\n${instruction}\n\nlast instruction` },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(bodies[1].reasoning_effort).toBe('xhigh');
    expect(res.status).toBe(200);
  });

  it.each<{
    name: string;
    status?: number;
    message?: string;
    errorBody?: string;
    capabilities?: ChatBridgeCapabilities;
    input?: ResponsesRequest;
  }>([
    { name: 'explicit preserve policy', capabilities: { systemMessagePolicy: 'preserve' } },
    { name: 'native developer role', capabilities: { developerRole: 'developer' } },
    { name: 'already coalesced policy', capabilities: { systemMessagePolicy: 'coalesce-leading' } },
    { name: 'already leading system', input: { model: 'm', instructions: 'base', input: 'hello' } },
    { name: 'system after user', input: { model: 'm', instructions: 'base', input: [
      { role: 'user', content: 'hello' }, { role: 'developer', content: 'later instructions' },
    ] } },
    { name: 'leading prefix followed by a late system', input: { ...leadingSystemRequest(), input: [
      { role: 'developer', content: 'initial permissions' },
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'updated permissions' },
    ] } },
    { name: 'no leading prefix', input: { model: 'm', input: [
      { role: 'user', content: 'hello' }, { role: 'system', content: 'later instructions' },
    ] } },
    { name: 'empty system only', input: { model: 'm', input: [
      { role: 'user', content: 'hi' }, { role: 'system', content: '' },
    ] } },
    { name: 'authentication error', status: 401 },
    { name: 'permission error', status: 403 },
    { name: 'validation error', status: 422 },
    { name: 'rate limit', status: 429 },
    { name: 'server error', status: 500 },
    { name: 'different role error', message: 'Unexpected message role.' },
    { name: 'quoted error in unrelated rejection', message: 'Invalid content: System message must be at the beginning.' },
    { name: 'unstructured error', errorBody: 'System message must be at the beginning.' },
    { name: 'non-string error message', errorBody: '{"error":{"message":null}}' },
  ])('does not retry system normalization for $name', async ({ status = 400, message, errorBody, capabilities, input }) => {
    const fetchImpl = vi.fn(async () => errorBody === undefined
      ? systemOrderError(status, message)
      : new Response(errorBody, { status }));
    const onUpstreamError = vi.fn();
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://vllm.example/v1',
      buildHeaders: async () => ({}),
      capabilities,
      onUpstreamError,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: input ?? leadingSystemRequest(), res: res as never });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res.status).toBe(status);
    expect(onUpstreamError).toHaveBeenCalledOnce();
    expect(res.listenerCount('close')).toBe(0);
  });

  it.each([400, 401, 503])('reports only the final error when the compatibility retry fails with %s', async (status) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(systemOrderError())
      .mockResolvedValueOnce(systemOrderError(status));
    const onUpstreamError = vi.fn();
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://vllm.example/v1',
      buildHeaders: async () => ({}),
      onUpstreamError,
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: leadingSystemRequest(), res: res as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(status);
    expect(onUpstreamError).toHaveBeenCalledOnce();
    expect(onUpstreamError).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(res.listenerCount('close')).toBe(0);
  });

  it('preserves tools, media, tuning and the original input across a request-local retry', async () => {
    const bodies: ChatCompletionsRequest[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) return systemOrderError();
      return new Response(JSON.stringify({
        id: 'chat_json',
        choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      }), { headers: { 'content-type': 'application/json' } });
    });
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://vllm.example/v1',
      buildHeaders: async () => ({ authorization: 'Bearer test-token' }),
      capabilities: { imageInput: 'image_url', passthroughFields: ['temperature'] },
    }, { fetchImpl });
    const source: ResponsesRequest = {
      ...leadingSystemRequest(),
      stream: false,
      temperature: 0.2,
      tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object' } }],
      input: [
        { role: 'developer', content: 'permission instructions' },
        { role: 'user', content: 'first' },
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'tool result' },
        { role: 'user', content: [{ type: 'input_image', image_url: 'https://image.example/test.png' }] },
      ],
    };
    const original = structuredClone(source);
    const res = new FakeResponse();
    await handler.handle({ parsedBody: source, res: res as never });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.chunks.join('')).status).toBe('completed');
    const { messages: firstMessages, ...firstFields } = bodies[0];
    const { messages: retryMessages, ...retryFields } = bodies[1];
    expect(retryFields).toEqual(firstFields);
    expect(retryMessages).toEqual([
      { role: 'system', content: 'base instructions\n\npermission instructions' },
      ...firstMessages.filter((message) => message.role !== 'system'),
    ]);
    expect(source).toEqual(original);
    expect(fetchImpl.mock.calls[1][0]).toBe(fetchImpl.mock.calls[0][0]);
    expect(fetchImpl.mock.calls[1][1]?.headers).toEqual(fetchImpl.mock.calls[0][1]?.headers);
    expect(fetchImpl.mock.calls[1][1]?.signal).toBe(fetchImpl.mock.calls[0][1]?.signal);

    // A later request must not inherit a policy learned from this request's upstream error.
    const next = new FakeResponse();
    await handler.handle({ parsedBody: source, res: next as never });
    expect(bodies[2]).toEqual(bodies[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry after the client disconnects while reading the template error', async () => {
    const res = new FakeResponse();
    const response = systemOrderError();
    const read = response.text.bind(response);
    vi.spyOn(response, 'text').mockImplementation(async () => {
      res.emit('close');
      return read();
    });
    const fetchImpl = vi.fn(async () => response);
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://vllm.example/v1', buildHeaders: async () => ({}),
    }, { fetchImpl });
    await handler.handle({ parsedBody: leadingSystemRequest(), res: res as never });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res.headersSent).toBe(false);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('cleans up when the compatibility retry cannot reach the upstream', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(systemOrderError())
      .mockRejectedValueOnce(new Error('network unavailable'));
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://vllm.example/v1', buildHeaders: async () => ({}),
    }, { fetchImpl });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: leadingSystemRequest(), res: res as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
    expect(res.chunks.join('')).toContain('upstream_unreachable');
    expect(res.listenerCount('close')).toBe(0);
  });

  it('does not report or write a retry error after the client disconnects during its body read', async () => {
    const res = new FakeResponse();
    const response = systemOrderError();
    const read = response.text.bind(response);
    vi.spyOn(response, 'text').mockImplementation(async () => {
      res.emit('close');
      return read();
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(systemOrderError())
      .mockResolvedValueOnce(response);
    const onUpstreamError = vi.fn();
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://vllm.example/v1', buildHeaders: async () => ({}), onUpstreamError,
    }, { fetchImpl });
    await handler.handle({ parsedBody: leadingSystemRequest(), res: res as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.headersSent).toBe(false);
    expect(onUpstreamError).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });

  it('aborts the compatibility retry when the client disconnects', async () => {
    const res = new FakeResponse();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(systemOrderError())
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        res.emit('close');
        expect(init?.signal?.aborted).toBe(true);
        throw new Error('aborted');
      });
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://vllm.example/v1', buildHeaders: async () => ({}),
    }, { fetchImpl });
    await handler.handle({ parsedBody: leadingSystemRequest(), res: res as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.headersSent).toBe(false);
    expect(res.listenerCount('close')).toBe(0);
  });

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

  it('cancels the upstream reader after a terminal provider error on a held-open stream (#2839)', async () => {
    // provider 发出流内终态错误后保持连接不关:桥必须停止读取、取消上游
    // reader 并及时结束下游响应,而不是继续等 EOF。
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"error":{"message":"provider failed","status":502}}\n\n'
          // 同一 chunk 里错误帧之后的剩余帧不再解析。
          + 'data: {"id":"chat_after","choices":[{"delta":{"content":"stale"}}]}\n\n',
        ));
        // 故意不 close。
      },
      cancel: cancelled,
    });
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, {
      fetchImpl: vi.fn(async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch,
    });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });
    const wire = res.chunks.join('');
    expect(wire).toContain('event: response.failed');
    expect(wire).not.toContain('stale');
    expect(res.ended).toBe(true);
    expect(cancelled).toHaveBeenCalled();
  });

  it('finishes the downstream response even when upstream cancellation never settles (#2839)', async () => {
    // 注入的 fetchImpl 可能给出取消长期 pending 的流:挂起的 reader.cancel()
    // 不能阻塞下游收口。
    const cancelled = vi.fn(() => new Promise<never>(() => {
      // 故意永不 settle。
    }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"error":{"message":"provider failed","status":502}}\n\n',
        ));
        // 故意不 close。
      },
      cancel: cancelled,
    });
    const handler = createResponsesChatHandler({
      upstreamBase: 'https://provider.example/v1',
      buildHeaders: async () => ({}),
    }, {
      fetchImpl: vi.fn(async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch,
    });
    const res = new FakeResponse();
    await handler.handle({ parsedBody: { model: 'm', input: 'hi' }, res: res as never });
    expect(res.chunks.join('')).toContain('event: response.failed');
    expect(res.ended).toBe(true);
    expect(cancelled).toHaveBeenCalled();
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

  it('surfaces Ollama prompt-validation 500 without relabeling it as overload', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'system message must be at the beginning' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    const handler = createResponsesChatHandler({
      upstreamBase: 'http://127.0.0.1:11434/v1',
      buildHeaders: async () => ({}),
    }, { fetchImpl, logger: { warn } });
    const res = new FakeResponse();
    await handler.handle({
      parsedBody: { model: 'qwen3.8:27b-mxfp8', input: 'hi' },
      res: res as never,
    });
    expect(res.status).toBe(500);
    expect(res.chunks.join('')).toContain('system message must be at the beginning');
    expect(warn).toHaveBeenCalledWith(
      'responses-chat bridge upstream error',
      expect.objectContaining({
        status: 500,
        errorKind: 'json',
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('system message must be at the beginning');
  });
});
