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
  createEncryptedContentRecoveryRule: () => ({ id: 'encrypted_content', enabled: () => false, matches: () => false, strip: () => null }),
  createImageGenerationIdRecoveryRule: () => ({ id: 'image_generation_id', enabled: () => true, matches: () => false, strip: () => null }),
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

async function freshCodexProxyHost() {
  vi.resetModules();
  mockState.createAnthropicCompatProxy.mockReset();
  mockState.createInstructionsInjectionTransform.mockClear();
  mockState.injectionTransform.mockReset();
  mockState.injectionTransform.mockReturnValue(null);
  mockState.stripNonAnthropicFields.mockReset();
  mockState.stripNonAnthropicFields.mockReturnValue(null);
  mockState.resetCapturedRegistry();
  return import('../codex-proxy-host.js');
}

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
    expect(args).toContain('model_providers.cindy_openai.supports_websockets=false');
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
        // [encrypted activeStrip, image generation activeStrip, instructions 注入, 跨来源压缩块兼容, strict gateway history 兼容, xAI Responses 兼容, ByteDance Seed tool 兼容, MiniMax effort 兼容, provider model rewrite, stripNonAnthropicFields]
        transformRequest: [expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), mockState.stripNonAnthropicFields],
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
      ],
      input: [
        { type: 'message', role: 'system', content: 'BASE_PROMPT\n\nPRODUCT_PROMPT' },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAA' },
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
    expect(transforms).toHaveLength(11); // encrypted activeStrip, image generation activeStrip, instructions 注入, 跨来源压缩块兼容, strict gateway history 兼容, xAI Responses 兼容, ByteDance Seed tool 兼容, MiniMax effort 兼容, provider model rewrite, stripNonAnthropicFields, dump
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
