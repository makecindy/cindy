/**
 * handler 单测(不联网):mock global fetch,验证
 *   - prefs(effort / fast)→ 上游请求体的 reasoning.effort / service_tier 映射
 *   - 上游 SSE → Anthropic SSE 的端到端写回(经真实 ServerResponse)
 *   - count_tokens 本地估算、no-provider 400、buildHeaders 失败 502、未实现 wireProtocol fail-fast
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createResponsesHandler, type BridgeSessionPrefs, type ResponsesBridgeHandler } from '../handler.js';
import type { BridgeProviderConfig } from '../types.js';

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(`data: ${l}\n\n`));
      controller.close();
    },
  });
}

const OK_SSE = [
  JSON.stringify({ type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } }),
  JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
  JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'hi' }),
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message' } }),
  JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }),
];

/** 原样投递一段 SSE 文本(用于构造跨多行 data: 的事件)。 */
function rawStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function providerConfig(overrides?: Partial<BridgeProviderConfig>): BridgeProviderConfig {
  return {
    prefix: 'chatgpt/',
    upstreamBase: 'https://upstream.example',
    fastServiceTier: 'priority',
    buildHeaders: async () => ({ authorization: 'Bearer t' }),
    ...overrides,
  };
}

/** 经真实 HTTP 往返调 handler(拿真 ServerResponse,断言写回字节)。 */
async function invoke(
  handler: ResponsesBridgeHandler,
  body: unknown,
  opts?: { url?: string; prefs?: BridgeSessionPrefs },
): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  const server: Server = createServer((req, res) => {
    void handler.handle({
      parsedBody: body,
      ctx: { method: 'POST', url: opts?.url ?? '/v1/messages', headers: { 'x-claude-code-session-id': 's1' } },
      res,
      prefs: opts?.prefs,
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    // 用 node:http 直连 harness —— 全局 fetch 已被 stub 成 mock 上游,不能拿来打 harness。
    return await new Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createResponsesHandler', () => {
  it('prefs.fast + effort → 上游请求体 service_tier / reasoning.effort;SSE 翻译写回', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(sse(OK_SSE), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const handler = createResponsesHandler({ providers: [providerConfig()] });

    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: true }, { prefs: { fast: true, reasoningEffort: 'xhigh' } });
    expect(r.status).toBe(200);
    expect(r.text).toContain('message_start');
    expect(r.text).toContain('"chatgpt/gpt-5.5"'); // message_start 回显带前缀 model(记账判据)
    expect(r.text).toContain('"service_tier":"priority"');
    expect(r.text).toContain('message_stop');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://upstream.example/responses');
    expect(seen[0].body.model).toBe('gpt-5.5');
    expect(seen[0].body.service_tier).toBe('priority');
    expect((seen[0].body.reasoning as Record<string, unknown>).effort).toBe('xhigh');

    // fast=false / provider 无 fastServiceTier → 不发 service_tier。
    seen.length = 0;
    const standard = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: true }, { prefs: { fast: false } });
    expect(seen[0].body.service_tier).toBeUndefined();
    expect(standard.text).toContain('"service_tier":"default"');
  });

  it('provider.strictFunctionTools 是生产控制面:启用 provider 逐工具 strict,未启用 provider 全 false', async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ body: JSON.parse(String(init.body)) });
      return new Response(sse(OK_SSE), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const handler = createResponsesHandler({
      providers: [
        providerConfig(), // chatgpt/:未声明 strictFunctionTools → 默认全 false
        providerConfig({ prefix: 'xai/', strictFunctionTools: () => true }),
      ],
    });
    const tools = [
      {
        name: 'Conforming',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        // Edit 真实形态:optional replace_all → 即使 provider 启用也回落 strict:false
        name: 'Edit',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' }, replace_all: { type: 'boolean' } },
          required: ['file_path'],
          additionalProperties: false,
        },
      },
    ];

    await invoke(handler, { model: 'xai/grok-4.6', messages: [], stream: true, tools });
    await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: true, tools });

    expect(seen).toHaveLength(2);
    const strictOf = (body: Record<string, unknown>): Array<boolean | undefined> =>
      (body.tools as Array<{ strict?: boolean }>).map((t) => t.strict);
    // xai/:合规工具 strict:true,不合规工具回落 false
    expect(strictOf(seen[0].body)).toEqual([true, false]);
    // chatgpt/:provider 未启用 → 全 false
    expect(strictOf(seen[1].body)).toEqual([false, false]);
  });

  it('上游 200 但整流零事件(非 SSE 正文)→ 合成带正文前缀的 error 事件而非空 200,并留 warn(#941)', async () => {
    const warns: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"error":{"message":"prompt too large for context window"}}'));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const handler = createResponsesHandler({
      providers: [providerConfig()],
      logger: { warn: (msg) => warns.push(msg) },
    });
    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: true });
    expect(r.status).toBe(200);
    expect(r.text).toContain('event: error');
    expect(r.text).toContain('no translatable SSE events');
    // 上游正文前缀进错误信息:真实错误不再被空 200 掩盖。
    expect(r.text).toContain('prompt too large for context window');
    expect(warns).toContain('upstream 2xx with non-SSE content-type');
    expect(warns).toContain('upstream stream yielded no translatable events');
  });

  it('content-type 判定大小写不敏感:Text/Event-Stream 不触发 non-SSE warn', async () => {
    const warns: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(OK_SSE), {
      status: 200,
      headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' },
    })));
    const handler = createResponsesHandler({
      providers: [providerConfig()],
      logger: { warn: (msg) => warns.push(msg) },
    });
    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: true });
    expect(r.text).toContain('message_stop');
    expect(warns).not.toContain('upstream 2xx with non-SSE content-type');
  });

  it('已写出部分事件后断流 → error 事件收尾,不补 message_stop 伪装正常完成(#941 review)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      (() => {
        // pull 式逐块投递:start 里 enqueue 后立即 error 会按 Streams 规范丢弃整个
        // 未读队列,前面的块根本到不了 handler。
        let step = 0;
        return new ReadableStream<Uint8Array>({
          pull(c) {
            if (step < 3) {
              c.enqueue(new TextEncoder().encode(`data: ${OK_SSE[step]}\n\n`));
              step += 1;
            } else {
              c.error(new Error('socket reset'));
            }
          },
        });
      })(),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));
    const handler = createResponsesHandler({ providers: [providerConfig()] });
    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: true });
    expect(r.text).toContain('message_start');
    expect(r.text).toContain('upstream stream error: socket reset');
    // 截断响应必须以 error 事件收尾,不能以 message_stop 伪装正常完成。
    expect(r.text).not.toContain('message_stop');
  });

  it('上游流内 OpenAI 风格 error 帧 → 透传为 Anthropic error 事件,不合成零事件错误(#941)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      sse([JSON.stringify({ error: { message: 'boom', code: 'server_error' } })]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));
    const handler = createResponsesHandler({ providers: [providerConfig()] });
    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: true });
    expect(r.status).toBe(200);
    expect(r.text).toContain('[server_error] boom');
    expect(r.text).not.toContain('no translatable SSE events');
  });

  it('wire model 带 [1m] 后缀 → 上游 model 剥后缀(目录 1M 模型经 toSdkModelString 会带)', async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ body: JSON.parse(String(init.body)) });
      return new Response(sse(OK_SSE), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const handler = createResponsesHandler({ providers: [providerConfig({ prefix: 'xai/' })] });

    const r = await invoke(handler, { model: 'xai/grok-4.3[1m]', messages: [], stream: true });
    expect(r.status).toBe(200);
    expect(seen[0].body.model).toBe('grok-4.3');
  });

  it('provider.serverSideTools 按去前缀 model 决定,并随请求下发给上游', async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ body: JSON.parse(String(init.body)) });
      return new Response(sse(OK_SSE), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const askedModels: string[] = [];
    const handler = createResponsesHandler({
      providers: [providerConfig({
        prefix: 'xai/',
        serverSideTools: (model) => {
          askedModels.push(model);
          return model.startsWith('grok-code') ? [] : [{ type: 'x_search' }];
        },
      })],
    });

    await invoke(handler, { model: 'xai/grok-4.5', messages: [], stream: true });
    expect(seen[0].body.tools).toEqual([{ type: 'x_search' }]);
    // 门控拿到的是剥掉前缀与 [1m] 后缀的真实 model id。
    expect(askedModels).toEqual(['grok-4.5']);

    // 编码模型:门控返回空 → 完全不发 tools。
    seen.length = 0;
    await invoke(handler, { model: 'xai/grok-code-fast', messages: [], stream: true });
    expect(seen[0].body.tools).toBeUndefined();
  });

  it('stream:false → 上游仍恒 stream:true + SSE Accept,下游返回完整 Anthropic Message JSON', async () => {
    const seen: Array<{ body: Record<string, unknown>; accept: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({
        body: JSON.parse(String(init.body)),
        accept: new Headers(init.headers).get('accept') ?? '',
      });
      return new Response(JSON.stringify({
        id: 'resp_1',
        model: 'gpt-5.6-sol',
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello' }],
          },
          {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'Bash',
            arguments: '{"command":"pwd"}',
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const handler = createResponsesHandler({ providers: [providerConfig()] });

    const result = await invoke(handler, {
      model: 'chatgpt/gpt-5.6-sol',
      messages: [],
      stream: false,
    });

    expect(result.status).toBe(200);
    expect(String(result.headers['content-type'])).toContain('application/json');
    const message = JSON.parse(result.text) as Record<string, unknown>;
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'chatgpt/gpt-5.6-sol',
      stop_reason: 'tool_use',
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    expect(message.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'pwd' } },
    ]);
    // 上游恒流式:codex 对 stream:false 返 400 `{"detail":"Stream must be set to true"}`,
    // 非流式只体现在**下游**表示上。本用例同时覆盖上游直接给 Responses JSON 的兼容路径。
    expect(seen[0]).toMatchObject({ body: { stream: true }, accept: 'text/event-stream' });
  });

  it('省略 stream 字段(cc 非流式 fallback 的真实形态)→ 返回 Message JSON,不回 SSE', async () => {
    // Claude Code 的非流式 fallback 走 SDK 的 messages.create(),请求体**没有 stream 字段**
    // (随包 cc 二进制实测)。按 `stream !== false` 判会把它误当流式、回 SSE,CLI 随即报
    // "empty or malformed response (HTTP 200)" —— 正是用户截图那条。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(OK_SSE), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const handler = createResponsesHandler({ providers: [providerConfig()] });

    const result = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] });

    expect(result.status).toBe(200);
    expect(String(result.headers['content-type'])).toContain('application/json');
    expect(result.text).not.toContain('event: ');
    expect(JSON.parse(result.text)).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    });
  });

  it('stream:false 上游返回 SSE(真实形态)→ bridge 缓冲后返回 Anthropic Message JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(OK_SSE), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const handler = createResponsesHandler({ providers: [providerConfig()] });

    const result = await invoke(handler, {
      model: 'chatgpt/gpt-5.5',
      messages: [],
      stream: false,
    });

    expect(result.status).toBe(200);
    expect(String(result.headers['content-type'])).toContain('application/json');
    expect(JSON.parse(result.text)).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    });
  });

  it('stream:false 上游 SSE 事件跨多行 data: → 按空行合并后解析,不误判成坏帧(review 反馈)', async () => {
    // SSE 规范允许同一事件由多条 data: 行组成(以 \n 拼接)。逐行独立 JSON.parse 会在
    // 第一段就抛错,把一个合法响应变成 502。
    const body = [
      'event: response.created',
      'data: {"type":"response.created",',
      'data:  "response":{"id":"r","model":"gpt-5.5"}}',
      '',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}',
      '',
      'data: {"type":"response.output_text.delta","output_index":0,',
      'data:  "delta":"hi"}',
      '',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message"}}',
      '',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rawStream(body), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const handler = createResponsesHandler({ providers: [providerConfig()] });

    const result = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: false });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    });
  });

  it('stream:false 上游返回流内错误 / 无内容 → 502 带上游原因,不回空 message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'resp_1',
      status: 'failed',
      error: { code: 'context_length_exceeded', message: 'prompt too large' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const failed = createResponsesHandler({ providers: [providerConfig()] });
    const failedResult = await invoke(failed, { model: 'chatgpt/gpt-5.5', messages: [], stream: false });
    expect(failedResult.status).toBe(502);
    expect(failedResult.text).toContain('[context_length_exceeded] prompt too large');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'resp_2',
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const empty = createResponsesHandler({ providers: [providerConfig()] });
    const emptyResult = await invoke(empty, { model: 'chatgpt/gpt-5.5', messages: [], stream: false });
    expect(emptyResult.status).toBe(502);
    expect(emptyResult.text).toContain('no content blocks');
  });

  it('上游 HTTP 200 无 body → 返回 502,不保留伪成功状态', async () => {
    const onUpstreamError = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const handler = createResponsesHandler({
      providers: [providerConfig({ onUpstreamError })],
    });

    const result = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] });

    expect(result.status).toBe(502);
    expect(result.text).toContain('successful response without a body');
    expect(onUpstreamError).not.toHaveBeenCalled();
  });

  it('上游 SSE clean EOF 且未完成 → error 事件收尾,不补 message_stop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(OK_SSE.slice(0, 3)), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const handler = createResponsesHandler({ providers: [providerConfig()] });

    const result = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [], stream: true });

    expect(result.status).toBe(200);
    expect(result.text).toContain('stream_truncated');
    expect(result.text).toContain('event: error');
    expect(result.text).not.toContain('message_stop');
  });

  it('count_tokens 本地估算;无匹配 provider → 400;buildHeaders 抛错 → 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should not fetch'); }));
    const handler = createResponsesHandler({ providers: [providerConfig()] });

    const count = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [{ role: 'user', content: 'abcd'.repeat(100) }] }, { url: '/v1/messages/count_tokens' });
    expect(count.status).toBe(200);
    expect(JSON.parse(count.text).input_tokens).toBeGreaterThan(50);

    const nope = await invoke(handler, { model: 'xai/grok-4.3', messages: [] });
    expect(nope.status).toBe(400);
    expect(nope.text).toContain('no bridge provider');

    const authFail = createResponsesHandler({
      providers: [providerConfig({ buildHeaders: async () => { throw new Error('no token'); } })],
    });
    const r = await invoke(authFail, { model: 'chatgpt/gpt-5.5', messages: [] });
    expect(r.status).toBe(502);
    expect(r.text).toContain('authentication_error');
  });

  it('上游非 2xx → 先等待 provider 收口错误状态,再透传原始响应', async () => {
    const callbackFinished = vi.fn();
    const onUpstreamError = vi.fn(async () => {
      await Promise.resolve();
      callbackFinished();
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"error":{"code":"token_invalidated"}}', { status: 401 }),
      ),
    );
    const handler = createResponsesHandler({
      providers: [providerConfig({ onUpstreamError })],
    });

    const result = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] });

    expect(result.status).toBe(401);
    expect(result.text).toContain('token_invalidated');
    expect(callbackFinished).toHaveBeenCalledOnce();
    expect(onUpstreamError).toHaveBeenCalledWith({
      status: 401,
      body: '{"error":{"code":"token_invalidated"}}',
      requestHeaders: { authorization: 'Bearer t' },
    });

    const callbackFailure = createResponsesHandler({
      providers: [
        providerConfig({
          onUpstreamError: async () => {
            throw new Error('cleanup failed');
          },
        }),
      ],
    });
    const preserved = await invoke(callbackFailure, {
      model: 'chatgpt/gpt-5.5',
      messages: [],
    });
    expect(preserved.status).toBe(401);
    expect(preserved.text).toContain('token_invalidated');
  });

  it('注册未实现的 wireProtocol → 装配即抛(fail-fast)', () => {
    expect(() => createResponsesHandler({
      providers: [providerConfig({ wireProtocol: 'openai-chat' as never })],
    })).toThrow(/wireProtocol/);
  });
});
