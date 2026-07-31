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
): Promise<{ status: number; text: string }> {
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
    return await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
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

    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] }, { prefs: { fast: true, reasoningEffort: 'xhigh' } });
    expect(r.status).toBe(200);
    expect(r.text).toContain('message_start');
    expect(r.text).toContain('"chatgpt/gpt-5.5"'); // message_start 回显带前缀 model(记账判据)
    expect(r.text).toContain('message_stop');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://upstream.example/responses');
    expect(seen[0].body.model).toBe('gpt-5.5');
    expect(seen[0].body.service_tier).toBe('priority');
    expect((seen[0].body.reasoning as Record<string, unknown>).effort).toBe('xhigh');

    // fast=false / provider 无 fastServiceTier → 不发 service_tier。
    seen.length = 0;
    await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] }, { prefs: { fast: false } });
    expect(seen[0].body.service_tier).toBeUndefined();
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
    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] });
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
    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] });
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
    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] });
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
    const r = await invoke(handler, { model: 'chatgpt/gpt-5.5', messages: [] });
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

    const r = await invoke(handler, { model: 'xai/grok-4.3[1m]', messages: [] });
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

    await invoke(handler, { model: 'xai/grok-4.5', messages: [] });
    expect(seen[0].body.tools).toEqual([{ type: 'x_search' }]);
    // 门控拿到的是剥掉前缀与 [1m] 后缀的真实 model id。
    expect(askedModels).toEqual(['grok-4.5']);

    // 编码模型:门控返回空 → 完全不发 tools。
    seen.length = 0;
    await invoke(handler, { model: 'xai/grok-code-fast', messages: [] });
    expect(seen[0].body.tools).toBeUndefined();
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
