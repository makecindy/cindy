/**
 * provider-diagnostics（测试连接探测）+ shared/providerErrors（结构化分类器）单测。
 *
 * 覆盖：
 *   - 分类器对 status / 错误体 pattern / 网络层错误码的确定性归类（规则 9）；
 *   - buildProbeRequest 的 wire 形状（cc=/v1/messages 双鉴权头；codex=/responses Bearer），
 *     与 provider-route 的 api-key-header 分支 header 组合对齐；
 *   - runProviderProbe 注入 fetch 不联网：2xx → ok、4xx → 分类、网络错 → UPSTREAM_UNREACHABLE；
 *   - resolveSavedProbeSpec 从 active-catalog + 注入 key reader 解析（仅 user 供应商）。
 */

import { describe, it, expect, afterEach } from 'vitest';

import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';

import { classifyProviderError } from '../../../shared/providerErrors.js';
import {
  buildProbeRequest,
  runProviderProbe,
  resolveSavedProbeSpec,
  setDiagnosticsKeyReader,
  setDiagnosticsOAuthTokenReader,
  testProviderConnection,
} from '../provider-diagnostics.js';
import { setCustomProviders } from '../active-catalog.js';

afterEach(() => {
  setCustomProviders([]);
  setDiagnosticsKeyReader(() => null);
});

describe('classifyProviderError', () => {
  it('按 status 归类明确错误', () => {
    expect(classifyProviderError({ status: 401 }).code).toBe('AUTH_INVALID');
    expect(classifyProviderError({ status: 402 }).code).toBe('QUOTA_EXCEEDED');
    expect(classifyProviderError({ status: 403 }).code).toBe('AUTH_FORBIDDEN');
    expect(classifyProviderError({ status: 429 })).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(classifyProviderError({ status: 529 })).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(classifyProviderError({ status: 503 })).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
  });

  it('404：模型措辞 → MODEL_NOT_FOUND，否则 ENDPOINT_NOT_FOUND', () => {
    expect(
      classifyProviderError({
        status: 404,
        bodyText: '{"error":{"message":"model: glm-x not found"}}',
      }).code,
    ).toBe('MODEL_NOT_FOUND');
    expect(classifyProviderError({ status: 404, bodyText: 'no route' }).code).toBe(
      'ENDPOINT_NOT_FOUND',
    );
  });

  it('400 按错误体 pattern 分流', () => {
    expect(
      classifyProviderError({
        status: 400,
        bodyText: 'The model `x` does not exist or you do not have access',
      }).code,
    ).toBe('MODEL_NOT_FOUND');
    expect(
      classifyProviderError({ status: 400, bodyText: 'prompt is too long: 250000 tokens' }).code,
    ).toBe('CONTEXT_TOO_LONG');
    expect(classifyProviderError({ status: 400, bodyText: 'insufficient_quota' }).code).toBe(
      'QUOTA_EXCEEDED',
    );
    expect(
      classifyProviderError({ status: 400, bodyText: 'Extra inputs are not permitted' }).code,
    ).toBe('WIRE_INCOMPATIBLE');
    expect(classifyProviderError({ status: 400, bodyText: 'something odd' }).code).toBe('UNKNOWN');
  });

  it('403 命中鉴权措辞归 AUTH_INVALID（部分网关 key 无效报 403）', () => {
    expect(classifyProviderError({ status: 403, bodyText: 'invalid api key provided' }).code).toBe(
      'AUTH_INVALID',
    );
  });

  it('网络层错误 → UPSTREAM_UNREACHABLE / TIMEOUT（均可重试）', () => {
    expect(classifyProviderError({ networkErrorCode: 'ECONNREFUSED' })).toMatchObject({
      code: 'UPSTREAM_UNREACHABLE',
      retryable: true,
    });
    expect(classifyProviderError({ networkErrorCode: 'TimeoutError' }).code).toBe('TIMEOUT');
  });

  it('不认识的网络错误码 → UNKNOWN（不误导用户「检查网络」）', () => {
    expect(classifyProviderError({ networkErrorCode: 'E_WEIRD_CUSTOM' })).toMatchObject({
      code: 'UNKNOWN',
      retryable: false,
    });
  });
});

describe('buildProbeRequest', () => {
  it('Codex Anthropic Messages probe uses x-api-key and Messages endpoint', () => {
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      modelId: 'claude-opus-5',
      apiKey: 'sk-test',
      headers: {
        'Anthropic-Version': 'custom-version',
        'Content-Type': 'text/plain',
      },
    });
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('custom-version');
    expect(headers['Anthropic-Version']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 1,
    });
  });

  it('Codex Anthropic Messages probe matches runtime joining for a versioned base URL', () => {
    const { url } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'anthropic-messages',
      baseUrl: 'https://provider.example/v1',
      modelId: 'claude-sonnet-4-6',
    });
    expect(url).toBe('https://provider.example/v1/messages');
  });

  it('Codex Anthropic Messages probe preserves custom path and query joining', () => {
    const { url } = buildProbeRequest({
      agent: 'codex',
      wireProtocol: 'anthropic-messages',
      baseUrl: 'https://provider.example/api/v1?tenant=alpha',
      requestPath: '/tenant/messages?beta=true',
      modelId: 'claude-sonnet-4-6',
    });
    expect(url).toBe('https://provider.example/api/v1/tenant/messages?tenant=alpha&beta=true');
  });

  it('cc wire：/v1/messages + anthropic-version + 双鉴权头（与 api-key-header 路由分支对齐）', () => {
    const { url, init } = buildProbeRequest({
      agent: 'claude-code',
      baseUrl: 'https://api.deepseek.com/anthropic/',
      modelId: 'deepseek-chat',
      apiKey: 'sk-test',
      headers: {
        'x-custom': '1',
        Authorization: 'Bearer stale',
        'X-API-Key': 'stale',
      },
    });
    expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-custom']).toBe('1');
    const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number };
    expect(body.model).toBe('deepseek-chat');
    expect(body.max_tokens).toBe(1);
  });

  it('codex wire：/responses + Bearer', () => {
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'z-ai/glm-5.2',
      apiKey: 'sk-or',
    });
    expect(url).toBe('https://openrouter.ai/api/v1/responses');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-or');
    expect(headers['x-api-key']).toBeUndefined();
    const body = JSON.parse(String(init.body)) as { model: string; stream: boolean };
    expect(body.model).toBe('z-ai/glm-5.2');
    expect(body.stream).toBe(false);
  });

  it.each([
    ['minimax-cn', 'https://api.minimaxi.com/v1/responses'],
    ['minimax-global', 'https://api.minimax.io/v1/responses'],
  ])('%s 预设拼出官方 Responses 端点', (presetId, expectedUrl) => {
    const runtime = BUNDLED_CATALOG.presets?.find((preset) => preset.id === presetId)?.runtimes
      .codex;
    expect(runtime).toBeDefined();
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      baseUrl: runtime!.baseUrl,
      modelId: runtime!.models[0]!.id,
      apiKey: 'sk-test',
    });
    expect(url).toBe(expectedUrl);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'MiniMax-M3',
      stream: false,
      store: false,
    });
  });

  it('codex Chat bridge wire：/chat/completions 基础流式探测,不强制 tool_choice', () => {
    const { url, init } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-chat',
      wireProtocol: 'openai-chat',
      apiKey: 'sk-ds',
    });
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    // 不带 tools / 强制 tool_choice —— 思考模型(DeepSeek deepseek-v4-pro)会拒强制工具,
    // 导致可达端点被误报失败;工具能力交给真实会话验证。
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('uses an exact request path instead of appending the protocol default', () => {
    const { url } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'https://gateway.example/api',
      modelId: 'custom-model',
      wireProtocol: 'openai-chat',
      requestPath: '/tenant/acme/infer?stream=1',
    });
    expect(url).toBe('https://gateway.example/api/tenant/acme/infer?stream=1');
  });

  it('preserves the base query when applying an exact request path', () => {
    const { url } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'https://gateway.example/api?tenant=alpha',
      modelId: 'custom-model',
      requestPath: '/infer?stream=1&mode=fast',
    });
    expect(url).toBe('https://gateway.example/api/infer?tenant=alpha&stream=1&mode=fast');
  });

  it('rejects base URL credentials when applying an exact request path', () => {
    expect(() =>
      buildProbeRequest({
        agent: 'codex',
        baseUrl: 'https://user:pass@gateway.example/api',
        modelId: 'custom-model',
        requestPath: '/infer',
      }),
    ).toThrow('invalid provider base URL');
  });

  it('无 key 时不注入鉴权头（端点可能靠自定义 headers 鉴权）', () => {
    const { init } = buildProbeRequest({
      agent: 'claude-code',
      baseUrl: 'https://x.example',
      modelId: 'm',
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('no-auth 探测剥掉表单残留的大小写混合凭证头', () => {
    const { init } = buildProbeRequest({
      agent: 'codex',
      baseUrl: 'http://127.0.0.1:4000/v1',
      modelId: 'local-model',
      authMethod: 'none',
      headers: {
        Authorization: 'Bearer must-not-leak',
        'X-API-Key': 'must-not-leak',
        'X-Tenant': 'local',
      },
    });
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-tenant': 'local',
    });
  });
});

function fakeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('runProviderProbe（注入 fetch，不联网）', () => {
  it('2xx → ok + latency', async () => {
    const r = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://x.example', modelId: 'm', apiKey: 'k' },
      async () => fakeResponse(200, '{}'),
    );
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('401 → AUTH_INVALID + status 透出', async () => {
    const r = await runProviderProbe(
      { agent: 'claude-code', baseUrl: 'https://x.example', modelId: 'm' },
      async () => fakeResponse(401, '{"error":{"type":"authentication_error"}}'),
    );
    expect(r).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
  });

  it('fetch 抛网络错 → UPSTREAM_UNREACHABLE', async () => {
    const err = new Error('fetch failed');
    (err as Error & { cause?: { code: string } }).cause = { code: 'ECONNREFUSED' };
    const r = await runProviderProbe(
      { agent: 'codex', baseUrl: 'https://nope.example', modelId: 'm' },
      async () => {
        throw err;
      },
    );
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_UNREACHABLE' });
  });

  it('openai-chat 探测:200 text/event-stream → ok', async () => {
    const r = await runProviderProbe(
      {
        agent: 'codex',
        baseUrl: 'https://x.example',
        modelId: 'm',
        apiKey: 'k',
        wireProtocol: 'openai-chat',
      },
      async () =>
        new Response('data: {}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(r.ok).toBe(true);
  });

  it('openai-chat 探测:200 SSE 顶层 error 帧 → 分类失败', async () => {
    const r = await runProviderProbe(
      {
        agent: 'codex',
        baseUrl: 'https://x.example',
        modelId: 'm',
        apiKey: 'k',
        wireProtocol: 'openai-chat',
      },
      async () =>
        new Response('data: {"error":{"type":"server_error","message":"model overloaded"}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR', status: 200 });
  });

  it('openai-chat 探测:200 SSE 无 data 帧 → WIRE_INCOMPATIBLE', async () => {
    const r = await runProviderProbe(
      {
        agent: 'codex',
        baseUrl: 'https://x.example',
        modelId: 'm',
        apiKey: 'k',
        wireProtocol: 'openai-chat',
      },
      async () =>
        new Response(': keepalive\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(r).toMatchObject({ ok: false, code: 'WIRE_INCOMPATIBLE', status: 200 });
  });

  it('openai-chat 探测:200 但非 SSE(application/json)→ WIRE_INCOMPATIBLE(与真实桥同口径)', async () => {
    const r = await runProviderProbe(
      {
        agent: 'codex',
        baseUrl: 'https://x.example',
        modelId: 'm',
        apiKey: 'k',
        wireProtocol: 'openai-chat',
      },
      async () =>
        new Response('{"choices":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(r).toMatchObject({ ok: false, code: 'WIRE_INCOMPATIBLE', status: 200 });
  });

  it('原生 Responses(codex 无 openai-chat)不做 SSE 校验:200 JSON 仍 ok', async () => {
    const r = await runProviderProbe(
      { agent: 'codex', baseUrl: 'https://x.example', modelId: 'm', apiKey: 'k' },
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('resolveSavedProbeSpec / testProviderConnection(saved)', () => {
  const config = {
    id: 'my-relay',
    name: 'My Relay',
    runtimes: {
      'claude-code': {
        baseUrl: 'https://relay.example/anthropic',
        models: [{ id: 'glm-5.2', name: 'GLM' }],
        headers: {
          'x-tenant': 't1',
          Authorization: 'Bearer stale',
          'X-API-Key': 'stale',
        },
      },
    },
  };

  it('从 active-catalog 解析 user 供应商 + 注入 key reader 读 key', () => {
    setCustomProviders([buildUserProvider(config)]);
    setDiagnosticsKeyReader((id, agent) =>
      id === 'my-relay' && agent === 'claude-code' ? 'sk-saved' : null,
    );
    const spec = resolveSavedProbeSpec('my-relay', 'claude-code');
    expect(spec).toMatchObject({
      baseUrl: 'https://relay.example/anthropic',
      modelId: 'glm-5.2',
      apiKey: 'sk-saved',
      headers: { 'x-tenant': 't1' },
    });
  });

  it('safeStorage 尚无 key 时保留 legacy header-only 凭证', () => {
    setCustomProviders([buildUserProvider(config)]);
    setDiagnosticsKeyReader(() => null);

    const spec = resolveSavedProbeSpec('my-relay', 'claude-code');
    expect(spec.apiKey).toBeNull();
    expect(spec.headers).toEqual({
      'x-tenant': 't1',
      Authorization: 'Bearer stale',
      'X-API-Key': 'stale',
    });

    const headers = buildProbeRequest(spec).init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer stale');
    expect(headers['x-api-key']).toBe('stale');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('api-key-header + openai-chat 供应商:saved 探测带上 wireProtocol → 打 /chat/completions', async () => {
    const chatConfig = {
      id: 'ds-chat',
      name: 'DeepSeek Chat',
      runtimes: {
        codex: {
          baseUrl: 'https://api.deepseek.com',
          wireProtocol: 'openai-chat' as const,
          models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
        },
      },
    };
    setCustomProviders([buildUserProvider(chatConfig)]);
    setDiagnosticsKeyReader(() => 'sk-ds');
    // resolveSavedProbeSpec 必须回带 wireProtocol，否则 buildProbeRequest 回落原生 /responses。
    expect(resolveSavedProbeSpec('ds-chat', 'codex').wireProtocol).toBe('openai-chat');
    let seenUrl = '';
    await testProviderConnection(
      { kind: 'saved', providerId: 'ds-chat', agent: 'codex' },
      async (url) => {
        seenUrl = String(url);
        return fakeResponse(200, 'data: [DONE]\n\n');
      },
    );
    expect(seenUrl).toBe('https://api.deepseek.com/chat/completions');
  });

  it('Pi 的常用 Chat 默认仍显式进入 saved 探测，不误走 /responses', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'pi-chat',
        name: 'Pi Chat',
        runtimes: {
          pi: {
            baseUrl: 'https://pi-chat.example/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'chat-model', name: 'Chat Model' }],
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'pi-chat-key');

    expect(resolveSavedProbeSpec('pi-chat', 'pi').wireProtocol).toBe('openai-chat');
    let seenUrl = '';
    await testProviderConnection(
      { kind: 'saved', providerId: 'pi-chat', agent: 'pi' },
      async (url) => {
        seenUrl = String(url);
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    );
    expect(seenUrl).toBe('https://pi-chat.example/v1/chat/completions');
  });

  it('Pi saved 探测优先使用单模型协议覆盖', () => {
    setCustomProviders([
      buildUserProvider({
        id: 'pi-model-override',
        name: 'Pi Model Override',
        runtimes: {
          pi: {
            baseUrl: 'https://pi-override.example/v1',
            wireProtocol: 'openai-chat',
            models: [
              {
                id: 'messages-model',
                name: 'Messages Model',
                piApi: 'anthropic-messages',
              },
            ],
          },
        },
      }),
    ]);

    expect(resolveSavedProbeSpec('pi-model-override', 'pi')).toMatchObject({
      baseUrl: 'https://pi-override.example/v1',
      modelId: 'messages-model',
      wireProtocol: 'anthropic-messages',
    });
  });

  it('仅选择 glm-5.3 时 saved 探测使用模型级 Responses 路由', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'glm-responses-only',
        name: 'GLM Responses Only',
        runtimes: {
          codex: {
            baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
            wireProtocol: 'openai-chat',
            requestPath: '/legacy/chat',
            models: [
              {
                id: 'glm-5.3',
                name: 'GLM-5.3',
                route: {
                  baseUrl: 'https://open.bigmodel.cn/api/v1',
                  wireProtocol: 'openai-responses',
                },
              },
            ],
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'glm-key');

    expect(resolveSavedProbeSpec('glm-responses-only', 'codex')).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/v1',
      modelId: 'glm-5.3',
      wireProtocol: 'openai-responses',
      requestPath: undefined,
    });
    let seenUrl = '';
    await testProviderConnection(
      { kind: 'saved', providerId: 'glm-responses-only', agent: 'codex' },
      async (url) => {
        seenUrl = String(url);
        return fakeResponse(200, '{}');
      },
    );
    expect(seenUrl).toBe('https://open.bigmodel.cn/api/v1/responses');
  });

  it('无模型级 route 的 glm-5.2 saved 探测继续使用 runtime V4 Chat 路由', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'glm-chat-only',
        name: 'GLM Chat Only',
        runtimes: {
          codex: {
            baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
            wireProtocol: 'openai-chat',
            requestPath: '/chat/completions',
            models: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'glm-key');

    expect(resolveSavedProbeSpec('glm-chat-only', 'codex')).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      modelId: 'glm-5.2',
      wireProtocol: 'openai-chat',
      requestPath: '/chat/completions',
    });
    let seenUrl = '';
    await testProviderConnection(
      { kind: 'saved', providerId: 'glm-chat-only', agent: 'codex' },
      async (url) => {
        seenUrl = String(url);
        return fakeResponse(200, 'data: [DONE]\n\n');
      },
    );
    expect(seenUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
  });

  it('saved 探测沿用自定义供应商的精确请求路径', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'exact-path',
        name: 'Exact Path',
        runtimes: {
          codex: {
            baseUrl: 'https://gateway.example/api',
            requestPath: '/tenant/acme/infer',
            models: [{ id: 'm', name: 'M' }],
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'sk-exact');
    expect(resolveSavedProbeSpec('exact-path', 'codex').requestPath).toBe('/tenant/acme/infer');
  });

  it('不存在 / 非 user 供应商 / 无该 runtime → 抛错（handler 映射 INVALID_PARAMS）', () => {
    setCustomProviders([buildUserProvider(config)]);
    expect(() => resolveSavedProbeSpec('nope', 'claude-code')).toThrow(/not found/);
    expect(() => resolveSavedProbeSpec('xd', 'claude-code')).toThrow(/not a custom provider/);
    expect(() => resolveSavedProbeSpec('my-relay', 'codex')).toThrow(/no runtime/);
  });

  it('跳过非聊天模型挑第一个聊天模型探测(issue #882 第 3 点,2026-07 review):探测发的是聊天形状请求,挑到 embedding/image 模型会得到与配置无关的假失败结论', () => {
    const provider = buildUserProvider(config);
    setCustomProviders([
      {
        ...provider,
        models: {
          ...provider.models,
          'claude-code': [
            {
              id: 'text-embedding-3-large',
              name: 'Embedding',
              contextWindow: 8191,
              efforts: [],
              defaultEffort: null,
              mode: 'embedding',
            },
            {
              id: 'glm-5.2',
              name: 'GLM',
              contextWindow: 128_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
      },
    ]);
    setDiagnosticsKeyReader(() => 'sk-saved');
    expect(resolveSavedProbeSpec('my-relay', 'claude-code').modelId).toBe('glm-5.2');
  });

  it('全是非聊天模型时抛「无聊天模型」错误,而不是静默探测一个 embedding 模型', () => {
    const provider = buildUserProvider(config);
    setCustomProviders([
      {
        ...provider,
        models: {
          ...provider.models,
          'claude-code': [
            {
              id: 'text-embedding-3-large',
              name: 'Embedding',
              contextWindow: 8191,
              efforts: [],
              defaultEffort: null,
              mode: 'embedding',
            },
          ],
        },
      },
    ]);
    setDiagnosticsKeyReader(() => 'sk-saved');
    expect(() => resolveSavedProbeSpec('my-relay', 'claude-code')).toThrow(/no chat models/);
  });

  it('testProviderConnection(saved) 端到端（注入 fetch 断言 URL 与 key）', async () => {
    setCustomProviders([buildUserProvider(config)]);
    setDiagnosticsKeyReader(() => 'sk-saved');
    let seenUrl = '';
    let seenAuth = '';
    const r = await testProviderConnection(
      { kind: 'saved', providerId: 'my-relay', agent: 'claude-code' },
      async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>)['x-api-key'] ?? '';
        return fakeResponse(200, '{}');
      },
    );
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe('https://relay.example/anthropic/v1/messages');
    expect(seenAuth).toBe('sk-saved');
  });

  it('oauth-token 供应商:探测 token 走 authorization 头,绝不发 x-api-key(与真实路由同口径)', async () => {
    const oauthConfig = {
      ...config,
      id: 'my-sub',
      auth: {
        method: 'oauth' as const,
        oauth: {
          authorizeUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          clientId: 'c1',
          scopes: 'openid',
        },
      },
    };
    setCustomProviders([buildUserProvider(oauthConfig)]);
    setDiagnosticsKeyReader(() => 'sk-should-not-be-used');
    setDiagnosticsOAuthTokenReader((id) => (id === 'my-sub' ? 'at-77' : null));

    const spec = resolveSavedProbeSpec('my-sub', 'claude-code');
    expect(spec.apiKey).toBeNull();
    expect(spec.headers).toMatchObject({ authorization: 'Bearer at-77', 'x-tenant': 't1' });

    const { init } = buildProbeRequest(spec);
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer at-77');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('none 供应商:saved 探测不读取旧 key,并剥掉配置里残留的鉴权头', () => {
    setCustomProviders([
      buildUserProvider({
        ...config,
        id: 'local-proxy',
        auth: { method: 'none' },
        runtimes: {
          'claude-code': {
            ...config.runtimes['claude-code'],
            baseUrl: 'http://127.0.0.1:4100',
            headers: {
              ...config.runtimes['claude-code'].headers,
              Authorization: 'Bearer must-not-leak',
              'X-API-Key': 'must-not-leak',
            },
          },
        },
      }),
    ]);
    setDiagnosticsKeyReader(() => 'stale-safe-storage-key');

    const spec = resolveSavedProbeSpec('local-proxy', 'claude-code');
    expect(spec.apiKey).toBeNull();
    expect(spec.headers).toEqual({ 'x-tenant': 't1' });
  });

  it('拒绝探测已禁用的 saved runtime，绝不进入网络请求', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'legacy-remote-no-auth',
        name: 'Legacy remote no-auth',
        auth: { method: 'none' },
        runtimes: {
          codex: {
            baseUrl: 'https://remote.example/v1',
            models: [{ id: 'm', name: 'M' }],
          },
        },
      }),
    ]);
    let fetchCalled = false;

    await expect(
      testProviderConnection(
        { kind: 'saved', providerId: 'legacy-remote-no-auth', agent: 'codex' },
        async () => {
          fetchCalled = true;
          return fakeResponse(200, '{}');
        },
      ),
    ).rejects.toThrow(/disabled/);
    expect(fetchCalled).toBe(false);
  });
});
