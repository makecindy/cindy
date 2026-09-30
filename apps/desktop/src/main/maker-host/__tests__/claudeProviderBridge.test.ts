import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PROVIDER_MODEL_CATALOG } from '@cindy/model-providers';
import { claudeProviderReasoningNamespace, createClaudeProviderBridge } from '../claude-provider-bridge.js';

async function runBridge(
  protocol: 'openai-chat' | 'openai-responses',
  stream: boolean,
  upstream: string,
  onRequest: (url: string, init?: RequestInit) => void,
  extras: Partial<Parameters<typeof createClaudeProviderBridge>[0]> = {},
  effort = 'high',
  fast = false,
) {
  const handler = createClaudeProviderBridge({
    url: `https://supplier.example/v1/${protocol === 'openai-chat' ? 'chat/completions' : 'responses'}`,
    protocol, headers: { authorization: 'Bearer fixture-supplier-key', 'x-api-key': 'fixture-supplier-key' },
    efforts: ['low', 'medium', 'high'], capabilities: { imageInput: 'image_url', reasoningField: 'reasoning_effort' },
    fetchImpl: async (url, init) => {
      onRequest(String(url), init);
      return new Response(upstream, { headers: { 'content-type': 'text/event-stream' } });
    },
    ...extras,
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      void handler.handle({ parsedBody: JSON.parse(Buffer.concat(chunks).toString()),
        ctx: { reqId: 1, method: 'POST', url: req.url!, headers: {} }, res,
        prefs: { reasoningEffort: effort, fast },
      }).catch(() => { res.statusCode = 500; res.end(); });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-claude-subscription' },
      body: JSON.stringify({ model: 'test-model', stream, max_tokens: 8192,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
      }),
    });
    return { status: response.status, body: await response.text() };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const chatStream = [
  { id: 'chat-fixture', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
  { id: 'chat-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
].map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';

describe('Claude Code custom provider translation', () => {
  it.each(['openai-chat', 'openai-responses'] as const)(
    'reconciles saved effort against current capabilities before %s forwarding', async protocol => {
      const sent: unknown[] = [];
      for (const efforts of [['high', 'max'], ['high'], [], ['high', 'max']] as const) {
        await runBridge(protocol, true, chatStream, (_url, init) => {
          const request = JSON.parse(String(init?.body));
          sent.push(protocol === 'openai-chat' ? request.reasoning_effort : request.reasoning?.effort);
        }, { efforts }, 'max');
      }
      expect(sent).toEqual(['max', 'high', undefined, 'max']);
    },
  );

  it.each([true, false])('translates chat requests and replies with streaming=%s', async stream => {
    const result = await runBridge('openai-chat', stream, chatStream, (url, init) => {
      expect(url).toBe('https://supplier.example/v1/chat/completions');
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ model: 'test-model', reasoning_effort: 'high', stream: true });
      expect(JSON.stringify(request.messages)).toContain('data:image/png;base64,AAAA');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-supplier-key' });
      expect(JSON.stringify(init?.headers)).not.toContain('fixture-claude-subscription');
      expect(JSON.stringify(init?.headers)).not.toContain('x-api-key');
    });
    expect(result.status).toBe(200);
    if (stream) { expect(result.body).toContain('message_stop'); expect(result.body).toContain('Hello'); }
    else expect(JSON.parse(result.body)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Hello' }] });
  });

  it('keeps Cloudflare header-only credentials on the native Claude bridge', async () => {
    const original = PROVIDER_MODEL_CATALOG.providers['cloudflare-ai-gateway'].find(row => row.execution.pi.api === 'openai-completions')!;
    const row = { ...original, upstream: original.upstream.replace('{CLOUDFLARE_ACCOUNT_ID}', 'fixture-account').replace('{CLOUDFLARE_GATEWAY_ID}', 'fixture-gateway') };
    let sent: Headers | undefined;
    const result = await runBridge('openai-chat', true, chatStream, (url, init) => {
      sent = new Headers(init?.headers as HeadersInit);
    }, {
      headers: { 'cf-aig-authorization': 'Bearer header-only-key' },
      model: row,
    });
    expect(result.status).toBe(200);
    expect(sent?.get('cf-aig-authorization')).toBe('Bearer header-only-key');
    expect(sent?.get('authorization')).toBeNull();
  });

  it('retries once with the mid-conversation system hoisted when the upstream rejects it', async () => {
    // Claude Code 的 mid-conversation-system 把 system 投到 user 轮次之后;Google 的
    // OpenAI 兼容层是会话级限制,不合并就整轮 400 且下一轮复现。
    const sent: unknown[][] = [];
    const googleOrderError = JSON.stringify({
      error: {
        message: JSON.stringify({
          error: {
            message: "'system messages are only supported at the beginning of the conversation' functionality not supported.",
            type: 'AI_UnsupportedFunctionalityError',
          },
        }),
        type: 'invalid_request_error',
      },
    });
    const handler = createClaudeProviderBridge({
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      protocol: 'openai-chat',
      headers: { authorization: 'Bearer fixture-supplier-key' },
      efforts: ['low', 'medium', 'high'],
      capabilities: { reasoningField: 'reasoning_effort' },
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        sent.push(request.messages);
        if (sent.length === 1) return new Response(googleOrderError, { status: 400 });
        return new Response(chatStream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        void handler.handle({ parsedBody: JSON.parse(Buffer.concat(chunks).toString()),
          ctx: { reqId: 1, method: 'POST', url: req.url!, headers: {} }, res,
        }).catch(() => { res.statusCode = 500; res.end(); });
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-claude-subscription' },
        body: JSON.stringify({ model: 'google/gemini-3.8-flash', stream: true, max_tokens: 8192,
          system: 'You are an interactive agent.',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'system-reminder: context' }] },
            { role: 'system', content: [{ type: 'text', text: 'Available agent types for the Agent tool' }] },
            { role: 'user', content: [{ type: 'text', text: '继续' }] },
          ],
        }),
      });
      expect(await response.text()).toContain('message_stop');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(sent).toHaveLength(2);
    // 中段 system 与顶层 system 合成唯一首条 system,user 相对顺序保持。
    expect(sent[1]).toEqual([
      { role: 'system', content: 'You are an interactive agent.\n\nAvailable agent types for the Agent tool' },
      { role: 'user', content: 'system-reminder: context' },
      { role: 'user', content: '继续' },
    ]);
    // 首包确实带着中段 system —— 复现的是真实链路,不是被提前改写过。
    expect(sent[0]).toContainEqual({ role: 'system', content: 'Available agent types for the Agent tool' });
  });

  it('keeps encrypted reasoning state private to a connection, not a shared URL', () => {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    expect(claudeProviderReasoningNamespace(url, 'custom:openrouter-a'))
      .not.toBe(claudeProviderReasoningNamespace(url, 'custom:openrouter-b'));
    expect(claudeProviderReasoningNamespace(url, 'custom:openrouter-a'))
      .not.toBe(claudeProviderReasoningNamespace(url));
  });
});


it.each(['openai-chat', 'openai-responses'] as const)('sends Fast only when enabled and supported on %s', async protocol => {
  for (const supported of [true, false, undefined]) for (const fast of [true, false]) {
    let body: Record<string, unknown> | undefined;
    await runBridge(protocol, true, chatStream, (_url, init) => { body = JSON.parse(String(init?.body)); },
      { supportsFastMode: supported }, 'high', fast);
    expect(body?.service_tier).toBe(supported && fast ? 'priority' : undefined);
  }
});
