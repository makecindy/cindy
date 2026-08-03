import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

type Registry = {
  set(threadId: string, text: string): void;
  get(threadId: string): string | undefined;
  delete(threadId: string): void;
  readonly size: number;
};

const mockState = vi.hoisted(() => {
  let capturedRegistry: Registry | null = null;
  const state = {
    userData: '/tmp/xdt-maker-test',
    logDir: '/tmp/xdt-maker-test/logs',
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    createAnthropicCompatProxy: vi.fn(),
    createResponsesChatHandler: vi.fn(() => ({ handle: vi.fn(async () => undefined) })),
    createResponsesAnthropicHandler: vi.fn(() => ({ handle: vi.fn(async () => undefined) })),
    injectionTransform: vi.fn<(body: unknown, ctx: unknown) => unknown | null>(() => null),
    stripNonAnthropicFields: vi.fn<(body: unknown, ctx: unknown) => unknown | null>(() => null),
    recordXaiRateLimitSnapshot: vi.fn(),
    createInstructionsInjectionTransform: vi.fn((opts: { registry: Registry }) => {
      capturedRegistry = opts.registry;
      return (body: unknown, ctx: unknown) => state.injectionTransform(body, ctx);
    }),
    get capturedRegistry() {
      return capturedRegistry;
    },
    resetCapturedRegistry() {
      capturedRegistry = null;
    },
  };
  return state;
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => mockState.userData),
    getAppPath: vi.fn(() => process.cwd()),
  },
}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mockState.logger,
  getLogLevel: () => 'debug',
  getLogDir: () => mockState.logDir,
}));

vi.mock('../../usageBroadcaster.js', () => ({
  recordXaiRateLimitSnapshot: mockState.recordXaiRateLimitSnapshot,
}));

// SUT 链(codex-gateway-config → runtime-configs)运行期读端点清单;单测里没有
// initClientEndpoints,mock 成 fixture 直读(与 XD_GATEWAY_BASE_URL 断言值同源)。
vi.mock('../../clientEndpointsService.js', async () => {
  const { TEST_CLIENT_ENDPOINTS } = await import('../../../test/vitest/clientEndpointsFixture');
  return {
    getClientEndpoint: (key: keyof typeof TEST_CLIENT_ENDPOINTS) => TEST_CLIENT_ENDPOINTS[key],
  };
});

// 网关端点运行期来自 model-access 下发(effectiveXdGatewayBaseUrl),mock 成 fixture 值。
vi.mock('../../model-access/effectiveEndpoint.js', async () => {
  const { TEST_XD_GATEWAY_BASE_URL } = await import('../../../test/vitest/clientEndpointsFixture');
  return { effectiveXdGatewayBaseUrl: () => TEST_XD_GATEWAY_BASE_URL };
});

vi.mock('@cindy/anthropic-compat-proxy', () => ({
  createAnthropicCompatProxy: mockState.createAnthropicCompatProxy,
  createInstructionsInjectionTransform: mockState.createInstructionsInjectionTransform,
  createActiveStripTransform: () => (() => null),
  createThreadStripController: () => ({ markActive: () => {}, reconcile: () => {}, shouldStrip: () => false, clear: () => {} }),
  createEncryptedContentRecoveryRule: (opts: { enabled: () => boolean }) => ({
    id: 'encrypted_content',
    enabled: opts.enabled,
    matches: (text: string) =>
      /invalid_encrypted_content|could not decrypt the provided encrypted_content/i.test(text),
    strip: () => null,
  }),
  createImageGenerationIdRecoveryRule: () => ({
    id: 'image_generation_id',
    enabled: () => true,
    matches: (text: string) =>
      /image generation items without [`']?id[`']? are not supported/i.test(text),
    strip: () => null,
  }),
  stripEncryptedContentFromBody: () => null,
  stripImageGenerationItemsWithoutIdFromBody: () => null,
  stripNonAnthropicFields: mockState.stripNonAnthropicFields,
  createInstructionsRegistry: () => {
    const map = new Map<string, string>();
    return {
      set: (threadId: string, text: string) => { map.set(threadId, text); },
      get: (threadId: string) => map.get(threadId),
      delete: (threadId: string) => { map.delete(threadId); },
      get size() { return map.size; },
    };
  },
}));

vi.mock('@cindy/responses-chat-bridge', () => ({
  createResponsesChatHandler: mockState.createResponsesChatHandler,
}));

vi.mock('@cindy/responses-anthropic-bridge', () => ({
  createResponsesAnthropicHandler: mockState.createResponsesAnthropicHandler,
}));

async function freshCodexProxyHost() {
  vi.resetModules();
  mockState.createAnthropicCompatProxy.mockReset();
  mockState.createResponsesChatHandler.mockClear();
  mockState.createResponsesAnthropicHandler.mockClear();
  mockState.createInstructionsInjectionTransform.mockClear();
  mockState.injectionTransform.mockReset();
  mockState.injectionTransform.mockReturnValue(null);
  mockState.stripNonAnthropicFields.mockReset();
  mockState.stripNonAnthropicFields.mockReturnValue(null);
  mockState.resetCapturedRegistry();
  return import('../codex-proxy-host.js');
}

describe('withCodexUpstreamRecording', () => {
  const DEFAULT_UPSTREAM = 'https://gateway.example/v1';
  const ctxFor = (threadId?: string) => ({
    reqId: 1,
    method: 'POST',
    url: '/responses',
    headers: threadId ? { 'thread-id': threadId } : {},
  }) as never;

  it('records the override upstream origin for the request thread', async () => {
    const host = await freshCodexProxyHost();
    host.resetCodexThreadUpstreamForTest();
    const wrapped = host.withCodexUpstreamRecording(
      () => ({ upstreamOverride: 'https://api.x.ai/v1' }),
      () => DEFAULT_UPSTREAM,
    );

    await wrapped({}, ctxFor('t-xai'));

    // 诊断必须报本次真正打的上游 —— 会话选了 xAI 就不能报 gateway。
    expect(host.getCodexThreadUpstreamOrigin('t-xai')).toBe('https://api.x.ai');
    // 没记录过的 thread 不借用别人的结论。
    expect(host.getCodexThreadUpstreamOrigin('t-other')).toBe(null);
  });

  it('falls back to the default upstream when the decision does not override it', async () => {
    const host = await freshCodexProxyHost();
    host.resetCodexThreadUpstreamForTest();
    const wrapped = host.withCodexUpstreamRecording(() => null, () => DEFAULT_UPSTREAM);

    await wrapped({}, ctxFor('t-default'));

    expect(host.getCodexThreadUpstreamOrigin('t-default')).toBe('https://gateway.example');
  });

  it('records through an async decision and returns it unchanged', async () => {
    // chat-bridge 分支返回 Promise;包装层必须同样记录,且不改变 decision。
    const host = await freshCodexProxyHost();
    host.resetCodexThreadUpstreamForTest();
    const decision = { upstreamOverride: 'https://custom.provider:8443/v1' };
    const wrapped = host.withCodexUpstreamRecording(
      () => Promise.resolve(decision),
      () => DEFAULT_UPSTREAM,
    );

    await expect(wrapped({}, ctxFor('t-async'))).resolves.toBe(decision);
    expect(host.getCodexThreadUpstreamOrigin('t-async')).toBe('https://custom.provider:8443');
  });

  it('does not record for localHandler decisions or thread-less requests', async () => {
    const host = await freshCodexProxyHost();
    host.resetCodexThreadUpstreamForTest();

    // localHandler 与其余路由字段互斥,不发生上游转发 → 没有出口可记。
    const local = host.withCodexUpstreamRecording(
      () => ({ localHandler: { handle: async () => undefined } }) as never,
      () => DEFAULT_UPSTREAM,
    );
    await local({}, ctxFor('t-local'));
    expect(host.getCodexThreadUpstreamOrigin('t-local')).toBe(null);

    // 无 thread 的控制面请求(models 轮询)会被 selectedThreadIdFromHeaders 回落成
    // 字面量 'unknown';那不是 thread,不该进桶。
    const plain = host.withCodexUpstreamRecording(() => null, () => DEFAULT_UPSTREAM);
    await plain({}, ctxFor(undefined));
    expect(host.getCodexThreadUpstreamOrigin('unknown')).toBe(null);
  });

  it('records the chat-bridge upstream even though it routes through a localHandler', async () => {
    // localHandler 不等于「不出网」:chat bridge 的 handler 自己用 outboundFetch 打
    // route.routing.upstream,照样产生出站路径快照。漏记会让该供应商不可达时诊断
    // 查不到映射、静默退回通用猜测清单。
    const host = await freshCodexProxyHost();
    host.resetCodexThreadUpstreamForTest();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'kimi-moonshot',
        name: 'Kimi (Moonshot 中国大陆)',
        runtimes: {
          codex: {
            baseUrl: 'https://api.moonshot.cn/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'kimi-k3', name: 'Kimi K3' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'moonshot-key');
    host.registerComposed('session-kimi-diag', 'thread-kimi-diag', 'PRODUCT_PROMPT');
    setSessionProvider('session-kimi-diag', 'kimi-moonshot');
    host.setCodexProxyAuthInjection('env-key');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'kimi-k3' },
        { reqId: 1, method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-kimi-diag' } },
      ));
      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      expect(host.getCodexThreadUpstreamOrigin('thread-kimi-diag')).toBe('https://api.moonshot.cn');
    } finally {
      clearSessionProvider('session-kimi-diag');
      setCustomProviders([]);
    }
  });

  it('records the Anthropic bridge upstream even though it routes through a localHandler', async () => {
    const host = await freshCodexProxyHost();
    host.resetCodexThreadUpstreamForTest();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'anthropic-compatible',
        name: 'Anthropic Compatible',
        runtimes: {
          codex: {
            baseUrl: 'https://messages.provider.example/v1',
            wireProtocol: 'anthropic-messages',
            models: [{ id: 'claude-compatible', name: 'Claude Compatible' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'provider-key');
    host.registerComposed('session-anthropic-diag', 'thread-anthropic-diag', 'PRODUCT_PROMPT');
    setSessionProvider('session-anthropic-diag', 'anthropic-compatible');
    host.setCodexProxyAuthInjection('env-key');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'claude-compatible' },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-anthropic-diag' },
        },
      ));
      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      expect(host.getCodexThreadUpstreamOrigin('thread-anthropic-diag')).toBe(
        'https://messages.provider.example',
      );
      const anthropicHandlerCalls = mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
        { promptCaching: boolean; automaticPromptCaching: boolean },
      ]>;
      const config = anthropicHandlerCalls.at(-1)?.[0];
      expect(config?.promptCaching).toBe(false);
      expect(config?.automaticPromptCaching).toBe(false);
    } finally {
      clearSessionProvider('session-anthropic-diag');
      setCustomProviders([]);
    }
  });

  it('never lets a recording failure affect forwarding', async () => {
    // 诊断旁路:默认上游取值抛错也不能影响 decision。
    const host = await freshCodexProxyHost();
    host.resetCodexThreadUpstreamForTest();
    const decision = { upstreamOverride: 'https://api.x.ai/v1' };
    const wrapped = host.withCodexUpstreamRecording(
      () => decision,
      () => { throw new Error('endpoint unavailable'); },
    );

    expect(await wrapped({}, ctxFor('t-boom'))).toBe(decision);
  });
});

describe('codex gateway config', () => {
  it('oauth-bearer 模式: requires_openai_auth, 不带 env_key', async () => {
    const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');

    const args = buildCodexProxySpawnArgs('http://127.0.0.1:12345', 'oauth-bearer');

    expect(args).toContain('model_providers.cindy_gateway.base_url="http://127.0.0.1:12345"');
    expect(args).toContain('model_providers.cindy_gateway.requires_openai_auth=true');
    expect(args).not.toContain('model_providers.cindy_gateway.env_key="XDT_CODEX_API_KEY"');
    expect(args).toContain('model_providers.cindy_gateway.supports_websockets=false');
  });

  it('oauth-bearer 模式: 追加 OpenAI 身份 provider(远端压缩)并关掉请求 zstd 压缩', async () => {
    const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');

    const args = buildCodexProxySpawnArgs('http://127.0.0.1:12345', 'oauth-bearer');

    // 默认 model_provider 仍是 cindy_gateway(本地压缩安全缺省);OpenAI 身份靠
    // thread/start|resume 的 modelProvider 显式选入。
    expect(args).toContain('model_provider="cindy_gateway"');
    // name 必须逐字 "OpenAI" —— codex supports_remote_compaction() 按 name 判定。
    expect(args).toContain('model_providers.cindy_openai.name="OpenAI"');
    expect(args).toContain('model_providers.cindy_openai.base_url="http://127.0.0.1:12345"');
    expect(args).toContain('model_providers.cindy_openai.wire_api="responses"');
    expect(args).toContain('model_providers.cindy_openai.requires_openai_auth=true');
    expect(args).toContain('model_providers.cindy_openai.supports_websockets=true');
    // is_openai + OAuth 命中时 codex 默认 zstd 压缩请求体,loopback proxy 无法解析,必须关。
    expect(args).toContain('features.enable_request_compression=false');
  });

  it('env-key / provider-oauth 模式: 不定义 OpenAI 身份 provider', async () => {
    const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');

    for (const mode of ['env-key', 'provider-oauth'] as const) {
      const args = buildCodexProxySpawnArgs('http://127.0.0.1:12345', mode);
      expect(args.some((arg) => arg.includes('cindy_openai'))).toBe(false);
      expect(args).not.toContain('features.enable_request_compression=false');
    }
  });

  it('env-key 模式: env_key=XDT_CODEX_API_KEY, 不带 requires_openai_auth', async () => {
    const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');

    const args = buildCodexProxySpawnArgs('http://127.0.0.1:12345', 'env-key');

    expect(args).toContain('model_providers.cindy_gateway.env_key="XDT_CODEX_API_KEY"');
    expect(args).not.toContain('model_providers.cindy_gateway.requires_openai_auth=true');
    expect(args).toContain('model_providers.cindy_gateway.supports_websockets=false');
  });

  it('provider-oauth 模式: 仍用 env_key 占位,由 proxy 覆盖供应商 OAuth token', async () => {
    const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');

    const args = buildCodexProxySpawnArgs('http://127.0.0.1:12345', 'provider-oauth');

    expect(args).toContain('model_providers.cindy_gateway.env_key="XDT_CODEX_API_KEY"');
    expect(args).not.toContain('model_providers.cindy_gateway.requires_openai_auth=true');
    expect(args).toContain('model_providers.cindy_gateway.supports_websockets=false');
  });
});

describe('createCrossProviderCompactionCompatTransform', () => {
  const CTX_BASE = { reqId: 1, method: 'POST', url: '/responses', headers: { 'thread-id': 't-1' } };
  const compactionItem = { type: 'compaction', encrypted_content: 'ENC' };
  const contextCompactionItem = { type: 'context_compaction', id: 'cc_1', encrypted_content: 'ENC2' };
  const userMessage = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] };

  it('把加密压缩块替换为明文占位 message(非 ChatGPT 上游)', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();

    const out = transform(
      { model: 'gpt-5.5', input: [compactionItem, contextCompactionItem, userMessage] },
      { ...CTX_BASE, upstreamBase: 'https://gateway.example.com/v1' },
    ) as { input: Array<Record<string, unknown>> };

    expect(out).not.toBeNull();
    expect(out.input).toHaveLength(3);
    expect(out.input[0].type).toBe('message');
    expect(out.input[1].type).toBe('message');
    expect(JSON.stringify(out.input)).not.toContain('ENC');
    expect(JSON.stringify(out.input[0])).toContain('compacted into an encrypted snapshot');
    // 压缩点之后的原有消息原样保留
    expect(out.input[2]).toEqual(userMessage);
  });

  it('ChatGPT 上游原样透传(远端压缩语义不受影响)', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();

    expect(transform(
      { model: 'gpt-5.5', input: [compactionItem, userMessage] },
      { ...CTX_BASE, upstreamBase: 'https://chatgpt.com/backend-api/codex' },
    )).toBeNull();
  });

  it('upstreamBase 缺失时不改写(保守方向:宁可维持现状,不误伤 ChatGPT 请求)', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();

    expect(transform({ model: 'gpt-5.5', input: [compactionItem] }, CTX_BASE)).toBeNull();
  });

  it('无压缩块时零改写', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();

    expect(transform(
      { model: 'codex/gpt-5.5', input: [userMessage] },
      { ...CTX_BASE, upstreamBase: 'https://gateway.example.com/v1' },
    )).toBeNull();
  });

  it('不携带加密内容的 compaction 变体原样透传(只处理"上游解不开"的加密块)', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();

    expect(transform(
      { model: 'gpt-5.5', input: [{ type: 'context_compaction', id: 'cc_2' }, { type: 'compaction', encrypted_content: '' }] },
      { ...CTX_BASE, upstreamBase: 'https://gateway.example.com/v1' },
    )).toBeNull();
  });
});

describe('decideCodexRoute', () => {
  const CHATGPT = 'https://chatgpt.com/backend-api/codex';

  it('env-key spawn → 不 override(codex 已带 gateway key, 走默认上游)', async () => {
    const { decideCodexRoute } = await import('../codex-proxy-host.js');
    expect(decideCodexRoute({ model: 'gpt-5.5', authInjection: 'env-key', gatewayKey: 'k' })).toBeNull();
    expect(decideCodexRoute({ model: 'codex/gpt-5.5', authInjection: 'env-key', gatewayKey: 'k' })).toBeNull();
  });

  it('oauth-bearer + codex/ 折扣模型 → 换 gateway key', async () => {
    const { decideCodexRoute } = await import('../codex-proxy-host.js');
    expect(decideCodexRoute({ model: 'codex/gpt-5.5', authInjection: 'oauth-bearer', gatewayKey: 'gw' }))
      .toEqual({ headerOverride: { authorization: 'Bearer gw' } });
  });

  it('oauth-bearer + 普通模型 → override 到 ChatGPT, 不换 header(订阅默认)', async () => {
    const { decideCodexRoute } = await import('../codex-proxy-host.js');
    expect(decideCodexRoute({ model: 'gpt-5.5', authInjection: 'oauth-bearer', gatewayKey: 'gw' }))
      .toEqual({ upstreamOverride: CHATGPT });
  });

  it('oauth-bearer + codex/ 折扣但无 gateway key → null(passthrough)', async () => {
    const { decideCodexRoute } = await import('../codex-proxy-host.js');
    expect(decideCodexRoute({ model: 'codex/gpt-5.5', authInjection: 'oauth-bearer', gatewayKey: null })).toBeNull();
  });

  it('空 model → null', async () => {
    const { decideCodexRoute } = await import('../codex-proxy-host.js');
    expect(decideCodexRoute({ model: '', authInjection: 'oauth-bearer', gatewayKey: 'gw' })).toBeNull();
  });
});

describe('chatBridgeCapabilitiesForRoute', () => {
  it('does not forward unsupported passthrough fields into the translator', async () => {
    const { chatBridgeCapabilitiesForRoute } = await freshCodexProxyHost();
    const capabilities = chatBridgeCapabilitiesForRoute(
      'https://api.deepseek.com/v1',
      'deepseek-chat',
    );
    expect(capabilities.passthroughFields).not.toContain('n');
    expect(capabilities.passthroughFields).not.toContain('logprobs');
    expect(capabilities.passthroughFields).not.toContain('top_logprobs');
  });

  it.each([
    'https://api.moonshot.cn/v1',
    'https://api.moonshot.ai/v1/',
  ])('enables image_url only for Kimi K3 on official Moonshot host: %s', async (upstream) => {
    const { chatBridgeCapabilitiesForRoute } = await freshCodexProxyHost();
    expect(chatBridgeCapabilitiesForRoute(upstream, 'kimi-k3').imageInput).toBe('image_url');
  });

  it.each([
    ['https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-pro-260628'],
    ['https://ark.ap-southeast-1.volces.com/api/v3/', 'doubao-seed-1-6-vision-260615'],
  ])('enables image_url for Doubao Seed on official Volcengine Ark host: %s (#771)', async (upstream, model) => {
    const { chatBridgeCapabilitiesForRoute } = await freshCodexProxyHost();
    expect(chatBridgeCapabilitiesForRoute(upstream, model).imageInput).toBe('image_url');
  });

  it.each([
    ['https://coding.dashscope.aliyuncs.com/v1', 'qwen3.7-plus'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus'],
    ['https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus'],
    ['https://coding.dashscope.aliyuncs.com/v1', 'qwen3.8-max-preview'],
    ['https://coding.dashscope.aliyuncs.com/v1', 'qwen3.6-flash'],
  ])('enables image_url for Qwen on official DashScope host: %s / %s', async (upstream, model) => {
    const { chatBridgeCapabilitiesForRoute } = await freshCodexProxyHost();
    expect(chatBridgeCapabilitiesForRoute(upstream, model).imageInput).toBe('image_url');
  });

  it.each([
    ['https://api.moonshot.cn/v1', 'kimi-k2.6'],
    ['https://api.deepseek.com/v1', 'kimi-k3'],
    ['https://api.moonshot.cn.evil.example/v1', 'kimi-k3'],
    ['http://api.moonshot.cn/v1', 'kimi-k3'],
    ['not-a-url', 'kimi-k3'],
    ['https://api.deepseek.com/v1', 'deepseek-v4-pro'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'deepseek-v4-pro'],
    ['https://api.deepseek.com/v1', 'doubao-seed-2-1-pro-260628'],
    ['https://ark.cn-beijing.volces.com.evil.example/api/v3', 'doubao-seed-2-1-pro-260628'],
    ['http://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-pro-260628'],
    // Seed 1.6 之前的版本号不放行(1.6 起才是原生多模态品牌线),锁死版本契约。
    ['https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-1-5-pro-260101'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-1-0'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-pro'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'doubao-1-5-vision-pro'],
    // Qwen: 非官方域名、非 HTTPS、未确认 model 均不放行。
    ['http://coding.dashscope.aliyuncs.com/v1', 'qwen3.7-plus'],
    ['https://coding.dashscope.aliyuncs.com.evil.example/v1', 'qwen3.7-plus'],
    ['https://example.com/v1', 'qwen3.7-plus'],
    ['https://coding.dashscope.aliyuncs.com/v1', 'qwen3-coder-next'],
  ])('keeps image input disabled for non-matching route %s / %s', async (upstream, model) => {
    const { chatBridgeCapabilitiesForRoute } = await freshCodexProxyHost();
    expect(chatBridgeCapabilitiesForRoute(upstream, model).imageInput).toBeUndefined();
  });

  it('passes image support into the handler for a preset-derived custom Kimi route', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'kimi-moonshot',
        name: 'Kimi (Moonshot 中国大陆)',
        runtimes: {
          codex: {
            baseUrl: 'https://api.moonshot.cn/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'kimi-k3', name: 'Kimi K3' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'moonshot-key');
    host.registerComposed('session-kimi-image', 'thread-kimi-image', 'PRODUCT_PROMPT');
    setSessionProvider('session-kimi-image', 'kimi-moonshot');
    host.setCodexProxyAuthInjection('env-key');

    const decision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'kimi-k3',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,eA==' }],
        }],
      },
      {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-kimi-image' },
      },
    ));

    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    expect(mockState.createResponsesChatHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamBase: 'https://api.moonshot.cn/v1',
        capabilities: expect.objectContaining({ imageInput: 'image_url' }),
      }),
      expect.anything(),
    );
    const localHandler = (decision as {
      localHandler: (input: { rawBody: Buffer; parsedBody: unknown; res: unknown }) => Promise<void>;
    }).localHandler;
    const originalInstructions = [
      { type: 'input_text', text: 'BASE_PROMPT' },
      { type: 'input_image', image_url: 'data:image/png;base64,eA==' },
    ];
    const parsedBody = {
      model: 'kimi-k3',
      instructions: originalInstructions,
      input: 'hello',
    };
    const res = {};
    await localHandler({
      rawBody: Buffer.from(JSON.stringify(parsedBody)),
      parsedBody,
      res,
    });
    const bridgeHandler = mockState.createResponsesChatHandler.mock.results.at(-1)?.value as {
      handle: ReturnType<typeof vi.fn>;
    };
    expect(bridgeHandler.handle).toHaveBeenCalledWith({
      parsedBody: {
        ...parsedBody,
        instructions: [
          ...originalInstructions,
          { type: 'input_text', text: '\n\nPRODUCT_PROMPT' },
        ],
      },
      res,
    });

    clearSessionProvider('session-kimi-image');
    setCustomProviderKeyReader(() => null);
    setCustomProviders([]);
  });

  it('routes a custom Codex Anthropic Messages runtime to the local bridge with provider-owned auth', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'custom-anthropic',
        name: 'Custom Anthropic',
        runtimes: {
          codex: {
            baseUrl: 'https://api.anthropic.com',
            wireProtocol: 'anthropic-messages',
            models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'anthropic-key');
    host.registerComposed('session-anthropic', 'thread-anthropic', 'PRODUCT_PROMPT');
    setSessionProvider('session-anthropic', 'custom-anthropic');
    host.setCodexProxyAuthInjection('env-key');

    const decision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-sonnet-4-6',
        input: [{ role: 'user', content: 'hello' }],
      },
      {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-anthropic' },
      },
    ));

    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    expect(mockState.createResponsesAnthropicHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamBase: 'https://api.anthropic.com',
        buildHeaders: expect.any(Function),
      }),
      expect.anything(),
    );
    const anthropicHandlerCalls = mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
      {
        promptCaching: boolean;
        automaticPromptCaching: boolean;
        strictTools: boolean;
        buildHeaders: () => Promise<Record<string, string>>;
      },
    ]>;
    const config = anthropicHandlerCalls.at(-1)?.[0];
    expect(config).toBeDefined();
    if (!config) throw new Error('Anthropic bridge config was not captured');
    expect(await config.buildHeaders()).toEqual({
      'x-api-key': 'anthropic-key',
      authorization: 'Bearer anthropic-key',
    });
    expect(config.promptCaching).toBe(true);
    expect(config.automaticPromptCaching).toBe(true);
    expect(config.strictTools).toBe(true);

    clearSessionProvider('session-anthropic');
    setCustomProviderKeyReader(() => null);
    setCustomProviders([]);
  });

  it('routes the built-in Anthropic subscription through the bridge with host-owned Claude.ai OAuth', async () => {
    const host = await freshCodexProxyHost();
    const { setAnthropicDiscoveredModels } = await import('../active-catalog.js');
    const { setProviderOAuthTokenReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setAnthropicDiscoveredModels([
      {
        id: 'claude-opus-5',
        name: 'Opus 5',
        contextWindow: 1_000_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        status: 'active',
      },
      {
        id: 'claude-sonnet-4-5',
        name: 'Sonnet 4.5',
        contextWindow: 200_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        status: 'active',
      },
    ]);
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'anthropic' && agent === 'codex'
        ? Promise.resolve('claude-subscription-token')
        : null,
    );
    host.registerComposed(
      'session-anthropic-subscription',
      'thread-anthropic-subscription',
      'PRODUCT_PROMPT',
    );
    setSessionProvider('session-anthropic-subscription', 'anthropic');
    host.setCodexProxyAuthInjection('oauth-bearer');

    const decision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-opus-5',
        input: [{ role: 'user', content: 'hello' }],
      },
      {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: {
          'thread-id': 'thread-anthropic-subscription',
          authorization: 'Bearer codex-openai-token-must-not-leak',
          'chatgpt-account-id': 'account-must-not-leak',
        },
      },
    ));

    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    const anthropicHandlerCalls = mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
      {
        buildHeaders: () => Promise<Record<string, string>>;
        rewriteModel: (model: string) => string;
      },
    ]>;
    const config = anthropicHandlerCalls.at(-1)?.[0];
    expect(config).toBeDefined();
    if (!config) throw new Error('Anthropic subscription bridge config was not captured');
    const headers = await config.buildHeaders();
    expect(headers).toEqual(expect.objectContaining({
      'anthropic-version': '2023-06-01',
      authorization: 'Bearer claude-subscription-token',
      'x-app': 'cli',
      'x-stainless-runtime': 'node',
      'x-claude-code-session-id': expect.any(String),
      'x-client-request-id': expect.any(String),
    }));
    expect(headers['anthropic-beta']?.split(',')).toEqual([
      'claude-code-20250219',
      'oauth-2025-04-20',
      'context-1m-2025-08-07',
    ]);
    expect(config.rewriteModel('claude-opus-5[1m]')).toBe('claude-opus-5');

    await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-sonnet-4-5',
        input: [{ role: 'user', content: 'short context' }],
      },
      {
        reqId: 2,
        method: 'POST',
        url: '/responses',
        headers: {
          'thread-id': 'thread-anthropic-subscription',
        },
      },
    ));
    const ordinaryConfig = (mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
      { buildHeaders: () => Promise<Record<string, string>> },
    ]>).at(-1)?.[0];
    expect(ordinaryConfig).toBeDefined();
    if (!ordinaryConfig) throw new Error('ordinary Anthropic bridge config was not captured');
    expect((await ordinaryConfig.buildHeaders())['anthropic-beta']?.split(',')).toEqual([
      'claude-code-20250219',
      'oauth-2025-04-20',
    ]);

    clearSessionProvider('session-anthropic-subscription');
    setProviderOAuthTokenReader(() => null);
    setAnthropicDiscoveredModels([]);
  });

  it('refreshes non-Anthropic provider OAuth without applying Claude.ai credentials or policy', async () => {
    const host = await freshCodexProxyHost();
    const { BUNDLED_CATALOG } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const { setProviderOAuthTokenReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    const catalog = structuredClone(BUNDLED_CATALOG);
    const xai = catalog.providers.find((provider) => provider.id === 'xai');
    if (!xai?.routing.codex) throw new Error('expected bundled xAI Codex route');
    xai.routing.codex = {
      ...xai.routing.codex,
      wireProtocol: 'anthropic-messages',
    };
    setActiveCatalog(catalog);
    const tokenReader = vi.fn((providerId: string, agent: string, options?: { forceRefresh?: boolean }) => (
      providerId === 'xai' && agent === 'codex'
        ? options?.forceRefresh ? 'xai-refreshed-token' : 'xai-initial-token'
        : null
    ));
    setProviderOAuthTokenReader(tokenReader);
    host.registerComposed('session-xai-anthropic-wire', 'thread-xai-anthropic-wire', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai-anthropic-wire', 'xai');
    host.setCodexProxyAuthInjection('oauth-bearer');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        {
          model: 'xai/grok-4.3',
          input: [{ role: 'user', content: 'hello' }],
        },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-xai-anthropic-wire' },
        },
      ));
      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      const anthropicHandlerCalls = mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
        {
          authMode: string;
          buildHeaders: () => Promise<Record<string, string>>;
          refreshHeaders: (input: {
            status: 401 | 403;
            body: string;
            requestHeaders: Readonly<Record<string, string>>;
          }) => Promise<Record<string, string> | null>;
        },
      ]>;
      const config = anthropicHandlerCalls.at(-1)?.[0];
      expect(config).toBeDefined();
      if (!config) throw new Error('xAI Anthropic bridge config was not captured');
      expect(config.authMode).toBe('api-key');
      const initialHeaders = await config.buildHeaders();
      expect(initialHeaders.authorization).toBe('Bearer xai-initial-token');
      expect(initialHeaders).not.toHaveProperty('x-app');
      expect(initialHeaders).not.toHaveProperty('x-claude-code-session-id');

      const refreshedHeaders = await config.refreshHeaders({
        status: 401,
        body: 'expired',
        requestHeaders: initialHeaders,
      });
      expect(refreshedHeaders?.authorization).toBe('Bearer xai-refreshed-token');
      expect(refreshedHeaders).not.toHaveProperty('x-app');
      expect(tokenReader).toHaveBeenLastCalledWith('xai', 'codex', {
        forceRefresh: true,
        staleToken: 'xai-initial-token',
      });
      expect(tokenReader.mock.calls.some(([providerId]) => providerId === 'anthropic')).toBe(false);
    } finally {
      clearSessionProvider('session-xai-anthropic-wire');
      setProviderOAuthTokenReader(() => null);
      setActiveCatalog(BUNDLED_CATALOG);
    }
  });

  it('routes only XD Claude-only models through the Anthropic bridge in env-key mode', async () => {
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([
      { id: 'gpt-native', agents: ['claude-code', 'codex'] },
      { id: 'claude-bridge', agents: ['claude-code'] },
    ]);
    host.setCodexProxyGatewayKeyReader(() => 'xd-gateway-key');
    host.registerComposed('session-xd-bridge', 'thread-xd-bridge', 'PRODUCT_PROMPT');
    setSessionProvider('session-xd-bridge', 'xd');
    host.setCodexProxyAuthInjection('env-key');

    const bridgeDecision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-bridge[1m]',
        input: [{ role: 'user', content: 'hello' }],
      },
      {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: {
          'thread-id': 'thread-xd-bridge',
          authorization: 'Bearer codex-token-must-not-leak',
          'chatgpt-account-id': 'account-must-not-leak',
        },
      },
    ));

    expect(bridgeDecision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    expect(host.registerChildThread('thread-xd-bridge', 'thread-xd-child')).toBe(true);
    const childBridgeDecision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-bridge',
        input: [{ role: 'user', content: 'child hello' }],
      },
      {
        reqId: 2,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-child' },
      },
    ));
    expect(childBridgeDecision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));

    expect(host.registerChildThread('thread-xd-child', 'thread-xd-grandchild')).toBe(true);
    const grandchildBridgeDecision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-bridge',
        input: [{ role: 'user', content: 'grandchild hello' }],
      },
      {
        reqId: 3,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-grandchild' },
      },
    ));
    expect(grandchildBridgeDecision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));

    const anthropicHandlerCalls = mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
      {
        upstreamBase: string;
        promptCaching: boolean;
        automaticPromptCaching: boolean;
        strictTools: boolean;
        buildHeaders: () => Promise<Record<string, string>>;
        rewriteModel: (model: string) => string;
      },
    ]>;
    const config = anthropicHandlerCalls[0]?.[0];
    expect(config).toBeDefined();
    if (!config) throw new Error('XD Anthropic bridge config was not captured');
    expect(config.upstreamBase).toBe(XD_GATEWAY_BASE_URL);
    expect(config.promptCaching).toBe(true);
    expect(config.automaticPromptCaching).toBe(false);
    expect(config.strictTools).toBe(false);
    expect(await config.buildHeaders()).toEqual({
      'x-api-key': 'xd-gateway-key',
      authorization: 'Bearer xd-gateway-key',
      'anthropic-beta': 'context-1m-2025-08-07',
    });
    expect(config.rewriteModel('claude-bridge[1m]')).toBe('claude-bridge');

    const nativeDecision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'gpt-native',
        input: [{ role: 'user', content: 'hello' }],
      },
      {
        reqId: 4,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-grandchild' },
      },
    ));
    expect(nativeDecision).toBeNull();
    expect(mockState.createResponsesAnthropicHandler).toHaveBeenCalledTimes(3);

    host.unregister('session-xd-bridge');
    expect(host.registerChildThread('thread-xd-bridge', 'thread-after-close')).toBe(false);
    expect(host.registerChildThread('thread-xd-child', 'thread-after-child-close')).toBe(false);
    expect(host.registerChildThread('thread-xd-grandchild', 'thread-after-grandchild-close')).toBe(false);
    const closedChildDecision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-bridge',
        input: [{ role: 'user', content: 'closed child' }],
      },
      {
        reqId: 5,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-child' },
      },
    ));
    expect(closedChildDecision).toBeNull();
    expect(mockState.createResponsesAnthropicHandler).toHaveBeenCalledTimes(3);

    clearSessionProvider('session-xd-bridge');
    setXdGatewayModels([]);
    host.setCodexProxyGatewayKeyReader(() => null);
  });

  it('routes an implicit XD Claude-only model through the Anthropic bridge', async () => {
    const host = await freshCodexProxyHost();
    const {
      getActiveCatalog,
      setAnthropicDiscoveredModels,
      setXdGatewayModels,
    } = await import('../active-catalog.js');
    const { setProviderViewsReader } = await import('../provider-route.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    setAnthropicDiscoveredModels([{
      id: 'claude-implicit-xd',
      name: 'Implicit Shared Claude',
      group: 'anthropic',
      contextWindow: 200_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      status: 'active',
    }]);
    setXdGatewayModels([{ id: 'claude-implicit-xd', agents: ['claude-code'] }]);
    setProviderViewsReader(async () => getActiveCatalog().providers.map((provider) => ({
      ...provider,
      connected: provider.id === 'xd' || provider.id === 'anthropic',
    })));
    host.setCodexProxyGatewayKeyReader(() => 'xd-gateway-key');
    host.registerComposed(
      'session-implicit-xd',
      'thread-implicit-xd',
      'PRODUCT_PROMPT',
    );
    clearSessionProvider('session-implicit-xd');
    host.setCodexProxyAuthInjection('env-key');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        {
          model: 'claude-implicit-xd[1m]',
          input: [{ role: 'user', content: 'hello' }],
        },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-implicit-xd' },
        },
      ));

      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      const anthropicHandlerCalls = mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
        {
          upstreamBase: string;
          authMode: string;
          buildHeaders: () => Promise<Record<string, string>>;
        },
      ]>;
      const config = anthropicHandlerCalls.at(-1)?.[0];
      expect(config).toBeDefined();
      if (!config) throw new Error('implicit XD Anthropic bridge config was not captured');
      expect(config.upstreamBase).toBe(XD_GATEWAY_BASE_URL);
      expect(config.authMode).toBe('api-key');
      expect(await config.buildHeaders()).toEqual({
        'x-api-key': 'xd-gateway-key',
        authorization: 'Bearer xd-gateway-key',
        'anthropic-beta': 'context-1m-2025-08-07',
      });
    } finally {
      host.unregister('session-implicit-xd');
      clearSessionProvider('session-implicit-xd');
      setAnthropicDiscoveredModels([]);
      setXdGatewayModels([]);
      setProviderViewsReader(async () => []);
      host.setCodexProxyGatewayKeyReader(() => null);
    }
  });

  it('does not read live ProviderView credentials for a native Codex model', async () => {
    const host = await freshCodexProxyHost();
    const { setProviderViewsReader } = await import('../provider-route.js');
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    const providerViewsReader = vi.fn(async () => {
      throw new Error('native model must not read provider credentials');
    });
    setProviderViewsReader(providerViewsReader);
    setXdGatewayModels([{ id: 'gpt-native-hot-path', agents: ['codex'] }]);
    host.registerComposed(
      'session-native-hot-path',
      'thread-native-hot-path',
      'PRODUCT_PROMPT',
    );
    clearSessionProvider('session-native-hot-path');
    host.setCodexProxyAuthInjection('env-key');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        {
          model: 'gpt-native-hot-path',
          input: [{ role: 'user', content: 'hello' }],
        },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-native-hot-path' },
        },
      ));

      expect(decision).toBeNull();
      expect(providerViewsReader).not.toHaveBeenCalled();
    } finally {
      host.unregister('session-native-hot-path');
      clearSessionProvider('session-native-hot-path');
      setProviderViewsReader(async () => []);
      setXdGatewayModels([]);
    }
  });

  it('does not overwrite a child thread that is already owned by another session', async () => {
    const host = await freshCodexProxyHost();
    host.registerComposed('session-parent', 'thread-parent', 'PARENT_PROMPT');
    host.registerComposed('session-owner', 'thread-owned', 'OWNER_PROMPT');

    expect(host.registerChildThread('thread-parent', 'thread-owned')).toBe(false);

    host.unregister('session-parent');
    expect(host.registerChildThread('thread-owned', 'thread-owned-child')).toBe(true);

    host.unregister('session-owner');
  });

  it('fails an XD bridged model locally when the gateway key is unavailable', async () => {
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{ id: 'claude-bridge', agents: ['claude-code'] }]);
    host.setCodexProxyGatewayKeyReader(() => null);
    host.registerComposed('session-xd-no-key', 'thread-xd-no-key', 'PRODUCT_PROMPT');
    setSessionProvider('session-xd-no-key', 'xd');
    host.setCodexProxyAuthInjection('env-key');

    const decision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-bridge',
        input: [{ role: 'user', content: 'hello' }],
      },
      {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-no-key' },
      },
    ));

    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    expect(mockState.createResponsesAnthropicHandler).not.toHaveBeenCalled();

    clearSessionProvider('session-xd-no-key');
    setXdGatewayModels([]);
  });

  it('fails the built-in Anthropic subscription bridge locally when Claude.ai OAuth is missing', async () => {
    const host = await freshCodexProxyHost();
    const { setProviderOAuthTokenReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setProviderOAuthTokenReader(() => null);
    host.registerComposed(
      'session-anthropic-no-auth',
      'thread-anthropic-no-auth',
      'PRODUCT_PROMPT',
    );
    setSessionProvider('session-anthropic-no-auth', 'anthropic');

    const decision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-opus-5',
        input: [{ role: 'user', content: 'hello' }],
      },
      {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-anthropic-no-auth' },
      },
    ));

    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    expect(mockState.createResponsesAnthropicHandler).not.toHaveBeenCalled();

    clearSessionProvider('session-anthropic-no-auth');
  });

  it('routes an implicit Anthropic-only model through the subscription bridge', async () => {
    const host = await freshCodexProxyHost();
    const {
      getActiveCatalog,
      setAnthropicDiscoveredModels,
      setXdGatewayModels,
    } = await import('../active-catalog.js');
    const {
      setProviderOAuthTokenReader,
      setProviderViewsReader,
    } = await import('../provider-route.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    setAnthropicDiscoveredModels([{
      id: 'claude-implicit-anthropic',
      name: 'Implicit Anthropic',
      group: 'anthropic',
      contextWindow: 200_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      status: 'active',
    }]);
    setXdGatewayModels([]);
    setProviderViewsReader(async () => getActiveCatalog().providers.map((provider) => ({
      ...provider,
      connected: provider.id === 'anthropic',
    })));
    setProviderOAuthTokenReader((providerId, agent) => (
      providerId === 'anthropic' && agent === 'codex'
        ? 'claude-subscription-token'
        : null
    ));
    host.registerComposed(
      'session-implicit-anthropic',
      'thread-implicit-anthropic',
      'PRODUCT_PROMPT',
    );
    clearSessionProvider('session-implicit-anthropic');
    host.setCodexProxyAuthInjection('oauth-bearer');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        {
          model: 'claude-implicit-anthropic',
          input: [{ role: 'user', content: 'hello' }],
        },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-implicit-anthropic' },
        },
      ));

      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      const anthropicHandlerCalls = mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
        {
          upstreamBase: string;
          authMode: string;
          buildHeaders: () => Promise<Record<string, string>>;
        },
      ]>;
      const config = anthropicHandlerCalls.at(-1)?.[0];
      expect(config).toBeDefined();
      if (!config) throw new Error('implicit Anthropic bridge config was not captured');
      expect(config.upstreamBase).toBe('https://api.anthropic.com');
      expect(config.authMode).toBe('oauth');
      expect(await config.buildHeaders()).toEqual(expect.objectContaining({
        authorization: 'Bearer claude-subscription-token',
        'x-app': 'cli',
      }));
    } finally {
      host.unregister('session-implicit-anthropic');
      clearSessionProvider('session-implicit-anthropic');
      setProviderOAuthTokenReader(() => null);
      setProviderViewsReader(async () => []);
      setAnthropicDiscoveredModels([]);
    }
  });

  it('falls back to connected Anthropic when XD advertises the model without credentials', async () => {
    const host = await freshCodexProxyHost();
    const {
      getActiveCatalog,
      setAnthropicDiscoveredModels,
      setXdGatewayModels,
    } = await import('../active-catalog.js');
    const {
      setProviderOAuthTokenReader,
      setProviderViewsReader,
    } = await import('../provider-route.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    const model: import('@cindy/model-providers').CatalogModel = {
      id: 'claude-connected-anthropic',
      name: 'Connected Anthropic',
      group: 'anthropic',
      contextWindow: 200_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      status: 'active',
    };
    setAnthropicDiscoveredModels([model]);
    setXdGatewayModels([{ id: model.id, agents: ['claude-code'] }]);
    setProviderViewsReader(async () => getActiveCatalog().providers.map((provider) => ({
      ...provider,
      connected: provider.id === 'anthropic',
    })));
    setProviderOAuthTokenReader((providerId, agent) => (
      providerId === 'anthropic' && agent === 'codex'
        ? 'claude-subscription-token'
        : null
    ));
    host.registerComposed(
      'session-connected-anthropic',
      'thread-connected-anthropic',
      'PRODUCT_PROMPT',
    );
    clearSessionProvider('session-connected-anthropic');
    host.setCodexProxyGatewayKeyReader(() => null);
    host.setCodexProxyAuthInjection('oauth-bearer');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        {
          model: model.id,
          input: [{ role: 'user', content: 'hello' }],
        },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-connected-anthropic' },
        },
      ));

      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      const config = (mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
        {
          upstreamBase: string;
          authMode: string;
          buildHeaders: () => Promise<Record<string, string>>;
        },
      ]>).at(-1)?.[0];
      expect(config?.upstreamBase).toBe('https://api.anthropic.com');
      expect(config?.authMode).toBe('oauth');
      expect(await config?.buildHeaders()).toEqual(expect.objectContaining({
        authorization: 'Bearer claude-subscription-token',
      }));
    } finally {
      host.unregister('session-connected-anthropic');
      clearSessionProvider('session-connected-anthropic');
      setProviderOAuthTokenReader(() => null);
      setProviderViewsReader(async () => []);
      setAnthropicDiscoveredModels([]);
      setXdGatewayModels([]);
      host.setCodexProxyGatewayKeyReader(() => null);
    }
  });
});

describe('createModelRoutingTransform —— session-less 控制面请求(桶③)', () => {
  const CHATGPT = 'https://chatgpt.com/backend-api/codex';

  afterEach(async () => {
    const host = await import('../codex-proxy-host.js');
    host.clearCodexProxyAuthInjection();
    host.setCodexProxyGatewayKeyReader(() => null);
  });

  it('oauth-bearer + 无 session + 无 model(GET /models)→ override 到 ChatGPT 订阅后端', async () => {
    const host = await import('../codex-proxy-host.js');
    host.setCodexProxyAuthInjection('oauth-bearer');
    const transform = host.createModelRoutingTransform();
    // GET /models: body=undefined, headers 无 thread-id → 解析不出 session。
    expect(transform(undefined, { reqId: 1, method: 'GET', url: '/models?client_version=0.135.0', headers: {} }))
      .toEqual({ upstreamOverride: CHATGPT });
  });

  it('冻结 control-plane auth 形态后不受 session host 的全局模式改写', async () => {
    const host = await import('../codex-proxy-host.js');
    host.setCodexProxyAuthInjection('provider-oauth');
    const transform = host.createModelRoutingTransform('oauth-bearer');

    host.setCodexProxyAuthInjection('provider-oauth');
    expect(transform(undefined, {
      reqId: 1,
      method: 'GET',
      url: '/models',
      headers: {},
    })).toEqual({ upstreamOverride: CHATGPT });
  });

  it('env-key + 无 session + 无 model(GET /models)→ null(留默认网关, sk- key 本就有效)', async () => {
    const host = await import('../codex-proxy-host.js');
    host.setCodexProxyAuthInjection('env-key');
    const transform = host.createModelRoutingTransform();
    expect(transform(undefined, { reqId: 1, method: 'GET', url: '/models', headers: {} })).toBeNull();
  });

  it('provider-oauth + 无 session + 无 model(GET /models)→ 路由到 provider OAuth 上游', async () => {
    const host = await import('../codex-proxy-host.js');
    const { setProviderOAuthTokenReader } = await import('../provider-route.js');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'xai' && agent === 'codex' ? 'xai-live-token' : null,
    );
    host.setCodexProxyAuthInjection('provider-oauth');
    const transform = host.createModelRoutingTransform();

    await expect(Promise.resolve(
      transform(undefined, { reqId: 1, method: 'GET', url: '/models', headers: {} }),
    )).resolves.toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
      headerOverride: { authorization: 'Bearer xai-live-token' },
      headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
    });

    setProviderOAuthTokenReader(() => null);
  });

  it('无 session 但带 model 的请求不落桶③ —— 仍走 decideCodexRoute(防误伤真实 /responses)', async () => {
    const host = await import('../codex-proxy-host.js');
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.setCodexProxyGatewayKeyReader(() => 'gw');
    const transform = host.createModelRoutingTransform();
    // codex/ 折扣模型 + 无 session: 若被桶③劫持会返回 { upstreamOverride: CHATGPT };
    // 正确行为是落 ② decideCodexRoute → 换 gateway key。
    expect(transform({ model: 'codex/gpt-5.5', input: [] }, { reqId: 1, method: 'POST', url: '/responses', headers: {} }))
      .toEqual({ headerOverride: { authorization: 'Bearer gw' } });
  });

  it('env-key host + xAI session still routes through provider OAuth instead of falling back to gateway', async () => {
    const host = await import('../codex-proxy-host.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    const { setProviderOAuthTokenReader } = await import('../provider-route.js');
    host.registerComposed('session-xai-route', 'thread-xai-route', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai-route', 'xai');
    setProviderOAuthTokenReader((providerId) => (providerId === 'xai' ? 'xai-token' : null));
    host.setCodexProxyAuthInjection('env-key');
    const transform = host.createModelRoutingTransform();

    await expect(Promise.resolve(transform(
      { model: 'xai/grok-4.3', input: [] },
      { reqId: 1, method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-xai-route' } },
    ))).resolves.toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
      headerOverride: { authorization: 'Bearer xai-token' },
      headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
    });

    clearSessionProvider('session-xai-route');
    setProviderOAuthTokenReader(() => null);
  });

  it('implicit xAI model routes through provider OAuth even when sessionProvider is empty', async () => {
    const host = await import('../codex-proxy-host.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    const { setProviderOAuthTokenReader } = await import('../provider-route.js');
    host.registerComposed('session-xai-implicit-route', 'thread-xai-implicit-route', 'PRODUCT_PROMPT');
    clearSessionProvider('session-xai-implicit-route');
    setProviderOAuthTokenReader((providerId) => (providerId === 'xai' ? 'xai-token' : null));
    host.setCodexProxyAuthInjection('env-key');
    const transform = host.createModelRoutingTransform();

    await expect(Promise.resolve(transform(
      { model: 'xai/grok-4.3', input: [] },
      { reqId: 1, method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-xai-implicit-route' } },
    ))).resolves.toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
      headerOverride: { authorization: 'Bearer xai-token' },
      headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
    });

    setProviderOAuthTokenReader(() => null);
  });

  it('provider-oauth spawn + xAI session + 非 xai/ 模型 → 换网关 key 的可用默认路由 (#890 review 第二轮)', async () => {
    // scope 门放下来的请求在 provider-oauth spawn 下只带占位 env key,直落网关必 401 ——
    // 必须换真网关 key 兜底(与 cc oauth-spawn 默认换 key 同语义)。
    const host = await import('../codex-proxy-host.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    host.registerComposed('session-xai-fallback', 'thread-xai-fallback', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai-fallback', 'xai');
    host.setCodexProxyAuthInjection('provider-oauth');
    host.setCodexProxyGatewayKeyReader(() => 'gw-key');
    const transform = host.createModelRoutingTransform();

    expect(transform(
      { model: 'gpt-5.5', input: [] },
      { reqId: 1, method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-xai-fallback' } },
    )).toEqual({ headerOverride: { authorization: 'Bearer gw-key' } });

    // 没网关 key → 保持 null(passthrough,预期 401),不额外兜底。
    host.setCodexProxyGatewayKeyReader(() => null);
    expect(transform(
      { model: 'gpt-5.5', input: [] },
      { reqId: 2, method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-xai-fallback' } },
    )).toBeNull();

    clearSessionProvider('session-xai-fallback');
    host.setCodexProxyGatewayKeyReader(() => null);
  });
});

describe('codex proxy auth injection state', () => {
  it('exposes the spawn-time auth injection mode', async () => {
    const host = await freshCodexProxyHost();

    expect(host.getCodexProxyAuthInjectionState()).toBeNull();
    expect(host.getCodexProxyAuthInjection()).toBe('env-key');
    host.setCodexProxyAuthInjection('oauth-bearer');
    expect(host.getCodexProxyAuthInjectionState()).toBe('oauth-bearer');
    expect(host.getCodexProxyAuthInjection()).toBe('oauth-bearer');
    host.setCodexProxyAuthInjection('env-key');
    expect(host.getCodexProxyAuthInjectionState()).toBe('env-key');
    expect(host.getCodexProxyAuthInjection()).toBe('env-key');
    host.setCodexProxyAuthInjection('provider-oauth');
    expect(host.getCodexProxyAuthInjectionState()).toBe('provider-oauth');
    expect(host.getCodexProxyAuthInjection()).toBe('provider-oauth');
    host.clearCodexProxyAuthInjection();
    expect(host.getCodexProxyAuthInjectionState()).toBeNull();
    expect(host.getCodexProxyAuthInjection()).toBe('env-key');
  });
});

describe('codex proxy host', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-host-'));
    mockState.logDir = tempDir;
    delete process.env.XDT_CODEX_PROXY_DUMP_TRANSFORMED_BODY;
    mockState.logger.trace.mockClear();
    mockState.logger.debug.mockClear();
    mockState.logger.info.mockClear();
    mockState.logger.warn.mockClear();
    mockState.logger.error.mockClear();
    mockState.recordXaiRateLimitSnapshot.mockClear();
  });

  afterEach(() => {
    delete process.env.XDT_CODEX_PROXY_DUMP_TRANSFORMED_BODY;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns loopback root endpoint when proxy is ready (proxy 按 model 拼上游 path)', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });

    await host.ensureCodexProxyReady();

    expect(host.getCodexProxyEndpoint()).toBe('http://127.0.0.1:43210');
    expect(mockState.createAnthropicCompatProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        // upstream 是函数形态(每请求现取,model-access 下发可运行期换 endpoint);
        // 断言其当前求值 = 网关 base + /v1
        upstream: expect.any(Function),
        // [encrypted activeStrip, image generation activeStrip, instructions 注入, provider-aware Guardian reviewer, Gateway 原生 web_search, 跨来源压缩块兼容, strict gateway history 兼容, xAI Responses 兼容, ByteDance Seed tool 兼容, MiniMax effort 兼容, provider model rewrite, stripNonAnthropicFields]
        transformRequest: [expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), mockState.stripNonAnthropicFields],
        routingTransform: expect.any(Function),
        recoveryRules: expect.arrayContaining([
          expect.objectContaining({ id: 'encrypted_content' }),
          expect.objectContaining({ id: 'image_generation_id' }),
        ]),
      }),
    );
    const proxyOpts = mockState.createAnthropicCompatProxy.mock.calls[0][0] as {
      upstream: () => string;
    };
    expect(proxyOpts.upstream()).toBe(`${XD_GATEWAY_BASE_URL}/v1`);
  });

  it('only resolves the websocket upstream for the oauth-bearer spawn identity', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const proxyOpts = mockState.createAnthropicCompatProxy.mock.calls[0][0] as {
      resolveWebSocketUpstream: (ctx: {
        url: string;
        headers: Readonly<Record<string, string>>;
      }) => string | null;
    };
    const ctx = { url: '/v1/responses', headers: {} };

    host.setCodexProxyAuthInjection('env-key');
    expect(proxyOpts.resolveWebSocketUpstream(ctx)).toBeNull();
    host.setCodexProxyAuthInjection('provider-oauth');
    expect(proxyOpts.resolveWebSocketUpstream(ctx)).toBeNull();
    host.setCodexProxyAuthInjection('oauth-bearer');
    expect(proxyOpts.resolveWebSocketUpstream(ctx)).toBe(
      'https://chatgpt.com/backend-api/codex',
    );
  });

  it('declines the next websocket upgrade after a body recovery error is armed', async () => {
    const host = await freshCodexProxyHost();
    const disconnectWebSocketsForThread = vi.fn(() => 2);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      disconnectWebSocketsForThread,
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');

    const proxyOpts = mockState.createAnthropicCompatProxy.mock.calls[0][0] as {
      resolveWebSocketUpstream: (ctx: {
        url: string;
        headers: Readonly<Record<string, string>>;
      }) => string | null;
    };
    const ctxForThread = (threadId: string) => ({
      url: '/v1/responses',
      headers: { 'thread-id': threadId },
    });

    expect(proxyOpts.resolveWebSocketUpstream(ctxForThread('thread-safe'))).toBe(
      'https://chatgpt.com/backend-api/codex',
    );
    expect(host.armCodexHttpRecovery({
      sessionId: 'session-encrypted',
      threadId: 'thread-encrypted',
      message: 'invalid_encrypted_content',
    })).toBe('encrypted_content');
    expect(host.armCodexHttpRecovery({
      sessionId: 'session-image',
      threadId: 'thread-image',
      message: 'Image generation items without `id` are not supported for this request.',
    })).toBe('image_generation_id');

    expect(proxyOpts.resolveWebSocketUpstream(ctxForThread('thread-encrypted'))).toBeNull();
    expect(proxyOpts.resolveWebSocketUpstream(ctxForThread('thread-image'))).toBeNull();
    expect(proxyOpts.resolveWebSocketUpstream(ctxForThread('thread-safe'))).toBe(
      'https://chatgpt.com/backend-api/codex',
    );
    expect(disconnectWebSocketsForThread).toHaveBeenCalledWith('thread-encrypted');
    expect(disconnectWebSocketsForThread).toHaveBeenCalledWith('thread-image');
  });

  it('keeps native websocket behavior when no scoped socket can be recovered safely', async () => {
    const host = await freshCodexProxyHost();
    const disconnectWebSocketsForThread = vi.fn(() => 0);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      disconnectWebSocketsForThread,
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');

    const proxyOpts = mockState.createAnthropicCompatProxy.mock.calls[0][0] as {
      resolveWebSocketUpstream: (ctx: {
        url: string;
        headers: Readonly<Record<string, string>>;
      }) => string | null;
    };
    const ctx = {
      url: '/v1/responses',
      headers: { 'thread-id': 'thread-unscoped' },
    };

    expect(host.armCodexHttpRecovery({
      sessionId: 'session-unscoped',
      threadId: 'thread-unscoped',
      message: 'invalid_encrypted_content',
    })).toBeNull();
    expect(disconnectWebSocketsForThread).toHaveBeenCalledWith('thread-unscoped');
    expect(proxyOpts.resolveWebSocketUpstream(ctx)).toBe(
      'https://chatgpt.com/backend-api/codex',
    );
  });

  it('arming recovery for a child thread preserves its parent and sibling routes', async () => {
    const host = await freshCodexProxyHost();
    const disconnectWebSocketsForThread = vi.fn(() => 2);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      disconnectWebSocketsForThread,
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');

    host.registerComposed('session-family', 'thread-parent', 'PRODUCT_PROMPT');
    expect(host.registerChildThread('thread-parent', 'thread-child')).toBe(true);
    expect(host.registerChildThread('thread-parent', 'thread-sibling')).toBe(true);

    expect(host.armCodexHttpRecovery({
      sessionId: 'session-family',
      threadId: 'thread-child',
      message: 'invalid_encrypted_content',
    })).toBe('encrypted_content');

    expect(mockState.capturedRegistry?.get('thread-parent')).toBe('PRODUCT_PROMPT');
    expect(mockState.capturedRegistry?.get('thread-child')).toBe('PRODUCT_PROMPT');
    expect(mockState.capturedRegistry?.get('thread-sibling')).toBe('PRODUCT_PROMPT');
    expect(disconnectWebSocketsForThread).toHaveBeenCalledWith('thread-child');

    host.unregister('session-family');
    expect(mockState.capturedRegistry?.get('thread-parent')).toBeUndefined();
    expect(mockState.capturedRegistry?.get('thread-child')).toBeUndefined();
    expect(mockState.capturedRegistry?.get('thread-sibling')).toBeUndefined();
  });

  it('clears the websocket recovery fallback when its session is unregistered', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      disconnectWebSocketsForThread: vi.fn(() => 1),
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');

    const proxyOpts = mockState.createAnthropicCompatProxy.mock.calls[0][0] as {
      resolveWebSocketUpstream: (ctx: {
        url: string;
        headers: Readonly<Record<string, string>>;
      }) => string | null;
    };
    const ctx = {
      url: '/v1/responses',
      headers: { 'thread-id': 'thread-recovery' },
    };
    expect(host.armCodexHttpRecovery({
      sessionId: 'session-recovery',
      threadId: 'thread-recovery',
      message: 'invalid_encrypted_content',
    })).toBe('encrypted_content');
    expect(proxyOpts.resolveWebSocketUpstream(ctx)).toBeNull();

    host.unregister('session-recovery');
    expect(proxyOpts.resolveWebSocketUpstream(ctx)).toBe(
      'https://chatgpt.com/backend-api/codex',
    );
  });

  it('falls back to direct gateway /v1 endpoint when proxy is not ready', async () => {
    const host = await freshCodexProxyHost();

    expect(host.getCodexProxyEndpoint()).toBe(`${XD_GATEWAY_BASE_URL}/v1`);
  });

  it('registers and unregisters composed prompt text by session id', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    host.registerComposed('session-1', 'thread-1', 'PRODUCT_PROMPT');
    expect(mockState.capturedRegistry?.get('thread-1')).toBe('PRODUCT_PROMPT');

    host.unregister('session-1');
    expect(mockState.capturedRegistry?.get('thread-1')).toBeUndefined();
  });

  it('routes Guardian reviewer models per parent session without crossing providers', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');

    host.registerReviewerRouteContext('session-xd-review', 'thread-xd-parent', 'deepseek/deepseek-v4');
    host.registerReviewerRouteContext('session-openai-review', 'thread-openai-parent', 'gpt-5.5');
    setSessionProvider('session-xd-review', 'xd');
    setSessionProvider('session-openai-review', 'openai');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    // active strips ×2, product prompt injection, then provider-aware Guardian rewrite.
    const reviewerTransform = transforms[3];
    if (!reviewerTransform) throw new Error('expected Guardian reviewer transform');
    const body = { model: 'codex-auto-review', input: [{ role: 'user', content: 'review' }] };
    const guardianHeaders = (parentThreadId: string) => ({
      'thread-id': `guardian-child-${parentThreadId}`,
      'x-openai-subagent': 'guardian',
      'x-codex-parent-thread-id': parentThreadId,
    });

    expect(reviewerTransform(body, {
      method: 'POST',
      url: '/responses',
      headers: guardianHeaders('thread-xd-parent'),
    })).toEqual({ ...body, model: 'deepseek/deepseek-v4' });
    expect(reviewerTransform(body, {
      method: 'POST',
      url: '/responses',
      headers: guardianHeaders('thread-openai-parent'),
    })).toBeNull();
    expect(reviewerTransform(body, {
      method: 'POST',
      url: '/responses',
      headers: {
        ...guardianHeaders('thread-xd-parent'),
        'x-openai-subagent': 'review',
      },
    })).toBeNull();
    expect(reviewerTransform(body, {
      method: 'POST',
      url: '/responses',
      headers: guardianHeaders('missing-parent'),
    })).toBeNull();

    host.registerReviewerRouteContext('session-xd-review', 'thread-xd-parent', 'qwen/qwen3-coder');
    expect(reviewerTransform(body, {
      method: 'POST',
      url: '/responses',
      headers: guardianHeaders('thread-xd-parent'),
    })).toEqual({ ...body, model: 'qwen/qwen3-coder' });

    host.unregister('session-xd-review');
    expect(reviewerTransform(body, {
      method: 'POST',
      url: '/responses',
      headers: guardianHeaders('thread-xd-parent'),
    })).toBeNull();

    clearSessionProvider('session-xd-review');
    clearSessionProvider('session-openai-review');
  });

  it('keeps Guardian transforms aligned with a control-plane proxy frozen auth mode', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    host.setCodexProxyAuthInjection('env-key');
    host.registerReviewerRouteContext(
      'session-frozen-review',
      'thread-frozen-parent',
      'unscoped-provider-model',
    );

    await host.ensureCodexControlPlaneProxyReady('oauth-bearer');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    const reviewerTransform = transforms[3];
    if (!reviewerTransform) throw new Error('expected Guardian reviewer transform');
    expect(reviewerTransform(
      { model: 'codex-auto-review', input: [] },
      {
        method: 'POST',
        url: '/responses',
        headers: {
          'thread-id': 'guardian-child-frozen',
          'x-openai-subagent': 'guardian',
          'x-codex-parent-thread-id': 'thread-frozen-parent',
        },
      },
    )).toBeNull();
  });

  it('keeps Gateway provider search tools out of Guardian review requests', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.setCodexProxyGatewayKeyReader(() => 'gw-key');
    host.registerReviewerRouteContext(
      'session-gateway-review',
      'thread-gateway-parent',
      'gpt-5.6-sol',
    );
    setSessionProvider('session-gateway-review', 'xd');

    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: {
        'thread-id': 'guardian-child-gateway',
        'x-openai-subagent': 'guardian',
        'x-codex-parent-thread-id': 'thread-gateway-parent',
      },
    };
    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'codex-auto-review',
      tools: [
        { type: 'function', name: 'shell' },
        { type: 'web_search' },
      ],
      input: [{ role: 'user', content: 'review this action' }],
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toMatchObject({
      model: 'gpt-5.6-sol',
      tools: [{ type: 'function', name: 'shell' }],
    });

    host.setCodexProxyGatewayKeyReader(() => null);
    clearSessionProvider('session-gateway-review');
  });

  it('applies provider compatibility and routing to a Guardian child via its parent thread', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    const { setProviderOAuthTokenReader } = await import('../provider-route.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.registerReviewerRouteContext('session-xai-review', 'thread-xai-parent', 'xai/grok-4.5');
    setSessionProvider('session-xai-review', 'xai');
    setProviderOAuthTokenReader((providerId) => (providerId === 'xai' ? 'xai-review-token' : null));

    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/responses',
      headers: {
        'thread-id': 'guardian-child-xai',
        'x-openai-subagent': 'guardian',
        'x-codex-parent-thread-id': 'thread-xai-parent',
      },
    };
    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    const rawGuardianBody = {
      model: 'codex-auto-review',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [
        { type: 'function', name: 'shell' },
        { type: 'namespace', name: 'multi_agent_v1', tools: [] },
        { type: 'web_search' },
        { type: 'x_search' },
      ],
      input: [{ role: 'user', content: 'review this action' }],
    };
    let current: unknown = rawGuardianBody;
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toMatchObject({ model: 'grok-4.5' });
    expect((current as { tools?: Array<{ type?: string; name?: string }> }).tools)
      .toEqual([{ type: 'function', name: 'shell' }]);

    const routingTransform = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.routingTransform;
    if (!routingTransform) throw new Error('expected routing transform');
    // The proxy chooses the route from the raw JSON before running request
    // transforms; routing must therefore resolve the same parent-aware model.
    await expect(Promise.resolve(routingTransform(rawGuardianBody, ctx))).resolves.toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
      headerOverride: { authorization: 'Bearer xai-review-token' },
      headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
    });

    clearSessionProvider('session-xai-review');
    setProviderOAuthTokenReader(() => null);
  });

  it('passes the parent session model into a Guardian request handled by the Chat bridge', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'guardian-chat-provider',
        name: 'Guardian Chat Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://chat-provider.example/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'chat-provider-key');
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.registerReviewerRouteContext(
      'session-chat-review',
      'thread-chat-parent',
      'deepseek-v4',
    );
    setSessionProvider('session-chat-review', 'guardian-chat-provider');

    const rawGuardianBody = {
      model: 'codex-auto-review',
      tools: [
        { type: 'function', name: 'shell' },
        { type: 'web_search' },
        { type: 'x_search' },
      ],
      input: [{ role: 'user', content: 'review this action' }],
    };
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/responses',
      headers: {
        'thread-id': 'guardian-child-chat',
        'x-openai-subagent': 'guardian',
        'x-codex-parent-thread-id': 'thread-chat-parent',
      },
    };
    const decision = await Promise.resolve(
      host.createModelRoutingTransform()(rawGuardianBody, ctx),
    );
    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    if (!decision?.localHandler) throw new Error('expected Chat bridge local handler');

    const res = {} as never;
    await decision.localHandler({
      rawBody: Buffer.from(JSON.stringify(rawGuardianBody)),
      parsedBody: rawGuardianBody,
      ctx,
      res,
    });
    const bridge = mockState.createResponsesChatHandler.mock.results.at(-1)?.value as
      | { handle: ReturnType<typeof vi.fn> }
      | undefined;
    expect(bridge?.handle).toHaveBeenCalledWith({
      parsedBody: {
        ...rawGuardianBody,
        model: 'deepseek-v4',
        tools: [{ type: 'function', name: 'shell' }],
      },
      res,
    });

    clearSessionProvider('session-chat-review');
    setCustomProviderKeyReader(() => null);
    setCustomProviders([]);
  });

  it('passes the parent session model into a Guardian request handled by the Anthropic bridge', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'guardian-anthropic-provider',
        name: 'Guardian Anthropic Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://anthropic-provider.example',
            wireProtocol: 'anthropic-messages',
            models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'anthropic-provider-key');
    host.setCodexProxyAuthInjection('env-key');
    host.registerReviewerRouteContext(
      'session-anthropic-review',
      'thread-anthropic-parent',
      'claude-sonnet-4-6',
    );
    setSessionProvider('session-anthropic-review', 'guardian-anthropic-provider');

    const rawGuardianBody = {
      model: 'codex-auto-review',
      tools: [
        { type: 'function', name: 'shell' },
        { type: 'web_search' },
        { type: 'x_search' },
      ],
      input: [{ role: 'user', content: 'review this action' }],
    };
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/responses',
      headers: {
        'thread-id': 'guardian-child-anthropic',
        'x-openai-subagent': 'guardian',
        'x-codex-parent-thread-id': 'thread-anthropic-parent',
      },
    };
    const decision = await Promise.resolve(
      host.createModelRoutingTransform()(rawGuardianBody, ctx),
    );
    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    if (!decision?.localHandler) throw new Error('expected Anthropic bridge local handler');

    const res = {} as never;
    await decision.localHandler({
      rawBody: Buffer.from(JSON.stringify(rawGuardianBody)),
      parsedBody: rawGuardianBody,
      ctx,
      res,
    });
    const bridge = mockState.createResponsesAnthropicHandler.mock.results.at(-1)?.value as
      | { handle: ReturnType<typeof vi.fn> }
      | undefined;
    expect(bridge?.handle).toHaveBeenCalledWith({
      parsedBody: {
        ...rawGuardianBody,
        model: 'claude-sonnet-4-6',
        tools: [{ type: 'function', name: 'shell' }],
      },
      ctx,
      res,
    });

    clearSessionProvider('session-anthropic-review');
    setCustomProviderKeyReader(() => null);
    setCustomProviders([]);
  });

  it('restores native web_search for Gateway GPT-5.6 when Codex omitted the declaration', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-gateway-search', 'thread-gateway-search', 'PRODUCT_PROMPT');
    setSessionProvider('session-gateway-search', 'xd');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'gpt-5.6-sol',
      tools: [{ type: 'function', name: 'read_file' }],
    };
    const ctx = { method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-gateway-search' } };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'gpt-5.6-sol',
      tools: [
        { type: 'function', name: 'read_file' },
        { type: 'web_search' },
      ],
    });

    // 未显式选择来源的 codex/ 模型仍由默认路由送往 Gateway。
    clearSessionProvider('session-gateway-search');
    current = { model: 'codex/gpt-5.6-sol' };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }
    expect(current).toEqual({
      model: 'codex/gpt-5.6-sol',
      tools: [{ type: 'web_search' }],
    });

    current = {
      model: 'codex/gpt-5.6-sol',
      tools: [{ type: 'web_search', external_web_access: false }],
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }
    expect(current).toEqual({
      model: 'codex/gpt-5.6-sol',
      tools: [{ type: 'web_search', external_web_access: false }],
    });
  });

  it('does not add Gateway native search to non-Gateway GPT-5.6 sessions', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-subscription-search', 'thread-subscription-search', 'PRODUCT_PROMPT');
    setSessionProvider('session-subscription-search', 'openai');
    host.setCodexProxyAuthInjection('oauth-bearer');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    const routingTransform = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.routingTransform;
    const original = { model: 'gpt-5.6-sol' };
    let current: unknown = original;
    const ctx = { method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-subscription-search' } };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual(original);
    await expect(Promise.resolve(routingTransform(current, ctx))).resolves.toEqual({
      upstreamOverride: 'https://chatgpt.com/backend-api/codex',
    });
    host.clearCodexProxyAuthInjection();
    clearSessionProvider('session-subscription-search');
  });

  it('does not add native search when an OAuth Gateway session resolves to passthrough', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-gateway-passthrough', 'thread-gateway-passthrough', 'PRODUCT_PROMPT');
    setSessionProvider('session-gateway-passthrough', 'xd');
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.setCodexProxyGatewayKeyReader(() => null);

    const proxyOptions = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0];
    const transforms = proxyOptions?.transformRequest ?? [];
    const routingTransform = proxyOptions?.routingTransform;
    const original = { model: 'gpt-5.6-sol' };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-gateway-passthrough' },
    };
    let transformed: unknown = original;
    for (const transform of transforms) {
      const next = transform(transformed, ctx);
      if (next !== null && next !== undefined) transformed = next;
    }

    expect(transformed).toEqual(original);
    expect(routingTransform(original, ctx)).toEqual({
      upstreamOverride: 'https://chatgpt.com/backend-api/codex',
    });

    host.clearCodexProxyAuthInjection();
    host.setCodexProxyGatewayKeyReader(() => null);
    clearSessionProvider('session-gateway-passthrough');
  });

  it('normalizes xAI Codex Responses body before forwarding requests', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xai', 'thread-xai', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai', 'xai');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'xai/grok-4.3',
      instructions: 'BASE_PROMPT\n\nPRODUCT_PROMPT',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [
        { type: 'function', name: 'read_file' },
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'close_agent' }] },
        { type: 'image_generation' },
        {
          type: 'web_search',
          external_web_access: true,
          index_gated_web_access: true,
          search_context_size: 'medium',
          user_location: { type: 'approximate', country: 'US' },
          filters: { allowed_domains: ['docs.x.ai'] },
          enable_image_search: true,
        },
      ],
      input: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAA' },
        { type: 'reasoning', id: 'rs_empty' },
        { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' },
        {
          type: 'custom_tool_call',
          id: 'ctc_1',
          status: 'completed',
          call_id: 'call_exec_1',
          name: 'exec',
          input: 'console.log(1)',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_exec_1',
          output: [
            { type: 'input_text', text: 'Script completed' },
            { type: 'input_text', text: 'ok' },
          ],
        },
        {
          type: 'function_call_output',
          call_id: 'call_wait_1',
          output: [{ type: 'input_text', text: '{"done":true}' }],
        },
        {
          type: 'function_call',
          call_id: 'call_invalid_args_1',
          name: 'legacy_tool',
          arguments: 'raw legacy input',
        },
        {
          type: 'function_call',
          call_id: 'call_valid_args_1',
          name: 'structured_tool',
          arguments: '{"path":"README.md"}',
        },
        { role: 'user', content: 'hello' },
      ],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-xai' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'grok-4.3',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [
        { type: 'function', name: 'read_file' },
        { type: 'web_search', filters: { allowed_domains: ['docs.x.ai'] }, enable_image_search: true },
        // Codex 不知道 xAI 还有 x_search;由 host 恒定补在末尾,Grok 才有 X 的实时视野。
        { type: 'x_search' },
      ],
      input: [
        { type: 'message', role: 'system', content: 'BASE_PROMPT\n\nPRODUCT_PROMPT' },
        // summary 恒定补齐(缺省 []):xAI 要求回放的 reasoning 始终带 summary,
        // 与 anthropic-responses-bridge 的回放形状同口径。
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAA' },
        {
          type: 'function_call',
          id: 'ctc_1',
          name: 'exec',
          arguments: '{"input":"console.log(1)"}',
          call_id: 'call_exec_1',
        },
        {
          type: 'function_call_output',
          call_id: 'call_exec_1',
          output: 'Script completed\nok',
        },
        {
          type: 'function_call_output',
          call_id: 'call_wait_1',
          output: '{"done":true}',
        },
        {
          type: 'function_call',
          call_id: 'call_invalid_args_1',
          name: 'legacy_tool',
          arguments: '{"input":"raw legacy input"}',
        },
        {
          type: 'function_call',
          call_id: 'call_valid_args_1',
          name: 'structured_tool',
          arguments: '{"path":"README.md"}',
        },
        { type: 'message', role: 'user', content: 'hello' },
      ],
    });
    clearSessionProvider('session-xai');
  });

  describe('xAI 服务端搜索工具(x_search)注入', () => {
    async function runXaiTransforms(sessionSuffix: string, body: Record<string, unknown>): Promise<unknown> {
      const host = await freshCodexProxyHost();
      const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
      mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
        url: 'http://127.0.0.1:43210',
        dispose: vi.fn(async () => undefined),
      });
      await host.ensureCodexProxyReady();
      const sessionId = `session-xsearch-${sessionSuffix}`;
      const threadId = `thread-xsearch-${sessionSuffix}`;
      host.registerComposed(sessionId, threadId, 'PRODUCT_PROMPT');
      setSessionProvider(sessionId, 'xai');

      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      const ctx = { method: 'POST', url: '/responses', headers: { 'thread-id': threadId } };
      let current: unknown = body;
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }
      clearSessionProvider(sessionId);
      return current;
    }

    it('请求原本没有 tools 时也补上 x_search(Grok 默认就该能搜 X)', async () => {
      const out = (await runXaiTransforms('no-tools', {
        model: 'xai/grok-4.5',
        input: [{ role: 'user', content: 'X 上今天 AI 圈在聊什么' }],
      })) as Record<string, unknown>;

      expect(out.tools).toEqual([{ type: 'x_search' }]);
    });

    it('上游已声明 x_search 时不重复注入,也不覆盖其参数', async () => {
      const out = (await runXaiTransforms('already-declared', {
        model: 'xai/grok-4.5',
        tools: [{ type: 'x_search', from_date: '2026-07-01', to_date: '2026-07-28' }],
        input: [{ role: 'user', content: 'hi' }],
      })) as Record<string, unknown>;

      expect(out.tools).toEqual([{ type: 'x_search', from_date: '2026-07-01', to_date: '2026-07-28' }]);
    });

    it('tool_choice:required + 唯一 function tool → 收窄成指名该 function,x_search 仍照常声明', async () => {
      // required 作用于整个 tools 数组,附加 x_search 后模型可能用搜索顶替被强制的 function
      // call。与 bridge 侧同口径:收窄 tool_choice,不摘工具声明(摘了会让前缀中途变动)。
      const out = (await runXaiTransforms('forced-single', {
        model: 'xai/grok-4.5',
        tools: [{ type: 'function', name: 'read_file' }],
        tool_choice: 'required',
        input: [{ role: 'user', content: 'hi' }],
      })) as Record<string, unknown>;

      expect(out.tool_choice).toEqual({ type: 'function', name: 'read_file' });
      expect(out.tools).toEqual([{ type: 'function', name: 'read_file' }, { type: 'x_search' }]);
    });

    it('tool_choice:required + 多个 function tool → 保留 required(Responses 无法表达子集限定)', async () => {
      const out = (await runXaiTransforms('forced-multi', {
        model: 'xai/grok-4.5',
        tools: [
          { type: 'function', name: 'read_file' },
          { type: 'function', name: 'write_file' },
        ],
        tool_choice: 'required',
        input: [{ role: 'user', content: 'hi' }],
      })) as Record<string, unknown>;

      expect(out.tool_choice).toBe('required');
      expect(out.tools).toEqual([
        { type: 'function', name: 'read_file' },
        { type: 'function', name: 'write_file' },
        { type: 'x_search' },
      ]);
    });

    it('tool_choice:auto 不被改写', async () => {
      const out = (await runXaiTransforms('auto-choice', {
        model: 'xai/grok-4.5',
        tools: [{ type: 'function', name: 'read_file' }],
        tool_choice: 'auto',
        input: [{ role: 'user', content: 'hi' }],
      })) as Record<string, unknown>;

      expect(out.tool_choice).toBe('auto');
    });

    it.each(['xai/grok-code-fast', 'xai/grok-build-preview'])(
      '编码模型 %s 不注入(该系列没有 agentic 搜索工具面,带上会被上游拒)',
      async (model) => {
        const out = (await runXaiTransforms(`coding-${model}`, {
          model,
          tools: [{ type: 'function', name: 'read_file' }],
          input: [{ role: 'user', content: 'hi' }],
        })) as Record<string, unknown>;

        expect(out.tools).toEqual([{ type: 'function', name: 'read_file' }]);
      },
    );
  });

  // codex 的结构体会把自己没用上的 Option 字段一并序列化(实测 `content: null`),
  // 那是 xAI 从没发过的键;带着它回放,上游判定「blob 被改过」→ 整轮 400
  // "Could not decode the compaction blob. Ensure it is unmodified from the compact response."
  // (2026-08-02 实测:新会话里首个把 reasoning 回放进 input[] 的请求必挂,重试同样挂。)
  describe('xAI 加密 reasoning 回放形状', () => {
    async function runXaiReasoningTransforms(
      suffix: string,
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const host = await freshCodexProxyHost();
      const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
      mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
        url: 'http://127.0.0.1:43210',
        dispose: vi.fn(async () => undefined),
      });
      await host.ensureCodexProxyReady();
      const sessionId = `session-reasoning-shape-${suffix}`;
      const threadId = `thread-reasoning-shape-${suffix}`;
      host.registerComposed(sessionId, threadId, 'PRODUCT_PROMPT');
      setSessionProvider(sessionId, 'xai');

      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      const ctx = { method: 'POST', url: '/responses', headers: { 'thread-id': threadId } };
      let current: unknown = body;
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }
      clearSessionProvider(sessionId);
      return current as Record<string, unknown>;
    }

    const reasoningItemFrom = (input: unknown[]): Record<string, unknown> =>
      input.find(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'reasoning',
      ) ?? {};

    it('剥掉 codex 多序列化出来的键，只留 Responses 契约里的四个', async () => {
      const out = await runXaiReasoningTransforms('strips-extra-keys', {
        model: 'xai/grok-4.5',
        input: [
          {
            type: 'reasoning',
            id: 'rs_keep_me',
            summary: [{ type: 'summary_text', text: 'thinking' }],
            // codex 实际发出来的形态:自己没用上的 Option 字段照样序列化。
            content: null,
            internal_chat_message_metadata_passthrough: { turn_id: 't1' },
            encrypted_content: 'BLOB-KEEP',
          },
        ],
      });

      const reasoning = reasoningItemFrom(out.input as unknown[]);
      expect(Object.keys(reasoning).sort()).toEqual(['encrypted_content', 'id', 'summary', 'type']);
      // blob 必须逐字不动 —— 改一个字节上游就解不开。
      expect(reasoning.encrypted_content).toBe('BLOB-KEEP');
      expect(reasoning.summary).toEqual([{ type: 'summary_text', text: 'thinking' }]);
      expect(reasoning.id).toBe('rs_keep_me');
    });

    // 键名都在允许列表里、但 id 的值是空串:只数键名会判定「没变」,把原对象原样
    // 发出去 —— 等于算出了规范形状又扔掉。
    it('id 是空串时也要真的剥掉，而不是当作“没变”原样透传', async () => {
      const out = await runXaiReasoningTransforms('empty-id', {
        model: 'xai/grok-4.5',
        input: [{ type: 'reasoning', id: '', summary: [], encrypted_content: 'BLOB-EMPTY-ID' }],
      });

      const reasoning = reasoningItemFrom(out.input as unknown[]);
      expect(Object.keys(reasoning).sort()).toEqual(['encrypted_content', 'summary', 'type']);
      expect(reasoning.encrypted_content).toBe('BLOB-EMPTY-ID');
    });

    it('codex 不发 id 时不编造一个（实测 xAI 不需要 id 也能解开 blob）', async () => {
      const out = await runXaiReasoningTransforms('no-id', {
        model: 'xai/grok-4.5',
        input: [{ type: 'reasoning', summary: [], content: null, encrypted_content: 'BLOB-NO-ID' }],
      });

      const reasoning = reasoningItemFrom(out.input as unknown[]);
      expect(Object.keys(reasoning).sort()).toEqual(['encrypted_content', 'summary', 'type']);
      expect(reasoning.encrypted_content).toBe('BLOB-NO-ID');
    });
  });

  // OpenAI/Codex collab 历史里的 agent_message 不是 xAI ModelInput 变体；跨源 resume
  // 到 grok 时原样转发 → 422 "data did not match any variant of untagged enum ModelInput"。
  // (2026-08-03 实测: gpt-5.6-sol collab 会话切 xai/grok-4.5 必挂;新建 grok 会话正常。)
  describe('xAI collab agent_message 跨源回放', () => {
    async function runXaiInputTransforms(
      suffix: string,
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const host = await freshCodexProxyHost();
      const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
      mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
        url: 'http://127.0.0.1:43210',
        dispose: vi.fn(async () => undefined),
      });
      await host.ensureCodexProxyReady();
      const sessionId = `session-agent-message-${suffix}`;
      const threadId = `thread-agent-message-${suffix}`;
      host.registerComposed(sessionId, threadId, 'PRODUCT_PROMPT');
      setSessionProvider(sessionId, 'xai');

      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      const ctx = { method: 'POST', url: '/responses', headers: { 'thread-id': threadId } };
      let current: unknown = body;
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }
      clearSessionProvider(sessionId);
      return current as Record<string, unknown>;
    }

    it('把 agent_message 降级成 assistant message，丢掉 content 里的 encrypted_content', async () => {
      const out = await runXaiInputTransforms('collab-to-message', {
        model: 'xai/grok-4.5',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
          {
            type: 'agent_message',
            author: '/root/official_pr_rules',
            recipient: '/root',
            content: [
              {
                type: 'input_text',
                text: 'Message Type: FINAL_ANSWER\nTask name: /root\nPayload:\n已完成只读审查',
              },
              { type: 'encrypted_content', encrypted_content: 'gAAAAA-openai-collab-blob' },
            ],
            internal_chat_message_metadata_passthrough: { turn_id: 't1' },
          },
        ],
      });

      const input = out.input as Array<Record<string, unknown>>;
      expect(input).toHaveLength(2);
      expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
      expect(input[1]).toEqual({
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text:
              '[collab /root/official_pr_rules]\n'
              + 'Message Type: FINAL_ANSWER\nTask name: /root\nPayload:\n已完成只读审查',
          },
        ],
      });
      // 不得残留 collab 专有键或 OpenAI 密文 part。
      expect(JSON.stringify(input[1])).not.toContain('agent_message');
      expect(JSON.stringify(input[1])).not.toContain('encrypted_content');
      expect(JSON.stringify(input[1])).not.toContain('gAAAAA-openai-collab-blob');
    });

    it('未知 input type 直接丢掉，不原样透传给 xAI', async () => {
      const out = await runXaiInputTransforms('drop-unknown', {
        model: 'xai/grok-4.5',
        input: [
          { type: 'message', role: 'user', content: 'hi' },
          { type: 'web_search_end', call_id: 'c1', query: 'x' },
          { type: 'mcp_tool_call_end', call_id: 'c2' },
        ],
      });

      const input = out.input as Array<Record<string, unknown>>;
      expect(input).toHaveLength(1);
      expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
    });
  });

  it('leaves custom_tool_call history untouched for non-xAI requests', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-openai-custom-tool', 'thread-openai-custom-tool', 'PRODUCT_PROMPT');
    setSessionProvider('session-openai-custom-tool', 'openai');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    const originalInput = [
      {
        type: 'custom_tool_call',
        id: 'ctc_1',
        status: 'completed',
        call_id: 'call_exec_1',
        name: 'exec',
        input: 'console.log(1)',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_exec_1',
        output: [{ type: 'input_text', text: 'ok' }],
      },
      { role: 'user', content: 'hello' },
    ];
    let current: unknown = {
      model: 'gpt-5.4',
      input: originalInput,
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-openai-custom-tool' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'gpt-5.4',
      input: originalInput,
    });
    clearSessionProvider('session-openai-custom-tool');
  });

  it.each([
    'moonshotai/kimi-k3',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
  ])('normalizes strict gateway history for model %s', async (model) => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model,
      input: [
        { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pwd"}' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '我先检查项目目录。' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '' }],
        },
        { type: 'function_call', name: 'exec_command', call_id: 'call_2', arguments: '{"cmd":"git status"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '/repo' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '接着检查工作区。' }],
        },
        { type: 'function_call_output', call_id: 'call_2', output: 'clean' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      ],
    };
    const ctx = { method: 'POST', url: '/responses', headers: {} };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model,
      input: [
        { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '/repo' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '我先检查项目目录。' }],
        },
        { type: 'function_call', name: 'exec_command', call_id: 'call_2', arguments: '{"cmd":"git status"}' },
        { type: 'function_call_output', call_id: 'call_2', output: 'clean' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '接着检查工作区。' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      ],
    });
  });

  it('keeps parallel strict-gateway tool calls grouped before their matched outputs', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'moonshotai/kimi-k3',
      parallel_tool_calls: true,
      input: [
        { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call', name: 'exec_command', call_id: 'call_2', arguments: '{"cmd":"git status"}' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '两个命令都在执行。' }],
        },
        { type: 'function_call_output', call_id: 'call_1', output: '/repo' },
        { type: 'function_call_output', call_id: 'call_2', output: 'clean' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      ],
    };
    const ctx = { method: 'POST', url: '/responses', headers: {} };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'moonshotai/kimi-k3',
      parallel_tool_calls: true,
      input: [
        { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call', name: 'exec_command', call_id: 'call_2', arguments: '{"cmd":"git status"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '/repo' },
        { type: 'function_call_output', call_id: 'call_2', output: 'clean' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '两个命令都在执行。' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      ],
    });
  });

  it('keeps interleaved tool history unchanged for non-strict gateway models', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    const input = [
      { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pwd"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call_output', call_id: 'call_1', output: '/repo' },
    ];
    const original = { model: 'qwen/qwen3.7-max', input };
    let current: unknown = original;
    const ctx = { method: 'POST', url: '/responses', headers: {} };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual(original);
  });

  it('normalizes requests to ByteDance Seed Responses capabilities', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-seed', 'thread-seed', 'PRODUCT_PROMPT');
    setSessionProvider('session-seed', 'xd');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'bytedance-seed/seed-2.1-pro',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'function', name: 'write_stdin' },
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'close_agent' }] },
        { type: 'web_search', external_web_access: true },
        { type: 'image_generation' },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'earlier answer' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '' },
            { type: 'output_text', text: 'non-empty remainder' },
          ],
        },
        { type: 'reasoning', summary: [], content: null },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-seed' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'bytedance-seed/seed-2.1-pro',
      reasoning: { effort: 'high' },
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'function', name: 'write_stdin' },
        { type: 'web_search' },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      input: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'earlier answer' }],
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'non-empty remainder' }],
        },
        { type: 'reasoning', summary: [], content: null },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    });

    let summaryOnlyReasoning: unknown = {
      model: 'bytedance-seed/seed-2.1-pro',
      reasoning: { summary: 'auto' },
    };
    for (const transform of transforms) {
      const next = transform(summaryOnlyReasoning, ctx);
      if (next !== null && next !== undefined) summaryOnlyReasoning = next;
    }
    expect(summaryOnlyReasoning).toEqual({ model: 'bytedance-seed/seed-2.1-pro' });

    clearSessionProvider('session-seed');
  });

  it('normalizes custom Volcengine Ark Responses routes regardless of the model alias', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'custom-volcengine',
        name: 'Custom Volcengine',
        runtimes: {
          codex: {
            baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            models: [{ id: 'production-deployment', name: 'Production Deployment' }],
          },
        },
      }),
    ]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-custom-volcengine', 'thread-custom-volcengine', 'PRODUCT_PROMPT');
    setSessionProvider('session-custom-volcengine', 'custom-volcengine');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'production-deployment',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'namespace', name: 'mcp__example', tools: [{ type: 'function', name: 'read' }] },
        { type: 'web_search', external_web_access: true },
      ],
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'earlier' }] },
      ],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-custom-volcengine' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'production-deployment',
      reasoning: { effort: 'high' },
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'web_search' },
      ],
      input: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'earlier' }],
        },
      ],
    });

    clearSessionProvider('session-custom-volcengine');
    setCustomProviders([]);
  });

  it('does not apply the Seed fallback to non-Ark Volces Responses routes', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'custom-volces',
        name: 'Custom Volces',
        runtimes: {
          codex: {
            baseUrl: 'https://gateway.volces.com/api/v3',
            models: [{ id: 'production-deployment', name: 'Production Deployment' }],
          },
        },
      }),
    ]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-custom-volces', 'thread-custom-volces', 'PRODUCT_PROMPT');
    setSessionProvider('session-custom-volces', 'custom-volces');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    const original = {
      model: 'production-deployment',
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'namespace', name: 'mcp__example', tools: [{ type: 'function', name: 'read' }] },
        { type: 'web_search', external_web_access: true },
      ],
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'earlier' }] },
      ],
    };
    let current: unknown = original;
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-custom-volces' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual(original);

    clearSessionProvider('session-custom-volces');
    setCustomProviders([]);
  });

  it('recognizes Volcengine native doubao Seed model IDs without route metadata', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'doubao-seed-2-1-pro-260628',
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'namespace', name: 'mcp__example', tools: [{ type: 'function', name: 'read' }] },
      ],
      input: 'hello',
    };
    const ctx = { method: 'POST', url: '/responses', headers: {} };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'doubao-seed-2-1-pro-260628',
      tools: [{ type: 'function', name: 'exec_command' }],
      input: 'hello',
    });
  });

  it('removes Seed tool controls when every declared tool is unsupported', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'bytedance-seed/seed-2.1-pro',
      tools: [{ type: 'namespace', name: 'multi_agent_v1', tools: [] }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      input: 'hello',
    };
    const ctx = { method: 'POST', url: '/responses', headers: {} };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'bytedance-seed/seed-2.1-pro',
      input: 'hello',
    });
  });

  it('drops Seed web search when Codex explicitly disables live web access', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'bytedance-seed/seed-2.1-pro',
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'web_search', external_web_access: false },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      input: 'hello',
    };
    const ctx = { method: 'POST', url: '/responses', headers: {} };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'bytedance-seed/seed-2.1-pro',
      tools: [{ type: 'function', name: 'exec_command' }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      input: 'hello',
    });
  });

  it('resets a Seed tool choice that references a filtered tool', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'bytedance-seed/seed-2.1-pro',
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'image_generation' },
      ],
      tool_choice: { type: 'image_generation' },
      parallel_tool_calls: false,
      input: 'hello',
    };
    const ctx = { method: 'POST', url: '/responses', headers: {} };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'bytedance-seed/seed-2.1-pro',
      tools: [{ type: 'function', name: 'exec_command' }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      input: 'hello',
    });
  });

  it('keeps a Seed tool choice that references a retained function', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'bytedance-seed/seed-2.1-pro',
      tools: [
        { type: 'function', name: 'exec_command' },
        { type: 'namespace', name: 'multi_agent_v1', tools: [] },
      ],
      tool_choice: { type: 'function', name: 'exec_command' },
      parallel_tool_calls: false,
      input: 'hello',
    };
    const ctx = { method: 'POST', url: '/responses', headers: {} };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'bytedance-seed/seed-2.1-pro',
      tools: [{ type: 'function', name: 'exec_command' }],
      tool_choice: { type: 'function', name: 'exec_command' },
      parallel_tool_calls: false,
      input: 'hello',
    });
  });

  it('keeps Codex namespace tools for non-xAI requests', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-openai', 'thread-openai', 'PRODUCT_PROMPT');
    setSessionProvider('session-openai', 'openai');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'gpt-5.4',
      tools: [
        { type: 'function', name: 'read_file' },
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'close_agent' }] },
        { type: 'image_generation' },
        { type: 'web_search', external_web_access: true, search_context_size: 'medium' },
      ],
      input: [
        { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' },
        { role: 'user', content: 'hello' },
      ],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-openai' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'gpt-5.4',
      tools: [
        { type: 'function', name: 'read_file' },
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'close_agent' }] },
        { type: 'image_generation' },
        { type: 'web_search', external_web_access: true, search_context_size: 'medium' },
      ],
      input: [
        { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' },
        { role: 'user', content: 'hello' },
      ],
    });
    clearSessionProvider('session-openai');
  });

  it.each([
    'https://api.minimaxi.com/v1',
    'https://api.minimax.io/v1/',
  ])('clamps MiniMax Responses xhigh effort to high for %s', async (baseUrl) => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'renamed-minimax',
        name: 'My MiniMax',
        runtimes: {
          codex: {
            baseUrl,
            models: [{ id: 'MiniMax-M3', name: 'MiniMax M3' }],
          },
        },
      }),
    ]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-minimax', 'thread-minimax', 'PRODUCT_PROMPT');
    setSessionProvider('session-minimax', 'renamed-minimax');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'MiniMax-M3',
      reasoning: { effort: 'xhigh', summary: 'auto' },
      input: [{ role: 'user', content: 'hello' }],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-minimax' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'MiniMax-M3',
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: 'hello' }],
    });

    let supportedEffort: unknown = {
      model: 'MiniMax-M3',
      reasoning: { effort: 'high', summary: 'auto' },
      input: [{ role: 'user', content: 'hello' }],
    };
    for (const transform of transforms) {
      const next = transform(supportedEffort, ctx);
      if (next !== null && next !== undefined) supportedEffort = next;
    }
    expect(supportedEffort).toEqual({
      model: 'MiniMax-M3',
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: 'hello' }],
    });
    clearSessionProvider('session-minimax');
    setCustomProviders([]);
  });

  it('keeps xhigh effort for non-MiniMax custom Responses providers', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'custom-responses',
        name: 'Custom Responses',
        runtimes: {
          codex: {
            baseUrl: 'https://example.com/v1',
            models: [{ id: 'custom-model', name: 'Custom Model' }],
          },
        },
      }),
    ]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-custom', 'thread-custom', 'PRODUCT_PROMPT');
    setSessionProvider('session-custom', 'custom-responses');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    const original = {
      model: 'custom-model',
      reasoning: { effort: 'xhigh', summary: 'auto' },
      input: [{ role: 'user', content: 'hello' }],
    };
    let current: unknown = original;
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-custom' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual(original);
    clearSessionProvider('session-custom');
    setCustomProviders([]);
  });

  it('strips reasoning for xAI Codex models that do not support reasoning', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xai-fast', 'thread-xai-fast', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai-fast', 'xai');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'xai/grok-code-fast',
      instructions: 'BASE_PROMPT\n\nPRODUCT_PROMPT',
      reasoning: { effort: 'high', summary: 'auto' },
      input: [
        { type: 'reasoning', encrypted_content: 'gAAA' },
        { role: 'user', content: 'hello' },
      ],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-xai-fast' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'grok-code-fast',
      input: [
        { type: 'message', role: 'system', content: 'BASE_PROMPT\n\nPRODUCT_PROMPT' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
    });
    clearSessionProvider('session-xai-fast');
  });

  it('conservatively strips reasoning for unknown xAI Codex models', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xai-unknown', 'thread-xai-unknown', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai-unknown', 'xai');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'xai/grok-future',
      instructions: 'BASE_PROMPT\n\nPRODUCT_PROMPT',
      reasoning: { effort: 'high', summary: 'auto' },
      input: [
        { type: 'reasoning', encrypted_content: 'gAAA' },
        { role: 'user', content: 'hello' },
      ],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-xai-unknown' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'grok-future',
      // reasoning 对未知模型保守剥掉(目录查不到能力),但 x_search 反过来按黑名单放行:
      // 只排除 grok-code / grok-build,未知的新 Grok 通用模型默认当作能搜 X —— 否则每出一个
      // 新模型都要等目录更新才恢复搜 X,而搜 X 正是选 Grok 的主要理由。
      tools: [{ type: 'x_search' }],
      input: [
        { type: 'message', role: 'system', content: 'BASE_PROMPT\n\nPRODUCT_PROMPT' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
    });
    clearSessionProvider('session-xai-unknown');
  });

  it('normalizes implicit-source xAI Codex requests before forwarding', async () => {
    const host = await freshCodexProxyHost();
    const { clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xai-implicit', 'thread-xai-implicit', 'PRODUCT_PROMPT');
    clearSessionProvider('session-xai-implicit');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'xai/grok-code-fast',
      instructions: 'BASE_PROMPT\n\nPRODUCT_PROMPT',
      reasoning: { effort: 'high', summary: 'auto' },
      input: [
        { type: 'reasoning', encrypted_content: 'gAAA' },
        { role: 'user', content: 'hello' },
      ],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-xai-implicit' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    expect(current).toEqual({
      model: 'grok-code-fast',
      input: [
        { type: 'message', role: 'system', content: 'BASE_PROMPT\n\nPRODUCT_PROMPT' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
    });
  });

  it('leaves non-xai/ bodies untouched in explicit xAI sessions (transform 与路由 scope 门同源, #890 review)', async () => {
    // xai 会话里非 xai/ 前缀的请求会被路由 scope 门放回默认上游(ChatGPT/网关),
    // xAI 兼容改写(挪 instructions / 剥 reasoning)必须同步跳过,否则默认上游收到被改坏的 body。
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xai-foreign', 'thread-xai-foreign', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai-foreign', 'xai');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    const original = {
      model: 'gpt-5.5',
      instructions: 'BASE_PROMPT',
      reasoning: { effort: 'high', summary: 'auto' },
      input: [{ role: 'user', content: 'hello' }],
    };
    let current: unknown = original;
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-xai-foreign' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    // instructions 未被挪进 input、reasoning 未被剥、model 未被 rewrite。
    expect(current).toEqual(original);
    clearSessionProvider('session-xai-foreign');
  });

  it('restores native search when provider-oauth foreign-model fallback lands on Gateway', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xai-search-fallback', 'thread-xai-search-fallback', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai-search-fallback', 'xai');
    host.setCodexProxyAuthInjection('provider-oauth');
    host.setCodexProxyGatewayKeyReader(() => 'gw-key');

    const proxyOptions = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0];
    const transforms = proxyOptions?.transformRequest ?? [];
    const routingTransform = proxyOptions?.routingTransform;
    const current: Record<string, unknown> = { model: 'gpt-5.6-sol' };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-xai-search-fallback' },
    };
    let transformed: unknown = current;
    for (const transform of transforms) {
      const next = transform(transformed, ctx);
      if (next !== null && next !== undefined) transformed = next;
    }

    expect(transformed).toEqual({
      model: 'gpt-5.6-sol',
      tools: [{ type: 'web_search' }],
    });
    expect(routingTransform(current, ctx)).toEqual({
      headerOverride: { authorization: 'Bearer gw-key' },
    });

    host.clearCodexProxyAuthInjection();
    host.setCodexProxyGatewayKeyReader(() => null);
    clearSessionProvider('session-xai-search-fallback');
  });

  it('dumps transformed request bodies when the debug env gate is enabled', async () => {
    process.env.XDT_CODEX_PROXY_DUMP_TRANSFORMED_BODY = '1';
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    const injectedBody = {
      instructions: 'base\n\nPRODUCT_PROMPT',
      output_config: { type: 'json' },
      input: [{ role: 'developer', content: 'codex scaffolding' }],
    };
    const transformedBody = {
      instructions: 'base\n\nPRODUCT_PROMPT',
      input: [{ role: 'developer', content: 'codex scaffolding' }],
    };
    mockState.injectionTransform.mockReturnValueOnce(injectedBody);
    mockState.stripNonAnthropicFields.mockReturnValueOnce(transformedBody);

    await host.ensureCodexProxyReady();

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    expect(transforms).toHaveLength(13); // encrypted activeStrip, image generation activeStrip, instructions 注入, provider-aware Guardian reviewer, Gateway 原生 web_search, 跨来源压缩块兼容, strict gateway history 兼容, xAI Responses 兼容, ByteDance Seed tool 兼容, MiniMax effort 兼容, provider model rewrite, stripNonAnthropicFields, dump
    const ctx = {
      method: 'POST',
      url: '/v1/responses',
      headers: { 'Thread-ID': 'thread-1' },
    };
    let current: unknown = { instructions: 'base' };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }
    expect(current).toBe(transformedBody);

    const dumpDir = path.join(tempDir, 'codex-proxy-dumps');
    const files = fs.readdirSync(dumpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^thread-1-\d+\.json$/);

    const dump = JSON.parse(fs.readFileSync(path.join(dumpDir, files[0]), 'utf8'));
    expect(dump).toMatchObject({
      threadId: 'thread-1',
      method: 'POST',
      url: '/v1/responses',
      body: transformedBody,
    });
  });

  it('observes non-streaming provider service_tier from upstream responses', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-1', 'thread-1', 'PRODUCT_PROMPT');

    const observer = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.responseObserver;
    expect(observer).toEqual(expect.any(Function));
    const sink = observer({
      reqId: 7,
      method: 'POST',
      url: '/v1/responses',
      upstreamBase: 'https://api.openai.com/v1',
      status: 200,
      requestHeaders: { 'thread-id': 'thread-1' },
      responseHeaders: { 'content-type': 'application/json' },
      requestBody: Buffer.from(JSON.stringify({
        model: 'gpt-5.5',
        service_tier: 'priority',
      })),
    });
    sink?.onData?.(Buffer.from(JSON.stringify({
      id: 'resp_123',
      model: 'gpt-5.5',
      service_tier: 'priority',
    })));
    sink?.onEnd?.();

    expect(mockState.logger.info).toHaveBeenCalledWith(expect.stringContaining('codex provider service tier observed'));
    const line = String(mockState.logger.info.mock.calls.at(-1)?.[0] ?? '');
    expect(line).toMatch(/requestServiceTier\s+:\s+priority/);
    expect(line).toMatch(/upstreamServiceTier\s+:\s+priority/);
    expect(line).toMatch(/responseId\s+:\s+resp_123/);
    expect(line).toMatch(/sessionId\s+:\s+session-1/);
  });

  it('records xAI rate-limit headers from Codex proxy upstream responses', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const observer = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.responseObserver;
    expect(observer).toEqual(expect.any(Function));
    observer({
      reqId: 9,
      method: 'POST',
      url: '/responses',
      upstreamBase: 'https://api.x.ai/v1',
      status: 200,
      requestHeaders: { 'thread-id': 'thread-xai' },
      responseHeaders: {
        'content-type': 'application/json',
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '88',
        'x-ratelimit-limit-tokens': '1000000',
        'x-ratelimit-remaining-tokens': '900000',
      },
      requestBody: Buffer.from(JSON.stringify({ model: 'grok-4.3' })),
    });

    expect(mockState.recordXaiRateLimitSnapshot).toHaveBeenCalledWith({
      limitRequests: 100,
      remainingRequests: 88,
      limitTokens: 1000000,
      remainingTokens: 900000,
    });
  });

  it('observes streaming provider service_tier from response.completed SSE', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();

    const observer = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.responseObserver;
    expect(observer).toEqual(expect.any(Function));
    const sink = observer({
      reqId: 8,
      method: 'POST',
      url: '/responses',
      upstreamBase: 'https://api.openai.com/v1',
      status: 200,
      requestHeaders: { 'thread-id': 'thread-stream' },
      responseHeaders: { 'content-type': 'text/event-stream' },
      requestBody: Buffer.from(JSON.stringify({
        model: 'gpt-5.5',
        service_tier: 'priority',
        stream: true,
      })),
    });
    sink?.onData?.(Buffer.from([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_created"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_done","model":"gpt-5.5","service_tier":"default"}}',
      '',
    ].join('\n')));
    sink?.onEnd?.();

    expect(mockState.logger.info).toHaveBeenCalledWith(expect.stringContaining('codex provider service tier observed'));
    const line = String(mockState.logger.info.mock.calls.at(-1)?.[0] ?? '');
    expect(line).toMatch(/requestServiceTier\s+:\s+priority/);
    expect(line).toMatch(/upstreamServiceTier\s+:\s+default/);
    expect(line).toMatch(/responseId\s+:\s+resp_done/);
  });

  it('clears registered prompts and disposes proxy handle on dispose', async () => {
    const dispose = vi.fn(async () => undefined);
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose,
    });
    await host.ensureCodexProxyReady();

    host.registerComposed('session-1', 'thread-1', 'PRODUCT_PROMPT');

    await host.disposeCodexProxy();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockState.capturedRegistry?.get('thread-1')).toBeUndefined();
  });

  it('reports handle readiness for the spawn active decision', async () => {
    const host = await freshCodexProxyHost();
    expect(host.isCodexProxyHandleReady()).toBe(false);

    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    expect(host.isCodexProxyHandleReady()).toBe(true);
  });

  it('keeps handle not-ready when proxy fails to start (degrade safety, no naked)', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockRejectedValueOnce(new Error('port in use'));

    await host.ensureCodexProxyReady();

    // proxy 起不来 → handle 不就绪 → spawn 据此 setActive(false) → maker-core 发 dev,不裸奔
    expect(host.isCodexProxyHandleReady()).toBe(false);
  });

  it('deduplicates concurrent proxy startup calls', async () => {
    const host = await freshCodexProxyHost();
    let resolveStart!: (value: { url: string; dispose: () => Promise<void> }) => void;
    mockState.createAnthropicCompatProxy.mockReturnValueOnce(new Promise((resolve) => {
      resolveStart = resolve;
    }));

    const first = host.ensureCodexProxyReady();
    const second = host.ensureCodexProxyReady();
    expect(mockState.createAnthropicCompatProxy).toHaveBeenCalledTimes(1);

    resolveStart({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await Promise.all([first, second]);

    expect(host.getCodexProxyEndpoint()).toBe('http://127.0.0.1:43210');
  });
});
