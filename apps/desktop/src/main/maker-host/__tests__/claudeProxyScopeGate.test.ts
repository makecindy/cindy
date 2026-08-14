/**
 * claudeProxyScopeGate.test.ts
 * ---------------------------------------------------------------------------
 * issue #886 端到端回归:cc routingTransform ① 段的 modelPrefixes 服务范围门。
 *
 * 现场:会话选了 xAI(SuperGrok 订阅直连,xai/grok-*)后,Claude Code CLI 内部的
 * 辅助调用(权限 auto 模式的安全分类器,wire model 为 claude-haiku-*)带着同一个
 * session header 进 proxy —— 修复前被 ① 段整会话路由拽到 api.x.ai(oauth-passthrough,
 * 凭证也不对)→ 必 4xx → 分类器 fail-closed → 该会话所有 Bash 命令被拦。
 *
 * 本测试用**真实** provider-route + session-provider-store + active-catalog(bundled),
 * 只 mock 触电模块,验证决策级行为:
 *   - xai 会话的 claude-* 请求落回 ② 段 spawn 默认路由(网关换 key / 直连订阅)
 *   - 显式选了供应商的会话,② 段不再写入计费路由观察表(registry 语义:只记默认路由会话)
 * (xai/ 前缀主请求由 ⓪ 段 bridge 接管,在 ①/② 之前,不受本改动影响 —— 该路径依赖
 *  bridge handler 注册,scope 门单测见 providerRoute.test.ts。)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { outboundFetch, visionFallbackSettings } = vi.hoisted(() => ({
  outboundFetch: vi.fn(),
  visionFallbackSettings: {
    visionFallbackEnabled: true,
    visionFallbackModel: null as string | null,
    visionFallbackProviderId: null as string | null,
    visionFallbackProviderIds: {} as Record<string, string>,
  },
}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../subagent-model-settings-store', () => ({
  readSubagentModelSettings: () => visionFallbackSettings,
}));

vi.mock('../logger-adapter', () => ({
  createMakerLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(function self() { return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: self }; }),
  }),
  desktopMakerLogger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));
vi.mock('../runtime-configs', () => ({
  claudeUpstreamEndpoint: () => 'https://gateway.example.com',
}));
vi.mock('../silent-encrypted-retry-store', () => ({
  readSilentEncryptedRetrySettings: () => ({ enabled: false }),
}));
vi.mock('../claude-fast-mode-log', () => ({
  createClaudeFastModeRequestTransform: () => () => null,
  createClaudeFastModeResponseObserver: () => () => undefined,
}));
vi.mock('../outbound-fetch', () => ({ outboundFetch }));

import {
  createModelRoutingTransform,
  setClaudeProxyGatewayKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import { setSessionProvider, clearSessionProvider } from '../session-provider-store';
import {
  readClaudeSessionRoute,
  resetClaudeSessionRouteRegistryForTest,
} from '../claude-session-route-registry';
import { setProviderOAuthTokenReader } from '../provider-route';
import { setCustomProviderKeyReader } from '../provider-route';
import { setCustomProviders } from '../active-catalog';
import { buildUserProvider } from '@cindy/model-providers';
import {
  registerPiProxySession,
  resetPiProxySessionsForTest,
} from '../pi-proxy-session-auth';

const SESSION_HEADER = { 'x-claude-code-session-id': 'sdk-grok' };

function ctxWith(headers: Record<string, string>) {
  return { reqId: 1, method: 'POST', url: '/v1/messages', headers } as never;
}

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function bridgeResponse() {
  const response = Object.assign(new EventEmitter(), {
    status: 200,
    chunks: [] as string[],
    writeHead(status: number) { this.status = status; return this; },
    write(chunk: string) { this.chunks.push(chunk); return true; },
    end(chunk?: string) { if (chunk) this.chunks.push(chunk); },
  });
  return response;
}

describe('cc routingTransform — xAI 会话的辅助请求回落默认路由 (issue #886)', () => {
  let gatewayKey: string | null;

  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
    gatewayKey = 'sk-gw';
    setClaudeProxyGatewayKeyReader(() => gatewayKey);
    setClaudeProxySessionIdResolver((sdkId) => (sdkId === 'sdk-grok' ? 'sess-grok' : null));
    setSessionProvider('sess-grok', 'xai');
    visionFallbackSettings.visionFallbackEnabled = true;
    visionFallbackSettings.visionFallbackModel = null;
    visionFallbackSettings.visionFallbackProviderId = null;
    visionFallbackSettings.visionFallbackProviderIds = {};
  });

  afterEach(() => {
    clearSessionProvider('sess-grok');
    setCustomProviders([]);
    setCustomProviderKeyReader(() => null);
    outboundFetch.mockReset();
  });

  it('claude-haiku 分类器请求(oauth-spawn)→ 换网关 key,不去 api.x.ai', () => {
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    // 落到 ② 段 gatewayDefaultRouteDecision:换网关 key(绝不是 upstreamOverride api.x.ai)。
    expect(decision).toEqual({
      headerOverride: { 'x-api-key': 'sk-gw', authorization: 'Bearer sk-gw' },
    });
  });

  it('claude-haiku 分类器请求(gateway-spawn 带 x-api-key)→ passthrough 走默认网关', () => {
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
    );
    expect(decision).toBeNull();
  });

  it('claude-haiku 分类器请求(provider-oauth spawn 带占位 x-api-key)→ 换网关 key,不 passthrough (#831)', () => {
    // codex→cc 切换后的 openai/xai 来源会话:cc 子进程 env 里是占位 key,分类器请求带着它
    // 落到 ② 段。占位 key 不是可用凭证,按「无凭证」处理换网关 key;此前被误判成
    // gateway-spawn passthrough → 网关确定性 401 → 首次权限请求即 auto→ask 降级。
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'xdt-provider-auth-placeholder-key' }),
    );
    expect(decision).toEqual({
      headerOverride: { 'x-api-key': 'sk-gw', authorization: 'Bearer sk-gw' },
    });
  });

  it('占位 x-api-key 且无网关 key → 维持 passthrough(与改动前行为一致,上游 401)', () => {
    gatewayKey = null;
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'xdt-provider-auth-placeholder-key' }),
    );
    expect(decision).toBeNull();
  });

  it('claude-haiku 分类器请求(无网关 key 的 oauth-spawn)→ 直连 Anthropic 订阅', () => {
    gatewayKey = null;
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(decision).toEqual({ upstreamOverride: 'https://api.anthropic.com' });
  });

  it('显式选了供应商的会话,② 段回落不写入计费路由观察表(registry 只记默认路由会话)', () => {
    const transform = createModelRoutingTransform();
    transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(readClaudeSessionRoute('sess-grok')).toBeNull();
  });

  it('未选供应商的会话行为不变:② 段照常记录默认路由(no-break)', () => {
    clearSessionProvider('sess-grok');
    const transform = createModelRoutingTransform();
    transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(readClaudeSessionRoute('sess-grok')).toBe('gateway');
  });

  it('纯文本模型收到 Anthropic 图片且未配置视觉模型时应返回设置提醒', () => {
    const transform = createModelRoutingTransform();
    const decision = transform(
      {
        model: 'deepseek/deepseek-v4-pro',
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'eA==' },
          }],
        }],
      },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
    );

    expect(decision).toEqual({ localHandler: expect.any(Function) });
  });

  it('工具结果续接请求继续使用已选择的视觉模型供应商', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'vision-provider',
        name: 'Vision Provider',
        runtimes: {
          'claude-code': {
            baseUrl: 'https://vision.example/v1',
            models: [{ id: 'vision-model', name: 'Vision Model' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader((providerId, agent) =>
      providerId === 'vision-provider' && agent === 'claude-code' ? 'vision-key' : null,
    );
    visionFallbackSettings.visionFallbackModel = 'vision-model';
    visionFallbackSettings.visionFallbackProviderId = 'vision-provider';
    visionFallbackSettings.visionFallbackProviderIds = { 'claude-code': 'vision-provider' };

    const decision = await Promise.resolve(createModelRoutingTransform()(
      {
        model: 'deepseek/deepseek-v4-pro',
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
        ],
      },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
    ));

    expect(decision).toMatchObject({
      upstreamOverride: 'https://vision.example/v1',
      headerOverride: { authorization: 'Bearer vision-key' },
      bodyModelOverride: 'vision-model',
    });
  });

  it.each(['openai-responses', 'openai-chat'] as const)(
    'bridges a %s vision fallback instead of forwarding the text-only model',
    async (wireProtocol) => {
      setCustomProviders([
        buildUserProvider({
          id: `vision-${wireProtocol}`,
          name: `Vision ${wireProtocol}`,
          runtimes: {
            'claude-code': {
              baseUrl: 'https://vision.example/v1',
              wireProtocol,
              models: [{ id: 'vision-model', name: 'Vision Model' }],
            },
          },
        }),
      ]);
      setCustomProviderKeyReader(() => 'vision-key');
      visionFallbackSettings.visionFallbackModel = 'vision-model';
      visionFallbackSettings.visionFallbackProviderId = `vision-${wireProtocol}`;

      const decision = await Promise.resolve(createModelRoutingTransform()(
        {
          model: 'deepseek/deepseek-v4-pro',
          messages: [{
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }],
          }],
        },
        ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
      ));

      expect(decision).toEqual({ localHandler: expect.any(Function) });
      outboundFetch.mockResolvedValueOnce(new Response(
        wireProtocol === 'openai-responses'
          ? sse([
              { type: 'response.created', response: { id: 'r', model: 'vision-model' } },
              { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
              { type: 'response.output_text.delta', output_index: 0, delta: 'seen' },
              { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
              { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
            ])
          : sse([
              { id: 'chat-r', model: 'vision-model', choices: [{ delta: { content: 'seen' }, finish_reason: null }] },
              { id: 'chat-r', model: 'vision-model', choices: [{ delta: {}, finish_reason: 'stop' }] },
            ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ));
      const response = bridgeResponse();
      const body = {
        model: 'deepseek/deepseek-v4-pro',
        messages: [{
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }],
        }],
        stream: true,
      };
      await decision?.localHandler?.({
        parsedBody: body,
        ctx: ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
        res: response,
      } as never);

      expect(JSON.parse(String(outboundFetch.mock.calls[0][1].body))).toMatchObject({
        model: 'vision-model',
      });
      expect(response.chunks.join('')).toContain('message_stop');
    },
  );

  it('streams a chat vision fallback before completion and aborts it when the client disconnects', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'vision-chat-stream',
        name: 'Vision Chat Stream',
        runtimes: {
          'claude-code': {
            baseUrl: 'https://vision.example/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'vision-model', name: 'Vision Model' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'vision-key');
    visionFallbackSettings.visionFallbackModel = 'vision-model';
    visionFallbackSettings.visionFallbackProviderId = 'vision-chat-stream';
    visionFallbackSettings.visionFallbackProviderIds = { 'claude-code': 'vision-chat-stream' };

    let upstreamAborted = false;
    let releaseUpstream: () => void = () => {};
    const keepOpen = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const encoder = new TextEncoder();
    outboundFetch.mockImplementationOnce(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sse([
            { id: 'chat-r', model: 'vision-model', choices: [{ delta: { content: 'seen' }, finish_reason: null }] },
          ])));
          signal?.addEventListener('abort', () => {
            upstreamAborted = true;
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
          void keepOpen.then(() => {
            if (upstreamAborted) return;
            controller.enqueue(encoder.encode(sse([
              { id: 'chat-r', model: 'vision-model', choices: [{ delta: {}, finish_reason: 'stop' }] },
            ])));
            controller.close();
          });
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    try {
      const decision = await Promise.resolve(createModelRoutingTransform()(
        {
          model: 'deepseek/deepseek-v4-pro',
          messages: [{
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }],
          }],
          stream: true,
        },
        ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
      ));
      const response = bridgeResponse();
      const forwarding = decision?.localHandler?.({
        parsedBody: {
          model: 'deepseek/deepseek-v4-pro',
          messages: [{
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }],
          }],
          stream: true,
        },
        ctx: ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
        res: response,
      } as never);

      await vi.waitFor(() => expect(response.chunks.join('')).toContain('seen'));
      response.emit('close');
      await vi.waitFor(() => expect(upstreamAborted).toBe(true));
      await forwarding;
    } finally {
      releaseUpstream();
    }
  });
});

describe('pi routingTransform — xdt session header selects the Pi provider route', () => {
  afterEach(() => {
    clearSessionProvider('sess-pi');
    setProviderOAuthTokenReader(() => null);
    setCustomProviderKeyReader(() => null);
    setCustomProviders([]);
    resetPiProxySessionsForTest();
  });

  it('routes an Anthropic Pi request with host-managed OAuth and strips Pi placeholder auth', async () => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setSessionProvider('sess-pi', 'anthropic');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'anthropic' && agent === 'pi' ? Promise.resolve('pi-claude-token') : null,
    );
    registerPiProxySession('sess-pi', 'session-secret');
    const decision = createModelRoutingTransform()(
      { model: 'claude-opus-5' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
        'x-api-key': 'cindy-pi-provider-auth-placeholder',
      }),
    );
    await expect(Promise.resolve(decision)).resolves.toEqual({
      upstreamOverride: 'https://api.anthropic.com',
      headerOverride: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        authorization: 'Bearer pi-claude-token',
      },
      headerDelete: [
        'x-api-key',
        'x-cindy-pi-session-id',
        'x-cindy-pi-session-token',
      ],
    });
  });

  it('routes Pi vision fallback through the selected Pi provider', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'pi-vision-provider',
        name: 'Pi Vision Provider',
        runtimes: {
          pi: {
            baseUrl: 'https://pi-vision.example/v1',
            wireProtocol: 'anthropic-messages',
            models: [
              { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
              { id: 'pi-vision-model', name: 'Pi Vision Model' },
            ],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader((providerId, agent) =>
      providerId === 'pi-vision-provider' && agent === 'pi' ? 'pi-vision-key' : null,
    );
    setSessionProvider('sess-pi', 'pi-vision-provider');
    visionFallbackSettings.visionFallbackModel = 'pi-vision-model';
    visionFallbackSettings.visionFallbackProviderId = 'pi-vision-provider';
    visionFallbackSettings.visionFallbackProviderIds = { pi: 'pi-vision-provider' };
    registerPiProxySession('sess-pi', 'session-secret');

    const decision = await Promise.resolve(createModelRoutingTransform()(
      {
        model: 'deepseek/deepseek-v4-pro',
        messages: [{
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }],
        }],
      },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
        'x-api-key': 'cindy-pi-provider-auth-placeholder',
      }),
    ));

    expect(decision).toMatchObject({
      upstreamOverride: 'https://pi-vision.example/v1',
      headerOverride: { authorization: 'Bearer pi-vision-key' },
      bodyModelOverride: 'pi-vision-model',
    });
  });

  it('rejects a forged session id before provider credentials can be selected', async () => {
    setSessionProvider('sess-pi', 'anthropic');
    registerPiProxySession('sess-pi', 'real-secret');
    const decision = await createModelRoutingTransform()(
      { model: 'claude-opus-5' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'wrong-secret',
      }),
    );
    expect(decision).toEqual({ localHandler: expect.any(Function) });

    const response = {
      status: 0,
      body: '',
      writeHead(status: number) { this.status = status; },
      end(body: string) { this.body = body; },
    };
    await decision?.localHandler?.({ res: response } as never);
    expect(response.status).toBe(401);
    expect(response.body).toContain('invalid_pi_session_token');
  });

  it('never forwards an orphaned internal Pi token header', async () => {
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-5' },
      ctxWith({ 'x-cindy-pi-session-token': 'orphaned-secret' }),
    ));
    expect(decision).toMatchObject({
      headerDelete: ['x-cindy-pi-session-id', 'x-cindy-pi-session-token'],
    });
    expect(decision?.headerOverride).not.toHaveProperty('x-cindy-pi-session-token');
  });
});
