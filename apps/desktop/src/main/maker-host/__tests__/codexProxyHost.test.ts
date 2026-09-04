import fs from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

type Registry = {
  set(threadId: string, text: string): void;
  get(threadId: string): string | undefined;
  delete(threadId: string): void;
  readonly size: number;
};

// 每个用例都经 freshCodexProxyHost() 的 vi.resetModules() + 动态 import 重新加载
// 整条 SUT 模块链(maker-core / compat-proxy / bridges)。首个用例还要承担全部
// 依赖的首次编译加载，满载 CI 上会超出 vitest 默认 5s。只放宽本文件的预算，
// 断言与流程不变。
vi.setConfig({ testTimeout: 20_000 });

const mockState = vi.hoisted(() => {
  let capturedRegistry: Registry | null = null;
  const state = {
    logLevel: 'debug' as 'info' | 'debug',
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
  getLogLevel: () => mockState.logLevel,
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

vi.mock('@cindy/anthropic-compat-proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/anthropic-compat-proxy')>();
  return {
    ...actual,
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
    // 视觉桥 transform：默认短路（controller 未注入 → shouldBridge 恒 false → null 透传）。
    createVisionBridgeTransform: () => (() => null),
    createInstructionsRegistry: () => {
      const map = new Map<string, string>();
      return {
        set: (threadId: string, text: string) => { map.set(threadId, text); },
        get: (threadId: string) => map.get(threadId),
        delete: (threadId: string) => { map.delete(threadId); },
        get size() { return map.size; },
      };
    },
  };
});

vi.mock('@cindy/responses-chat-bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cindy/responses-chat-bridge')>(),
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
  mockState.logLevel = 'debug';
  mockState.resetCapturedRegistry();
  return import('../codex-proxy-host.js');
}

// CI 忙时本文件首次 import SUT 要付 Vitest transform 整个模块图的冷启动钱:Linux 分片
// 实测超默认 5s,Windows 分片超 15s,继续抬单测超时只是把死亡线后推。这笔成本属于环境
// 冷启动,不属于任何断言 —— 文件级 beforeAll 先把模块图焐热(hook 超时独立计),之后各
// 用例里 resetModules + import 只剩模块求值开销,回到默认超时内。
beforeAll(async () => {
  await import('../codex-proxy-host.js');
}, 60_000);

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
    const { setSessionProvider, clearSessionProvider } =
      await import('../session-provider-store.js');
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
  it('所有认证模式都让缺少 model metadata 的 Codex 模型使用 CodeModeOnly', async () => {
    const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');

    for (const mode of ['oauth-bearer', 'env-key', 'provider-oauth'] as const) {
      const args = buildCodexProxySpawnArgs('http://127.0.0.1:12345', mode);
      expect(args).toContain('features.code_mode_only=true');
    }
  });

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
    expect(args).toContain('model_providers.cindy_codex.name="OpenAI"');
    expect(args).toContain('model_providers.cindy_codex.requires_openai_auth=true');
    expect(args).toContain('model_providers.cindy_codex.supports_websockets=false');
    // is_openai + OAuth 命中时 codex 默认 zstd 压缩请求体,loopback proxy 无法解析,必须关。
    expect(args).toContain('features.enable_request_compression=false');
  });

  it('env-key / provider-oauth 只定义 Cindy Codex 远程压缩 identity', async () => {
    const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');

    for (const mode of ['env-key', 'provider-oauth'] as const) {
      const args = buildCodexProxySpawnArgs('http://127.0.0.1:12345', mode);
      expect(args.some((arg) => arg.includes('cindy_openai'))).toBe(false);
      expect(args).toContain('model_providers.cindy_codex.name="OpenAI"');
      expect(args).toContain('model_providers.cindy_codex.env_key="XDT_CODEX_API_KEY"');
      expect(args).toContain('model_providers.cindy_codex.supports_websockets=false');
      expect(args).toContain('features.enable_request_compression=false');
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
  const agentMessage = {
    type: 'agent_message',
    author: 'researcher',
    recipient: 'parent',
    content: [
      { type: 'input_text', text: 'readable agent result' },
      { type: 'encrypted_content', encrypted_content: 'AGENT_ENC' },
    ],
  };
  const reasoningItem = {
    type: 'reasoning',
    content: null,
    summary: [],
    encrypted_content: 'REASONING_ENC',
  };

  it('同时降级 compaction 与 agent 消息密文，保留可读正文和 reasoning(非 GPT 模型)', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();

    const out = transform(
      {
        model: 'not-gpt-5',
        input: [compactionItem, contextCompactionItem, agentMessage, reasoningItem, userMessage],
      },
      { ...CTX_BASE, upstreamBase: 'https://gateway.example.com/v1' },
    ) as { input: Array<Record<string, unknown>> };

    expect(out).not.toBeNull();
    expect(out.input).toHaveLength(5);
    expect(out.input[0].type).toBe('message');
    expect(out.input[1].type).toBe('message');
    expect(JSON.stringify(out.input[0])).toContain('compacted into an encrypted snapshot');
    expect(out.input[2]).toEqual({
      type: 'agent_message',
      author: 'researcher',
      recipient: 'parent',
      content: [{ type: 'input_text', text: 'readable agent result' }],
    });
    expect(out.input[3]).toEqual(reasoningItem);
    expect(out.input[4]).toEqual(userMessage);
    expect(JSON.stringify(out.input)).not.toContain('AGENT_ENC');
    expect(JSON.stringify(out.input)).toContain('REASONING_ENC');
    // transform 不得原地污染 Codex 持有的历史对象。
    expect(agentMessage.content).toHaveLength(2);
  });

  it('agent_message 只有密文时整条丢弃', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();

    const out = transform(
      {
        model: 'codex/claude-sonnet-4-6',
        input: [
          {
            type: 'agent_message',
            author: 'researcher',
            recipient: 'parent',
            content: [{ type: 'encrypted_content', encrypted_content: 'ONLY_ENC' }],
          },
          userMessage,
        ],
      },
      { ...CTX_BASE, upstreamBase: 'https://gateway.example.com/v1' },
    ) as { input: Array<Record<string, unknown>> };

    expect(out.input).toEqual([userMessage]);
  });

  it('ChatGPT 上游原样透传(远端压缩语义不受影响)', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();

    expect(transform(
      { model: 'claude-sonnet-4-6', input: [compactionItem, agentMessage, reasoningItem, userMessage] },
      { ...CTX_BASE, upstreamBase: 'https://chatgpt.com/backend-api/codex' },
    )).toBeNull();
  });

  it('版本化 gpt-* 与任意 */gpt-* 在所有 Responses Provider 原样透传父子 Agent 协作密文(大小写不敏感)', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    host.registerComposed('session-custom-gpt-parent', 'thread-custom-gpt-parent', 'PRODUCT_PROMPT');
    setSessionProvider('session-custom-gpt-parent', 'custom-gpt-pool');
    const parentToChildMessage = {
      type: 'agent_message',
      author: 'parent',
      recipient: 'researcher',
      content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAA_PARENT_TO_CHILD_TASK' }],
    };

    try {
      const transform = host.createCrossProviderCompactionCompatTransform();
      for (const model of [
        'gpt-5.6-sol',
        'GPT-5.6-TERRA',
        'codex/gpt-5.6-sol',
        'OPENAI/GPT-5.6-TERRA',
        'custom/pool/gpt-5.6-sol',
      ]) {
        expect(transform(
          {
            model,
            input: [compactionItem, parentToChildMessage, agentMessage, userMessage],
          },
          {
            ...CTX_BASE,
            upstreamBase: 'https://custom-pool.example.com/v1',
            headers: {
              'thread-id': 'thread-custom-gpt-child',
              'x-openai-subagent': 'collab_spawn',
              'x-codex-parent-thread-id': 'thread-custom-gpt-parent',
            },
          },
        )).toBeNull();
      }
    } finally {
      host.unregister('session-custom-gpt-parent');
      clearSessionProvider('session-custom-gpt-parent');
    }
  });

  it('gpt-oss 与非版本化 gpt 标签仍删除父子 Agent 协作密文', async () => {
    const { createCrossProviderCompactionCompatTransform } = await import('../codex-proxy-host.js');
    const transform = createCrossProviderCompactionCompatTransform();
    for (const model of ['gpt-oss:20b', 'codex/gpt-oss:20b', 'gpt-image-1']) {
      const out = transform(
        { model, input: [agentMessage, userMessage] },
        { ...CTX_BASE, upstreamBase: 'https://custom-pool.example.com/v1' },
      ) as { input: Array<Record<string, unknown>> };
      expect(out.input).toEqual([
        {
          type: 'agent_message',
          author: 'researcher',
          recipient: 'parent',
          content: [{ type: 'input_text', text: 'readable agent result' }],
        },
        userMessage,
      ]);
      expect(JSON.stringify(out.input)).not.toContain('AGENT_ENC');
    }
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
  it('fails closed before a pending target reaches the old custom local bridge', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const {
      setCustomProviderKeyReader,
      setPendingCredentialSwitchReader,
    } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'provider-a',
        name: 'Provider A',
        runtimes: {
          codex: {
            baseUrl: 'https://provider-a.example/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'shared-model', name: 'Shared Model' }],
          },
        },
      }),
    ]);
    const readKey = vi.fn(() => 'provider-a-key');
    setCustomProviderKeyReader(readKey);
    setPendingCredentialSwitchReader(() => ({
      model: 'shared-model',
      providerId: 'provider-b',
    }));
    host.registerComposed('session-pending-bridge', 'thread-pending-bridge', 'PRODUCT_PROMPT');
    setSessionProvider('session-pending-bridge', 'provider-a');
    host.setCodexProxyAuthInjection('env-key');

    try {
      const body = { model: 'shared-model', input: [{ role: 'user', content: 'hello' }] };
      const ctx = {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-pending-bridge' },
      };
      const decision = await Promise.resolve(host.createModelRoutingTransform()(body, ctx));
      expect(decision).toEqual({ localHandler: expect.any(Function) });
      expect(readKey).not.toHaveBeenCalled();
      expect(mockState.createResponsesChatHandler).not.toHaveBeenCalled();

      const writeHead = vi.fn();
      const end = vi.fn();
      await decision!.localHandler!({
        rawBody: Buffer.from(JSON.stringify(body)),
        parsedBody: body,
        ctx,
        res: { writeHead, end } as never,
      });
      expect(writeHead).toHaveBeenCalledWith(
        503,
        expect.objectContaining({ 'retry-after': '1' }),
      );
      expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
        error: { code: 'provider_switch_pending' },
      });
    } finally {
      host.unregister('session-pending-bridge');
      clearSessionProvider('session-pending-bridge');
      setPendingCredentialSwitchReader(() => undefined);
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
  });

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
    ['https://api.deepseek.com/v1', 'deepseek-v4-flash', 'reasoning_content'],
    ['https://api.deepseek.com', 'deepseek-chat', 'reasoning_content'],
    ['https://relay.example/v1', 'deepseek-v4-flash', undefined],
    ['http://api.deepseek.com/v1', 'deepseek-v4-flash', undefined],
    ['https://api.deepseek.com/v1', 'kimi-k3', undefined],
  ] as const)(
    'reasoning_content 历史回传只对官方 DeepSeek 路由开启 (#3441): %s %s → %s',
    async (upstream, model, expected) => {
      const { chatBridgeCapabilitiesForRoute } = await freshCodexProxyHost();
      expect(chatBridgeCapabilitiesForRoute(upstream, model).reasoningHistoryField).toBe(expected);
    },
  );

  it.each([
    ['https://api.kimi.com/coding/v1', 'k3'],
    ['https://api.kimi.com/coding/v1/', 'k3-256k'],
  ])('enables image_url for Kimi Code coding-plan route: %s / %s (#2732)', async (upstream, model) => {
    const { chatBridgeCapabilitiesForRoute } = await freshCodexProxyHost();
    expect(chatBridgeCapabilitiesForRoute(upstream, model).imageInput).toBe('image_url');
  });

  it.each([
    ['cindy-local-ollama', 'http://127.0.0.1:11434/v1'],
    ['my-custom-ollama', 'http://127.0.0.1:11434/v1'],
    ['my-custom-ollama', 'http://localhost:8080/v1'],
    ['my-custom-lmstudio', 'http://[::1]:1234/v1'],
  ])('coalesces leading system for loopback chat upstreams: %s / %s (#3531)', async (providerId, upstream) => {
    // 本地模板运行器(Qwen3 系 Jinja 模板)硬校验 system 在首,消息中段的
    // system/developer 直接 500;回环上游一律 coalesce,不再限 Qwen3.8 白名单。
    const { chatBridgeSystemMessagePolicyForRoute } = await freshCodexProxyHost();
    expect(chatBridgeSystemMessagePolicyForRoute(providerId, upstream)).toBe('coalesce-leading');
  });

  it.each([
    // 远程供应商保持 preserve 缺省:coalesce 会把 developer 并成 system,对
    // 原生区分 developer 的云端兼容层是语义变更。127.example.com 是合法公网
    // 域名,不得按前缀误判为 loopback。
    ['my-custom-remote', 'https://api.example.com/v1'],
    ['my-custom-remote', 'https://127.example.com/v1'],
    ['my-custom-remote', 'not-a-url'],
  ])('keeps preserve for non-loopback chat upstreams: %s / %s (#3531)', async (providerId, upstream) => {
    const { chatBridgeSystemMessagePolicyForRoute } = await freshCodexProxyHost();
    expect(chatBridgeSystemMessagePolicyForRoute(providerId, upstream)).toBeUndefined();
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
    // Kimi Code: non-HTTPS, spoofed subdomain, and models without verified image support stay closed.
    ['http://api.kimi.com/coding/v1', 'k3'],
    ['https://api.kimi.com.evil.example/coding/v1', 'k3'],
    ['https://api.kimi.com/coding/v1', 'kimi-k3'],
    ['https://api.kimi.com/coding/v1', 'kimi-for-coding'],
    ['https://api.moonshot.cn/v1', 'k3'],
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

  it('strips agent message ciphertext before a cross-provider Chat bridge request', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'history-chat-provider',
        name: 'History Chat Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://chat-provider.example/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'history-model', name: 'History Model' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'history-provider-key');
    host.registerComposed('session-history-chat', 'thread-history-chat', 'PRODUCT_PROMPT');
    setSessionProvider('session-history-chat', 'history-chat-provider');
    host.setCodexProxyAuthInjection('env-key');

    const parsedBody = {
      model: 'history-model',
      input: [
        {
          type: 'agent_message',
          author: 'researcher',
          recipient: 'parent',
          content: [
            { type: 'input_text', text: 'readable result' },
            { type: 'encrypted_content', encrypted_content: 'AGENT_ENC' },
          ],
        },
        {
          type: 'agent_message',
          author: 'researcher',
          recipient: 'parent',
          content: [{ type: 'encrypted_content', encrypted_content: 'ONLY_ENC' }],
        },
        {
          type: 'reasoning',
          content: null,
          summary: [],
          encrypted_content: 'REASONING_ENC',
        },
      ],
    };
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-history-chat' },
    };

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        parsedBody,
        ctx,
      ));
      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      if (!decision?.localHandler) throw new Error('expected Chat bridge local handler');

      const res = {} as never;
      await decision.localHandler({
        rawBody: Buffer.from(JSON.stringify(parsedBody)),
        parsedBody,
        ctx,
        res,
      });
      const bridge = mockState.createResponsesChatHandler.mock.results.at(-1)?.value as
        | { handle: ReturnType<typeof vi.fn> }
        | undefined;
      expect(bridge?.handle).toHaveBeenCalledWith({
        parsedBody: {
          ...parsedBody,
          instructions: 'PRODUCT_PROMPT',
          input: [
            {
              type: 'agent_message',
              author: 'researcher',
              recipient: 'parent',
              content: [{ type: 'input_text', text: 'readable result' }],
            },
            parsedBody.input[2],
          ],
        },
        res,
      });
    } finally {
      clearSessionProvider('session-history-chat');
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
  });

  it('strips parent-to-child ciphertext when a versioned GPT model uses the Chat bridge', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    const model = 'OPENAI/GPT-5.6-SOL';
    setCustomProviders([
      buildUserProvider({
        id: 'gpt-history-chat-provider',
        name: 'GPT History Chat Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://gpt-chat-provider.example/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: model, name: 'Custom GPT' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'gpt-history-provider-key');
    host.registerComposed('session-gpt-history-chat', 'thread-gpt-history-chat', 'PRODUCT_PROMPT');
    setSessionProvider('session-gpt-history-chat', 'gpt-history-chat-provider');
    host.setCodexProxyAuthInjection('env-key');

    const parentToChildMessage = {
      type: 'agent_message',
      author: 'parent',
      recipient: 'researcher',
      content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAA_PARENT_TO_CHILD_TASK' }],
    };
    const parsedBody = { model, input: [parentToChildMessage] };
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-gpt-history-chat' },
    };

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(parsedBody, ctx));
      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      if (!decision?.localHandler) throw new Error('expected GPT Chat bridge local handler');

      const res = {} as never;
      await decision.localHandler({
        rawBody: Buffer.from(JSON.stringify(parsedBody)),
        parsedBody,
        ctx,
        res,
      });
      const bridge = mockState.createResponsesChatHandler.mock.results.at(-1)?.value as
        | { handle: ReturnType<typeof vi.fn> }
        | undefined;
      expect(bridge?.handle).toHaveBeenCalledWith({
        parsedBody: {
          ...parsedBody,
          instructions: 'PRODUCT_PROMPT',
          input: [],
        },
        res,
      });
    } finally {
      clearSessionProvider('session-gpt-history-chat');
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
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

  it('does not project an XD Claude-only model into Codex or create an Anthropic bridge', async () => {
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{
      id: 'claude-only',
      name: 'Claude Only',
      contextWindow: 200_000,
      agents: ['claude-code'],
      perAgent: { 'claude-code': { wireProtocol: 'anthropic-messages' } },
    }]);
    host.setCodexProxyGatewayKeyReader(() => 'xd-gateway-key');
    host.registerComposed('session-xd-no-projection', 'thread-xd-no-projection', 'PRODUCT_PROMPT');
    setSessionProvider('session-xd-no-projection', 'xd');
    host.setCodexProxyAuthInjection('env-key');

    const decision = await Promise.resolve(host.createModelRoutingTransform()(
      {
        model: 'claude-only[1m]',
        input: [{ role: 'user', content: 'hello' }],
      },
      {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-no-projection' },
      },
    ));

    expect(decision).toBeNull();
    expect(mockState.createResponsesAnthropicHandler).not.toHaveBeenCalled();

    host.unregister('session-xd-no-projection');
    clearSessionProvider('session-xd-no-projection');
    setXdGatewayModels([]);
    host.setCodexProxyGatewayKeyReader(() => null);
  });

  it('does not implicitly select XD for a model that v3 only assigns to Claude Code', async () => {
    const host = await freshCodexProxyHost();
    const { getActiveCatalog, setXdGatewayModels } = await import('../active-catalog.js');
    const { setProviderViewsReader } = await import('../provider-route.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{
      id: 'claude-implicit-xd',
      name: 'Implicit XD Claude',
      contextWindow: 200_000,
      agents: ['claude-code'],
      perAgent: { 'claude-code': { wireProtocol: 'anthropic-messages' } },
    }]);
    setProviderViewsReader(async () => getActiveCatalog().providers.map((provider) => ({
      ...provider,
      connected: provider.id === 'xd',
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

      expect(decision).toBeNull();
      expect(mockState.createResponsesAnthropicHandler).not.toHaveBeenCalled();
    } finally {
      host.unregister('session-implicit-xd');
      clearSessionProvider('session-implicit-xd');
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

  it('routes the first collab_spawn request through its parent custom Responses provider', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'collab-spawn-provider',
        name: 'Collab Spawn Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://collab-spawn.invalid/v1',
            models: [{ id: 'collab-spawn-model', name: 'Collab Spawn Model' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'test-invalid-collab-spawn-key');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-collab-parent', 'thread-collab-parent', 'PRODUCT_PROMPT');
    setSessionProvider('session-collab-parent', 'collab-spawn-provider');
    host.setCodexProxyAuthInjection('env-key');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'collab-spawn-model', input: [] },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: {
            'thread-id': 'thread-collab-child',
            'x-openai-subagent': 'collab_spawn',
            'x-codex-parent-thread-id': 'thread-collab-parent',
          },
        },
      ));

      expect(decision).toEqual({
        upstreamOverride: 'https://collab-spawn.invalid/v1',
        headerOverride: { authorization: 'Bearer test-invalid-collab-spawn-key' },
        headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
      });
      expect(mockState.capturedRegistry?.get('thread-collab-child')).toBe('PRODUCT_PROMPT');
    } finally {
      host.unregister('session-collab-parent');
      clearSessionProvider('session-collab-parent');
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
  });

  it('forces a locked third-party model and effort before Provider routing', async () => {
    const host = await freshCodexProxyHost();
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([{
      id: 'subagent-route-provider',
      name: 'Subagent Route Provider',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          wireProtocol: 'openai-responses',
          upstream: 'https://subagent-route.invalid/v1',
          authStrategy: 'api-key-header',
          modelIdRewrite: { stripPrefix: 'route/' },
        },
      },
      models: { codex: [{ id: 'route/model-a', name: 'Model A' }] },
    } as never]);
    setCustomProviderKeyReader(() => 'subagent-route-key');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.setCodexProxyGatewayKeyReader(() => 'gateway-subagent-key');
    host.registerComposed(
      'session-openai-parent',
      'thread-openai-parent',
      'PRODUCT_PROMPT',
      {
        subagentRoute: {
          providerId: 'subagent-route-provider',
          catalogModel: 'route/model-a',
          reasoningEffort: 'high',
        },
      },
    );
    setSessionProvider('session-openai-parent', 'openai');

    try {
      const requestContext = {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: {
          'thread-id': 'thread-gateway-child',
          'x-openai-subagent': 'collab_spawn',
          'x-codex-parent-thread-id': 'thread-openai-parent',
        },
      };
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      const forcedRouteTransform = transforms[3];
      if (!forcedRouteTransform) throw new Error('expected locked Subagent route transform');
      mockState.injectionTransform.mockImplementationOnce((body) => {
        // 首个 collab_spawn 请求必须先懒登记血缘，同一轮 instructions transform 才能
        // 读到继承的产品提示词。
        expect(mockState.capturedRegistry?.get('thread-gateway-child')).toBe('PRODUCT_PROMPT');
        return body;
      });
      let transformed: unknown = {
        model: 'gpt-5.5',
        reasoning: { effort: 'medium' },
        input: [],
      };
      for (const transform of transforms.slice(0, 5)) {
        const next = transform(transformed, requestContext);
        if (next !== null && next !== undefined) transformed = next;
      }
      expect(transformed).toEqual({
        model: 'route/model-a',
        reasoning: { effort: 'high' },
        input: [],
      });

      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'gpt-5.5', input: [] },
        requestContext,
      ));

      expect(decision).toEqual({
        upstreamOverride: 'https://subagent-route.invalid/v1',
        headerOverride: { authorization: 'Bearer subagent-route-key' },
        headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
      });
      expect(mockState.capturedRegistry?.get('thread-gateway-child')).toBe('PRODUCT_PROMPT');

      host.registerComposed(
        'session-openai-parent',
        'thread-openai-parent',
        'PRODUCT_PROMPT',
        {
          subagentRoute: {
            providerId: 'subagent-route-provider',
            catalogModel: 'route/model-a',
            reasoningEffort: null,
          },
        },
      );
      expect(forcedRouteTransform(
        {
          model: 'gpt-5.5',
          reasoning: { effort: 'medium', summary: 'auto' },
          input: [],
        },
        {
          ...requestContext,
          headers: {
            ...requestContext.headers,
            'thread-id': 'thread-default-effort-child',
          },
        },
      )).toEqual({
        model: 'route/model-a',
        reasoning: { summary: 'auto' },
        input: [],
      });

      host.registerChildThread('thread-openai-parent', 'guardian-child-thread');
      expect(forcedRouteTransform(
        { model: 'reviewer-model', reasoning: { effort: 'medium' }, input: [] },
        {
          ...requestContext,
          headers: {
            'thread-id': 'guardian-child-thread',
            'x-openai-subagent': 'guardian',
            'x-codex-parent-thread-id': 'thread-openai-parent',
          },
        },
      )).toBeNull();
      expect(forcedRouteTransform(
        { model: 'reviewer-model', reasoning: { effort: 'medium' }, input: [] },
        {
          ...requestContext,
          headers: {
            'thread-id': 'guardian-child-thread',
            'x-openai-subagent': 'review',
            'x-codex-parent-thread-id': 'thread-openai-parent',
          },
        },
      )).toBeNull();

      const execGuardTransform = transforms[5];
      if (!execGuardTransform) throw new Error('expected locked Subagent exec guard transform');
      const guarded = execGuardTransform({
        model: 'deepseek/deepseek-v4-flash',
        tools: [{
          type: 'custom',
          name: 'exec',
          description: 'Run JavaScript.\n### `multi_agent_v1__spawn_agent`\nNested declaration.',
        }],
      }, {
        ...requestContext,
        headers: { 'thread-id': 'thread-openai-parent' },
      });
      expect(guarded).toMatchObject({
        tools: [{
          type: 'custom',
          name: 'exec',
          description: expect.stringMatching(
            /^IMPORTANT: The tool declarations below are nested APIs[\s\S]*Run JavaScript\./,
          ),
        }],
      });
      expect(execGuardTransform(guarded, {
        ...requestContext,
        headers: { 'thread-id': 'thread-openai-parent' },
      })).toBeNull();
      expect(execGuardTransform({
        tools: [{
          type: 'custom',
          name: 'exec',
          description: '### `multi_agent_v1__spawn_agent`',
        }],
      }, {
        ...requestContext,
        headers: { 'thread-id': 'guardian-child-thread', 'x-openai-subagent': 'guardian' },
      })).toBeNull();
    } finally {
      host.unregister('session-openai-parent');
      clearSessionProvider('session-openai-parent');
      host.setCodexProxyGatewayKeyReader(() => null);
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
  });

  it('routes a smart Subagent by its requested model and records the actual identity', async () => {
    const host = await freshCodexProxyHost();
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([{
      id: 'smart-subagent-provider',
      name: 'Smart Subagent Provider',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          wireProtocol: 'openai-responses',
          upstream: 'https://smart-subagent.invalid/v1',
          authStrategy: 'api-key-header',
        },
      },
      models: { codex: [{ id: 'smart/model-cheap', name: 'Smart Cheap Model' }] },
    } as never]);
    setCustomProviderKeyReader(() => 'smart-subagent-key');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.registerComposed(
      'session-smart-parent',
      'thread-smart-parent',
      'PRODUCT_PROMPT',
      {
        smartSubagentRoutes: [{
          providerId: 'smart-subagent-provider',
          catalogModel: 'smart/model-cheap',
        }],
      },
    );
    setSessionProvider('session-smart-parent', 'openai');

    try {
      const ctx = {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: {
          'thread-id': 'thread-smart-child',
          'x-openai-subagent': 'collab_spawn',
          'x-codex-parent-thread-id': 'thread-smart-parent',
        },
      };
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      const forcedRouteTransform = transforms[3];
      if (!forcedRouteTransform) throw new Error('expected smart Subagent route transform');
      expect(forcedRouteTransform({
        model: 'smart/model-cheap',
        reasoning: { effort: 'low' },
        input: [],
      }, ctx)).toEqual({
        model: 'smart/model-cheap',
        reasoning: { effort: 'low' },
        input: [],
      });
      expect(host.getObservedCodexSubagentIdentity('thread-smart-child')).toEqual({
        model: 'smart/model-cheap',
        reasoningEffort: 'low',
      });

      await expect(Promise.resolve(host.createModelRoutingTransform()(
        { model: 'smart/model-cheap', input: [] },
        ctx,
      ))).resolves.toEqual({
        upstreamOverride: 'https://smart-subagent.invalid/v1',
        headerOverride: { authorization: 'Bearer smart-subagent-key' },
        headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
      });
    } finally {
      host.unregister('session-smart-parent');
      clearSessionProvider('session-smart-parent');
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
  });

  it('passes a locked Subagent effort through the Chat local bridge', async () => {
    const host = await freshCodexProxyHost();
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([{
      id: 'locked-chat-provider',
      name: 'Locked Chat Provider',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          wireProtocol: 'openai-chat',
          upstream: 'https://locked-chat.invalid/v1',
          authStrategy: 'api-key-header',
          modelIdRewrite: { stripPrefix: 'chat/' },
        },
      },
      models: { codex: [{ id: 'chat/model-a', name: 'Chat Model A' }] },
    } as never]);
    setCustomProviderKeyReader(() => 'locked-chat-key');
    host.registerComposed(
      'session-chat-parent',
      'thread-chat-parent',
      'PRODUCT_PROMPT',
      {
        subagentRoute: {
          providerId: 'locked-chat-provider',
          catalogModel: 'chat/model-a',
          reasoningEffort: 'high',
        },
      },
    );
    setSessionProvider('session-chat-parent', 'openai');
    host.setCodexProxyAuthInjection('oauth-bearer');

    const parsedBody = {
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'medium', summary: 'auto' },
      input: [],
    };
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/responses',
      headers: {
        'thread-id': 'thread-chat-child',
        'x-openai-subagent': 'collab_spawn',
        'x-codex-parent-thread-id': 'thread-chat-parent',
      },
    };

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(parsedBody, ctx));
      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      if (!decision?.localHandler) throw new Error('expected Chat bridge local handler');

      const res = {} as never;
      await decision.localHandler({
        rawBody: Buffer.from(JSON.stringify(parsedBody)),
        parsedBody,
        ctx,
        res,
      });
      const bridge = mockState.createResponsesChatHandler.mock.results.at(-1)?.value as
        | { handle: ReturnType<typeof vi.fn> }
        | undefined;
      expect(bridge?.handle).toHaveBeenCalledWith({
        parsedBody: {
          ...parsedBody,
          model: 'chat/model-a',
          reasoning: { effort: 'high', summary: 'auto' },
          instructions: 'PRODUCT_PROMPT',
        },
        res,
      });
    } finally {
      host.unregister('session-chat-parent');
      clearSessionProvider('session-chat-parent');
      host.clearCodexProxyAuthInjection();
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
  });

  it('clears an inherited effort for a default-effort Subagent through the Anthropic local bridge', async () => {
    const host = await freshCodexProxyHost();
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([{
      id: 'locked-anthropic-provider',
      name: 'Locked Anthropic Provider',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          wireProtocol: 'anthropic-messages',
          upstream: 'https://locked-anthropic.invalid',
          authStrategy: 'api-key-header',
          modelIdRewrite: { stripPrefix: 'anthropic/' },
        },
      },
      models: { codex: [{ id: 'anthropic/model-a', name: 'Anthropic Model A' }] },
    } as never]);
    setCustomProviderKeyReader(() => 'locked-anthropic-key');
    host.registerComposed(
      'session-anthropic-parent',
      'thread-anthropic-parent',
      'PRODUCT_PROMPT',
      {
        subagentRoute: {
          providerId: 'locked-anthropic-provider',
          catalogModel: 'anthropic/model-a',
          reasoningEffort: null,
        },
      },
    );
    setSessionProvider('session-anthropic-parent', 'openai');
    host.setCodexProxyAuthInjection('oauth-bearer');

    const parsedBody = {
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'medium', summary: 'auto' },
      input: [],
    };
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/responses',
      headers: {
        'thread-id': 'thread-anthropic-child',
        'x-openai-subagent': 'collab_spawn',
        'x-codex-parent-thread-id': 'thread-anthropic-parent',
      },
    };

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(parsedBody, ctx));
      expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
      if (!decision?.localHandler) throw new Error('expected Anthropic bridge local handler');

      const res = {} as never;
      await decision.localHandler({
        rawBody: Buffer.from(JSON.stringify(parsedBody)),
        parsedBody,
        ctx,
        res,
      });
      const bridge = mockState.createResponsesAnthropicHandler.mock.results.at(-1)?.value as
        | { handle: ReturnType<typeof vi.fn> }
        | undefined;
      expect(bridge?.handle).toHaveBeenCalledWith({
        parsedBody: {
          ...parsedBody,
          model: 'anthropic/model-a',
          reasoning: { summary: 'auto' },
          instructions: 'PRODUCT_PROMPT',
        },
        ctx,
        res,
      });
    } finally {
      host.unregister('session-anthropic-parent');
      clearSessionProvider('session-anthropic-parent');
      host.clearCodexProxyAuthInjection();
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
  });

  it('routes a child by the locked model even when the inherited request model differs', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    const requestModel = 'gpt-5.6-sol';
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.setCodexProxyGatewayKeyReader(() => 'gateway-subagent-key');
    host.registerComposed(
      'session-openai-parent',
      'thread-openai-parent',
      'PRODUCT_PROMPT',
      {
        subagentRoute: {
          providerId: 'xd',
          catalogModel: 'codex/gpt-5.6-terra',
          reasoningEffort: null,
        },
      },
    );
    setSessionProvider('session-openai-parent', 'openai');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: requestModel, input: [] },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: {
            'thread-id': `thread-${requestModel}`,
            'x-openai-subagent': 'collab_spawn',
            'x-codex-parent-thread-id': 'thread-openai-parent',
          },
        },
      ));

      expect(decision).toEqual({ headerOverride: { authorization: 'Bearer gateway-subagent-key' } });
    } finally {
      host.unregister('session-openai-parent');
      clearSessionProvider('session-openai-parent');
      host.setCodexProxyGatewayKeyReader(() => null);
    }
  });

  it('fails closed when a passthrough subagent Provider does not match the app-server credential', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    host.setCodexProxyAuthInjection('env-key');
    host.registerComposed(
      'session-gateway-parent',
      'thread-gateway-parent',
      'PRODUCT_PROMPT',
      {
        subagentRoute: {
          providerId: 'openai',
          catalogModel: 'gpt-5.6-terra',
          reasoningEffort: null,
        },
      },
    );
    setSessionProvider('session-gateway-parent', 'xd');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'gpt-5.6-terra', input: [] },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: {
            'thread-id': 'thread-openai-child',
            'x-openai-subagent': 'collab_spawn',
            'x-codex-parent-thread-id': 'thread-gateway-parent',
          },
        },
      ));

      expect(decision).toEqual({ localHandler: expect.any(Function) });
    } finally {
      host.unregister('session-gateway-parent');
      clearSessionProvider('session-gateway-parent');
    }
  });

  it('fails closed when a collab_spawn request cannot resolve its parent route', async () => {
    const host = await freshCodexProxyHost();
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/responses',
      headers: {
        'thread-id': 'thread-collab-orphan',
        'x-openai-subagent': 'collab_spawn',
        'x-codex-parent-thread-id': 'thread-collab-missing-parent',
      },
    };

    const decision = await Promise.resolve(host.createModelRoutingTransform()(
      { model: 'collab-spawn-model', input: [] },
      ctx,
    ));

    expect(decision).toEqual({ localHandler: expect.any(Function) });
    if (!decision?.localHandler) throw new Error('missing unresolved collab_spawn route handler');

    const writeHead = vi.fn();
    const end = vi.fn();
    await decision.localHandler({
      rawBody: Buffer.alloc(0),
      parsedBody: { model: 'collab-spawn-model', input: [] },
      ctx,
      res: { writeHead, end } as never,
    });

    expect(writeHead).toHaveBeenCalledWith(503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    expect(JSON.parse(String(end.mock.calls[0]?.[0]))).toEqual({
      error: {
        type: 'server_error',
        code: 'cindy_codex_parent_route_unavailable',
        message: 'Cindy could not resolve the parent Provider route for this spawned Codex agent.',
      },
    });
    expect(mockState.capturedRegistry?.get('thread-collab-orphan')).toBeUndefined();
  });

  it('does not use a matching x-client-request-id as a collab_spawn child identity', async () => {
    const host = await freshCodexProxyHost();
    host.registerComposed('session-collab-parent', 'thread-collab-parent', 'PARENT_PROMPT');
    host.registerComposed('session-request-owner', 'request-collab-child', 'OWNER_PROMPT');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'collab-spawn-model', input: [] },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: {
            'x-client-request-id': 'request-collab-child',
            'x-openai-subagent': 'collab_spawn',
            'x-codex-parent-thread-id': 'thread-collab-parent',
          },
        },
      ));

      expect(decision).toEqual({ localHandler: expect.any(Function) });
      expect(host.registerChildThread('thread-collab-parent', 'request-collab-child')).toBe(false);
    } finally {
      host.unregister('session-collab-parent');
      host.unregister('session-request-owner');
    }
  });

  it('keeps an already-owned collab_spawn child on its existing session route', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'collab-parent-provider',
        name: 'Collab Parent Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://collab-parent.invalid/v1',
            models: [{ id: 'shared-collab-model', name: 'Shared Collab Model' }],
          },
        },
      }),
      buildUserProvider({
        id: 'collab-owner-provider',
        name: 'Collab Owner Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://collab-owner.invalid/v1',
            models: [{ id: 'shared-collab-model', name: 'Shared Collab Model' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader((providerId) => `test-invalid-${providerId}-key`);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-collab-parent', 'thread-collab-parent', 'PARENT_PROMPT');
    host.registerComposed('session-collab-owner', 'thread-collab-owned', 'OWNER_PROMPT');
    setSessionProvider('session-collab-parent', 'collab-parent-provider');
    setSessionProvider('session-collab-owner', 'collab-owner-provider');
    host.setCodexProxyAuthInjection('env-key');

    try {
      const decision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'shared-collab-model', input: [] },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: {
            'thread-id': 'thread-collab-owned',
            'x-openai-subagent': 'collab_spawn',
            'x-codex-parent-thread-id': 'thread-collab-parent',
          },
        },
      ));

      expect(decision).toEqual({
        upstreamOverride: 'https://collab-owner.invalid/v1',
        headerOverride: { authorization: 'Bearer test-invalid-collab-owner-provider-key' },
        headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
      });
      expect(mockState.capturedRegistry?.get('thread-collab-owned')).toBe('OWNER_PROMPT');
    } finally {
      host.unregister('session-collab-parent');
      host.unregister('session-collab-owner');
      clearSessionProvider('session-collab-parent');
      clearSessionProvider('session-collab-owner');
      setCustomProviderKeyReader(() => null);
      setCustomProviders([]);
    }
  });

  const rejectedLazyInheritanceRequests: Array<{
    name: string;
    childThreadId: string;
    headers: Readonly<Record<string, string>>;
  }> = [
    {
      name: 'non-spawn request',
      childThreadId: 'thread-review-child',
      headers: {
        'thread-id': 'thread-review-child',
        'x-openai-subagent': 'review',
        'x-codex-parent-thread-id': 'thread-collab-parent',
      },
    },
    {
      name: 'request id without a thread id',
      childThreadId: 'request-collab-child',
      headers: {
        'x-client-request-id': 'request-collab-child',
        'x-openai-subagent': 'collab_spawn',
        'x-codex-parent-thread-id': 'thread-collab-parent',
      },
    },
  ];

  it.each(rejectedLazyInheritanceRequests)(
    'does not lazily inherit the parent for a $name',
    async ({ childThreadId, headers }) => {
      const host = await freshCodexProxyHost();
      mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
        url: 'http://127.0.0.1:43210',
        dispose: vi.fn(async () => undefined),
      });
      await host.ensureCodexProxyReady();
      host.registerComposed('session-collab-parent', 'thread-collab-parent', 'PARENT_PROMPT');

      try {
        await Promise.resolve(host.createModelRoutingTransform()(
          { model: 'gpt-5.6', input: [] },
          { reqId: 1, method: 'POST', url: '/responses', headers },
        ));

        expect(mockState.capturedRegistry?.get(childThreadId)).toBeUndefined();
      } finally {
        host.unregister('session-collab-parent');
      }
    },
  );

  it('does not register a Guardian request as a prompt-inheriting child thread', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-guardian-parent', 'thread-guardian-parent', 'PRODUCT_PROMPT');

    try {
      await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'codex-auto-review', input: [] },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: {
            'thread-id': 'thread-guardian-child',
            'x-openai-subagent': 'guardian',
            'x-codex-parent-thread-id': 'thread-guardian-parent',
          },
        },
      ));

      expect(mockState.capturedRegistry?.get('thread-guardian-child')).toBeUndefined();
    } finally {
      host.unregister('session-guardian-parent');
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

  it('does not create a hidden XD bridge for a Claude-only model without a gateway key', async () => {
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{
      id: 'claude-bridge',
      name: 'Claude Bridge',
      contextWindow: 200_000,
      agents: ['claude-code'],
      perAgent: { 'claude-code': { wireProtocol: 'anthropic-messages' } },
    }]);
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

    expect(decision).toBeNull();
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
        // [encrypted activeStrip, image generation activeStrip, provider-aware Guardian reviewer, locked Subagent route, instructions 注入, locked Subagent exec guard, Gateway 原生 web_search, 跨来源压缩块兼容, xAI ModelInput activeStrip, exec function adapter, strict gateway history 兼容, xAI ModelInput sanitize, DeepSeek V4 custom tool 兼容, xAI Responses 兼容, XD Gateway Grok 兼容, ByteDance Seed tool 兼容, MiniMax effort 兼容, provider model rewrite, 视觉桥(controller 未注入 → 短路透传), stripNonAnthropicFields]
        transformRequest: [
          expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function),
          expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function),
          expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function),
          expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function),
          mockState.stripNonAnthropicFields,
        ],
        transformResponse: expect.any(Function),
        routingTransform: expect.any(Function),
        retryProvenWebSocketUpgrades: true,
        recoveryRules: expect.arrayContaining([
          expect.objectContaining({ id: 'encrypted_content' }),
          expect.objectContaining({ id: 'image_generation_id' }),
          expect.objectContaining({ id: 'xai_model_input' }),
        ]),
      }),
    );
    const proxyOpts = mockState.createAnthropicCompatProxy.mock.calls[0][0] as {
      upstream: () => string;
      transformRequest: Array<{
        errorMode?: 'reject-request';
        onRequestSettled?: (requestId: number) => void;
      }>;
    };
    expect(proxyOpts.upstream()).toBe(`${XD_GATEWAY_BASE_URL}/v1`);
    const requestScopedTransforms = proxyOpts.transformRequest.filter(
      (transform) => transform.onRequestSettled,
    );
    expect(requestScopedTransforms).toHaveLength(1);
    expect(requestScopedTransforms[0]?.errorMode).toBe('reject-request');
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

  it('forgets only the closing session websocket proofs before a provider-route resume', async () => {
    const host = await freshCodexProxyHost();
    const forgetWebSocketStateForThread = vi.fn(() => 1);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      forgetWebSocketStateForThread,
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-switching', 'thread-switching', 'PRODUCT_PROMPT');
    host.registerChildThread('thread-switching', 'thread-switching-child');
    host.registerComposed('session-untouched', 'thread-untouched', 'PRODUCT_PROMPT');

    host.unregister('session-switching');

    expect(forgetWebSocketStateForThread).toHaveBeenCalledTimes(2);
    expect(forgetWebSocketStateForThread).toHaveBeenCalledWith('thread-switching');
    expect(forgetWebSocketStateForThread).toHaveBeenCalledWith('thread-switching-child');
    expect(forgetWebSocketStateForThread).not.toHaveBeenCalledWith('thread-untouched');
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

  it('keeps the parent websocket while observing every subagent over HTTP', async () => {
    // cindy_openai 保持父线程 WS 能力；collab_spawn child upgrade 一律回 null
    //（426 → Codex 按子会话降到 HTTP），这样 proxy 才能按请求模型路由并记录真实身份。
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.setCodexProxyGatewayKeyReader(() => 'gateway-subagent-key');
    host.registerComposed(
      'session-ws-parent',
      'thread-ws-parent',
      'PRODUCT_PROMPT',
      {
        subagentRoute: {
          providerId: 'xd',
          catalogModel: 'codex/gpt-5.6-sol',
          reasoningEffort: null,
        },
      },
    );

    try {
      const proxyOpts = mockState.createAnthropicCompatProxy.mock.calls[0][0] as {
        resolveWebSocketUpstream: (ctx: {
          url: string;
          headers: Readonly<Record<string, string>>;
        }) => string | null;
      };
      const ctxForThread = (threadId: string, extra: Record<string, string> = {}) => ({
        url: '/v1/responses',
        headers: { 'thread-id': threadId, ...extra },
      });
      const ctxForCodex145ChildPrewarm = (
        threadId: string,
        sessionId: string,
        parentThreadId: string,
      ) => ctxForThread(threadId, {
        'session-id': sessionId,
        'x-client-request-id': threadId,
        'x-openai-subagent': 'collab_spawn',
        'x-codex-parent-thread-id': parentThreadId,
      });

      expect(proxyOpts.resolveWebSocketUpstream(ctxForThread('thread-ws-parent'))).toBe(
        'https://chatgpt.com/backend-api/codex',
      );
      // 经血缘继承了 route 快照的已登记子线程拒绝 WS。
      host.registerChildThread('thread-ws-parent', 'thread-ws-child');
      expect(proxyOpts.resolveWebSocketUpstream(ctxForCodex145ChildPrewarm(
        'thread-ws-child',
        'session-ws-child',
        'thread-ws-parent',
      ))).toBeNull();
      // 0.145.0 child startup prewarm 可能早于 thread/started；完整握手 metadata
      // 通过显式 parent header 命中路由快照，null 由 proxy 映射为 426。
      expect(proxyOpts.resolveWebSocketUpstream(ctxForCodex145ChildPrewarm(
        'thread-ws-child-2',
        'session-ws-child-2',
        'thread-ws-parent',
      ))).toBeNull();
      // Codex's HTTP fallback may only carry the child thread id. The WS
      // handshake must have bound the child route before returning 426, or this
      // request falls through as a normal ChatGPT OAuth request.
      await expect(Promise.resolve(host.createModelRoutingTransform()(
        { model: 'gpt-5.6-sol', input: [] },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-ws-child-2' },
        },
      ))).resolves.toEqual({
        headerOverride: { authorization: 'Bearer gateway-subagent-key' },
      });
      // 即使没有额外路由，仍需从 HTTP 请求观察 Codex 原生实际选择的 Sol/Terra。
      expect(proxyOpts.resolveWebSocketUpstream(ctxForCodex145ChildPrewarm(
        'thread-openai-child',
        'session-openai-child',
        'thread-openai-main',
      ))).toBeNull();
    } finally {
      host.unregister('session-ws-parent');
      host.setCodexProxyGatewayKeyReader(() => null);
      host.clearCodexProxyAuthInjection();
    }
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
    // active strips ×2, then provider-aware Guardian rewrite。
    const reviewerTransform = transforms[2];
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
    const reviewerTransform = transforms[2];
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

  it('keeps custom-context Host generations isolated when the superseded proxy retires', async () => {
    const host = await freshCodexProxyHost();
    const { BUNDLED_CATALOG, buildUserProvider } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { deriveCodexCustomProviderRoutes } =
      await import('../codex-custom-provider-route.js');
    const snapshotFor = (baseUrl: string) => {
      const catalog = {
        ...BUNDLED_CATALOG,
        providers: [
          ...BUNDLED_CATALOG.providers,
          buildUserProvider({
            id: 'scoped-custom-context-provider',
            name: 'Scoped Custom Context Provider',
            runtimes: {
              codex: {
                baseUrl,
                wireProtocol: 'openai-responses',
                supportsImageGeneration: true,
                models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
              },
            },
          }),
        ],
      };
      return { catalog, route: deriveCodexCustomProviderRoutes(catalog)[0]! };
    };
    const first = snapshotFor('https://first-context.example/v1');
    const second = snapshotFor('https://second-context.example/v1');
    const firstRoute = first.route;
    const secondRoute = second.route;
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    mockState.createAnthropicCompatProxy
      .mockResolvedValueOnce({ url: 'http://127.0.0.1:41001', dispose: firstDispose })
      .mockResolvedValueOnce({ url: 'http://127.0.0.1:41002', dispose: secondDispose });
    setCustomProviderKeyReader(() => 'scoped-provider-key');
    setActiveCatalog(second.catalog);
    host.setCodexAppliedCustomProviderRoutes([secondRoute]);

    try {
      await host.ensureCodexCustomContextProxyReady('context-host:1', 'provider-oauth', [firstRoute]);
      await host.ensureCodexCustomContextProxyReady('context-host:2', 'provider-oauth', [secondRoute]);

      expect(host.getCodexCustomContextProxyEndpoint('context-host:1')).toBe(
        'http://127.0.0.1:41001',
      );
      expect(host.getCodexCustomContextProxyEndpoint('context-host:2')).toBe(
        'http://127.0.0.1:41002',
      );
      const firstRoutingTransform = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]
        ?.routingTransform;
      const secondRoutingTransform = mockState.createAnthropicCompatProxy.mock.calls[1]?.[0]
        ?.routingTransform;
      if (!firstRoutingTransform || !secondRoutingTransform) {
        throw new Error('expected scoped routing transforms');
      }
      const request = { model: 'gpt-5.6-sol', input: [] };
      const requestContext = {
        reqId: 1,
        method: 'POST',
        url: `/_cindy/custom-provider/${firstRoute.routeId}/responses`,
        headers: {},
      };
      await expect(Promise.resolve(firstRoutingTransform(request, requestContext))).resolves.toEqual(
        expect.objectContaining({ upstreamOverride: 'https://first-context.example/v1' }),
      );
      await expect(Promise.resolve(secondRoutingTransform(request, requestContext))).resolves.toEqual(
        expect.objectContaining({ upstreamOverride: 'https://second-context.example/v1' }),
      );

      await host.releaseCodexCustomContextProxy('context-host:1');
      expect(firstDispose).toHaveBeenCalledOnce();
      expect(host.isCodexCustomContextProxyHandleReady('context-host:1')).toBe(false);
      expect(host.isCodexCustomContextProxyHandleReady('context-host:2')).toBe(true);
    } finally {
      await host.releaseCodexCustomContextProxy('context-host:1');
      await host.releaseCodexCustomContextProxy('context-host:2');
      await host.disposeCodexProxy();
      host.setCodexAppliedCustomProviderRoutes([]);
      setCustomProviderKeyReader(() => null);
      setActiveCatalog(BUNDLED_CATALOG);
    }
    expect(secondDispose).toHaveBeenCalledOnce();
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

  it('drops Responses-native search tools before forwarding an ordinary Chat bridge turn', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'qwen-chat-provider',
        name: 'Qwen Chat Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://chat-provider.example/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'chat-provider-key');
    host.registerComposed('session-qwen-chat', 'thread-qwen-chat', 'PRODUCT_PROMPT');
    setSessionProvider('session-qwen-chat', 'qwen-chat-provider');

    const parsedBody = {
      model: 'qwen3.8-max',
      tools: [{ type: 'function', name: 'shell' }, { type: 'web_search' }],
      input: [{ role: 'user', content: 'hello' }],
    };
    const ctx = { reqId: 1, method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-qwen-chat' } };
    const decision = await Promise.resolve(host.createModelRoutingTransform()(parsedBody, ctx));
    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    if (!decision?.localHandler) throw new Error('expected Chat bridge local handler');

    const res = {} as never;
    await decision.localHandler({ rawBody: Buffer.from(JSON.stringify(parsedBody)), parsedBody, ctx, res });
    const bridge = mockState.createResponsesChatHandler.mock.results.at(-1)?.value as
      | { handle: ReturnType<typeof vi.fn> }
      | undefined;
    expect(bridge?.handle).toHaveBeenCalledWith({
      parsedBody: {
        ...parsedBody,
        instructions: 'PRODUCT_PROMPT',
        tools: [{ type: 'function', name: 'shell' }],
      },
      res,
    });

    clearSessionProvider('session-qwen-chat');
    setCustomProviderKeyReader(() => null);
    setCustomProviders([]);
  });

  it('resets a removed search tool choice for Gemini Chat bridge turns', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([
      buildUserProvider({
        id: 'gemini-chat-provider',
        name: 'Gemini Chat Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
            wireProtocol: 'openai-chat',
            models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'gemini-chat-key');
    host.registerComposed('session-gemini-chat', 'thread-gemini-chat', 'PRODUCT_PROMPT');
    setSessionProvider('session-gemini-chat', 'gemini-chat-provider');

    const parsedBody = {
      model: 'gemini-2.5-pro',
      tools: [{ type: 'function', name: 'shell' }, { type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      parallel_tool_calls: true,
      input: [{ role: 'user', content: 'hello' }],
    };
    const ctx = { reqId: 1, method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-gemini-chat' } };
    const decision = await Promise.resolve(host.createModelRoutingTransform()(parsedBody, ctx));
    expect(decision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
    if (!decision?.localHandler) throw new Error('expected Gemini Chat bridge local handler');

    const res = {} as never;
    await decision.localHandler({ rawBody: Buffer.from(JSON.stringify(parsedBody)), parsedBody, ctx, res });
    const bridge = mockState.createResponsesChatHandler.mock.results.at(-1)?.value as
      | { handle: ReturnType<typeof vi.fn> }
      | undefined;
    expect(bridge?.handle).toHaveBeenCalledWith({
      parsedBody: {
        ...parsedBody,
        instructions: 'PRODUCT_PROMPT',
        tools: [{ type: 'function', name: 'shell' }],
        tool_choice: 'auto',
      },
      res,
    });

    clearSessionProvider('session-gemini-chat');
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

  it('keeps the codex/ budget prefix on the wire for an explicit Gateway session (no silent tier rewrite)', async () => {
    const host = await freshCodexProxyHost();
    const { BUNDLED_CATALOG } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    // 显式选 XD 来源（用户在模型选择器里选 codex/gpt-5.6-sol 的实际形态）。
    // 目录必须声明该模型，provider 解析才能命中 xd。
    const catalog = structuredClone(BUNDLED_CATALOG);
    const xd = catalog.providers.find((provider) => provider.id === 'xd');
    if (!xd) throw new Error('expected bundled XD provider');
    xd.models = {
      ...xd.models,
      codex: [{ id: 'codex/gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 372_000, efforts: [], defaultEffort: null }],
    };
    setActiveCatalog(catalog);
    await host.ensureCodexProxyReady();
    host.registerComposed('session-budget-wire', 'thread-budget-wire', 'PRODUCT_PROMPT');
    setSessionProvider('session-budget-wire', 'xd');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = { model: 'codex/gpt-5.6-sol', input: [] };
      const ctx = { method: 'POST', url: '/responses', headers: { 'thread-id': 'thread-budget-wire' } };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }
      // 前缀是网关折扣档标识：wire 上剥掉会把 budget 档静默改道到标准档
      // openai/gpt-5.6-sol（价格数倍）。回归：#2834 曾借 modelIdRewrite 剥掉它。
      expect(current).toMatchObject({ model: 'codex/gpt-5.6-sol' });

      // 路由同源回归：该请求仍应按网关折扣模型换 gateway key，而不是 override 到 ChatGPT。
      host.setCodexProxyAuthInjection('oauth-bearer');
      host.setCodexProxyGatewayKeyReader(() => 'gw-key');
      const routing = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'codex/gpt-5.6-sol', input: [] },
        {
          reqId: 2,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-budget-wire' },
        },
      ));
      expect(routing).toEqual({ headerOverride: { authorization: 'Bearer gw-key' } });
    } finally {
      host.unregister('session-budget-wire');
      clearSessionProvider('session-budget-wire');
      host.setCodexProxyGatewayKeyReader(() => null);
      host.clearCodexProxyAuthInjection();
      setActiveCatalog(BUNDLED_CATALOG);
    }
  });

  it('applies the inherited Gateway route on the first collab_spawn transform pass', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.setCodexProxyAuthInjection('oauth-bearer');
    host.setCodexProxyGatewayKeyReader(() => 'gateway-subagent-key');
    host.registerComposed(
      'session-openai-parent',
      'thread-openai-parent',
      'PRODUCT_PROMPT',
      {
        subagentRoute: {
          providerId: 'xd',
          catalogModel: 'codex/gpt-5.6-sol',
          reasoningEffort: 'max',
        },
      },
    );
    setSessionProvider('session-openai-parent', 'openai');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = { model: 'gpt-5.6-sol' };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: {
          'thread-id': 'thread-gateway-child-first-request',
          'x-openai-subagent': 'collab_spawn',
          'x-codex-parent-thread-id': 'thread-openai-parent',
        },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }
      // 子线程先继承父模型创建；首个请求必须强制切到锁定模型与 effort。
      expect(current).toEqual({
        model: 'codex/gpt-5.6-sol',
        reasoning: { effort: 'max' },
        tools: [{ type: 'web_search' }],
      });
    } finally {
      host.unregister('session-openai-parent');
      clearSessionProvider('session-openai-parent');
      host.setCodexProxyGatewayKeyReader(() => null);
    }
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

    it('first-party xAI 过滤空工具后仍保留 tool_choice:none,避免重新注入的 x_search 被调用', async () => {
      const out = (await runXaiTransforms('none-after-filter', {
        model: 'xai/grok-4.5',
        tools: [{ type: 'namespace', name: 'multi_agent_v1', tools: [] }],
        tool_choice: 'none',
        parallel_tool_calls: false,
        input: [{ role: 'user', content: 'hi' }],
      })) as Record<string, unknown>;

      expect(out.tools).toEqual([{ type: 'x_search' }]);
      expect(out.tool_choice).toBe('none');
      // x_search will be re-injected on this path, so preserve the serial
      // tool-call setting to keep the injected search serial.
      expect(out.parallel_tool_calls).toBe(false);
    });

    it('全量过滤后,对象形态的强制 tool_choice 收敛为 none(不删除、不放宽)', async () => {
      // Every declared tool is unsupported and filtered, while an object-form
      // forced choice still references one of them. The empty-tools branch
      // must collapse the now-dangling forced choice to 'none' (x_search is
      // re-injected afterwards) rather than deleting it — a missing choice
      // would let Grok auto-call the injected search and widen the caller's
      // authorization (PR #2444 Codex P1).
      const out = (await runXaiTransforms('forced-choice-after-full-filter', {
        model: 'xai/grok-4.5',
        tools: [{ type: 'namespace', name: 'multi_agent_v1', tools: [] }],
        tool_choice: { type: 'function', name: 'multi_agent_v1' },
        input: [{ role: 'user', content: 'hi' }],
      })) as Record<string, unknown>;

      expect(out.tools).toEqual([{ type: 'x_search' }]);
      expect(out.tool_choice).toBe('none');
    });

    it('全量过滤后保留 tool_choice:auto(不收敛为 none),让重新注入的 x_search 可被自动选择', async () => {
      // 'auto' is a generic "choose any available tool" — it does not reference
      // a specific (now-filtered) tool. Collapsing it to 'none' would
      // wrongly prevent Grok from auto-calling the re-injected x_search.
      // Distinguish it from forced choices that DO reference removed tools
      // (PR #2444 Codex P2).
      const out = (await runXaiTransforms('auto-after-full-filter', {
        model: 'xai/grok-4.5',
        tools: [{ type: 'namespace', name: 'multi_agent_v1', tools: [] }],
        tool_choice: 'auto',
        input: [{ role: 'user', content: 'hi' }],
      })) as Record<string, unknown>;

      expect(out.tools).toEqual([{ type: 'x_search' }]);
      expect(out.tool_choice).toBe('auto');
    });

    it('first-party xAI cache-only search + tool_choice:none 不注入 x_search 且清理控制字段', async () => {
      const out = (await runXaiTransforms('cache-only-none', {
        model: 'xai/grok-4.5',
        tools: [{ type: 'web_search', external_web_access: false }],
        tool_choice: 'none',
        parallel_tool_calls: false,
        input: [{ role: 'user', content: 'hi' }],
      })) as Record<string, unknown>;

      // cache-only prohibition means x_search must NOT be re-injected, and
      // without re-injected tools the control fields must be cleaned.
      expect(out).not.toHaveProperty('tools');
      expect(out).not.toHaveProperty('tool_choice');
      expect(out).not.toHaveProperty('parallel_tool_calls');
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

    it('强制选择被过滤的 namespace 工具时收敛为 none,不放宽为 auto(即使补了 x_search)', async () => {
      const out = await runXaiTransforms('forced-filtered', {
        model: 'xai/grok-4.5',
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] },
        ],
        tool_choice: { type: 'namespace', name: 'multi_agent_v1' },
        input: [{ role: 'user', content: 'hi' }],
      }) as Record<string, unknown>;

      // The forced namespace choice references a removed tool. Fail closed to
      // 'none' even though x_search gets re-injected and exec_command survives —
      // widening to 'auto' would let Grok call tools the caller never selected.
      expect(out.tools).toEqual([
        { type: 'function', name: 'exec_command' },
        { type: 'x_search' },
      ]);
      expect(out.tool_choice).toBe('none');
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

  it('sanitizes ModelInput for gateway grok without an xAI subscription session', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-gateway-grok', 'thread-gateway-grok', 'PRODUCT_PROMPT');
    setSessionProvider('session-gateway-grok', 'xd');

    const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
    let current: unknown = {
      model: 'x-ai/grok-4.5',
      input: [
        { type: 'message', role: 'user', content: 'go' },
        {
          type: 'agent_message',
          author: '/root',
          content: [{ type: 'input_text', text: 'done' }],
        },
        {
          type: 'reasoning',
          id: 'rs_1',
          content: null,
          encrypted_content: 'BLOB',
        },
      ],
    };
    const ctx = {
      method: 'POST',
      url: '/responses',
      headers: { 'thread-id': 'thread-gateway-grok' },
    };
    for (const transform of transforms) {
      const next = transform(current, ctx);
      if (next !== null && next !== undefined) current = next;
    }

    const input = (current as { input: Array<Record<string, unknown>> }).input;
    expect(input).toEqual(expect.arrayContaining([
      { type: 'message', role: 'user', content: 'go' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '[collab /root]\ndone' }],
      },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'BLOB' },
    ]));
    expect(input.some((item) => item.type === 'agent_message')).toBe(false);
    expect(JSON.stringify(current)).not.toContain('"content":null');
    clearSessionProvider('session-gateway-grok');
  });

  it.each(['x-ai/grok-code-fast', 'x-ai/grok-build-0.1'])(
    'drops reasoning for gateway non-reasoning model %s',
    async (model) => {
      const host = await freshCodexProxyHost();
      const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
      mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
        url: 'http://127.0.0.1:43210',
        dispose: vi.fn(async () => undefined),
      });
      await host.ensureCodexProxyReady();
      const sessionId = `session-gateway-${model}`;
      const threadId = `thread-gateway-${model}`;
      host.registerComposed(sessionId, threadId, 'PRODUCT_PROMPT');
      setSessionProvider(sessionId, 'xd');

      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model,
        input: [
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'BLOB' },
          { type: 'message', role: 'user', content: 'hi' },
        ],
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': threadId },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      const input = (current as { input: Array<Record<string, unknown>> }).input;
      expect(input.some((item) => item.type === 'reasoning')).toBe(false);
      expect(input).toEqual(expect.arrayContaining([
        { type: 'message', role: 'user', content: 'hi' },
      ]));
      clearSessionProvider(sessionId);
    },
  );

  it('registers a ModelInput 422 recovery rule for LiteLLM-wrapped xAI errors', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    const rules = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.recoveryRules ?? [];
    const rule = rules.find((candidate: { id?: string }) => candidate.id === 'xai_model_input');
    expect(rule).toBeDefined();
    expect(rule.matches(
      'unexpected status 422 Unprocessable Entity: litellm.BadRequestError: XaiException - '
      + '{"error":"Failed to deserialize the JSON body into the target type: '
      + 'data did not match any variant of untagged enum ModelInput"}',
    )).toBe(true);
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

  it('round-trips exec for a custom Responses Provider that lacks native custom tools', async () => {
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setCustomProviders([buildUserProvider({
      id: 'stealth',
      name: 'Stealth',
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:43168/v1',
          wireProtocol: 'openai-responses',
          models: [{ id: 'stealth/ox-alpha', name: 'OX Alpha' }],
        },
      },
    })]);
    host.registerComposed('session-stealth-exec', 'thread-stealth-exec', 'PRODUCT_PROMPT');
    setSessionProvider('session-stealth-exec', 'stealth');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    try {
      await host.ensureCodexProxyReady();

      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'stealth/ox-alpha',
        tools: [
          { type: 'custom', name: 'exec', description: 'run a command' },
          { type: 'custom', name: 'apply_patch', description: 'edit files' },
          { type: 'function', name: 'read_file', parameters: { type: 'object' } },
        ],
        tool_choice: { type: 'custom', name: 'exec' },
        input: [
          { type: 'custom_tool_call', id: 'ctc_1', status: 'completed',
            name: 'exec', call_id: 'old_call', input: 'text("old")' },
          { type: 'custom_tool_call_output', call_id: 'old_call', output: 'old result' },
        ],
      };
      const ctx = {
        reqId: 3168,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-stealth-exec' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toMatchObject({
        tools: [
          expect.objectContaining({
            type: 'function',
            name: 'exec',
            description: expect.stringContaining('run a command'),
            parameters: expect.objectContaining({ type: 'object', required: ['input'] }),
          }),
          { type: 'custom', name: 'apply_patch', description: 'edit files' },
          { type: 'function', name: 'read_file', parameters: { type: 'object' } },
        ],
        tool_choice: { type: 'function', name: 'exec' },
        input: [
          // `ctc_1` becomes `fc_1`: a Responses upstream validates an item's id prefix against
          // its type, so flipping the dialect without flipping the prefix is rejected with 400.
          expect.objectContaining({
            type: 'function_call', id: 'fc_1', status: 'completed', name: 'exec',
            arguments: '{"input":"text(\\"old\\")"}',
          }),
          { type: 'function_call_output', call_id: 'old_call', output: 'old result' },
        ],
      });

      const responseTransform = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformResponse({
        reqId: 3168,
        responseHeaders: { 'content-type': 'text/event-stream' },
      });
      const chunks: Buffer[] = [];
      responseTransform.on('data', (chunk: Buffer) => chunks.push(chunk));
      const completed = new Promise<void>((resolve, reject) => {
        responseTransform.once('end', resolve);
        responseTransform.once('error', reject);
      });
      const call = { type: 'function_call', name: 'exec', call_id: 'call_exec', arguments: '' };
      responseTransform.end([
        { type: 'response.output_item.added', output_index: 0, item: call },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0,
          arguments: '{"input":"text(\\"local\\")"}' },
        { type: 'response.output_item.done', output_index: 0,
          item: { ...call, arguments: '{"input":"text(\\"local\\")"}' } },
      ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''));
      await completed;
      const events = Buffer.concat(chunks).toString('utf8').split('\n')
        .filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
      expect(events.map((event) => event.type)).toEqual([
        'response.output_item.added',
        'response.custom_tool_call_input.delta',
        'response.custom_tool_call_input.done',
        'response.output_item.done',
      ]);
      expect(events[1]).toMatchObject({ item_id: 'fc_1', delta: 'text("local")' });
      expect(events[3].item).toEqual({
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call_exec',
        input: 'text("local")',
      });
    } finally {
      host.unregister('session-stealth-exec');
      clearSessionProvider('session-stealth-exec');
      setCustomProviders([]);
    }
  });

  it('adapts exec when env-key falls through a built-in OpenAI session to XD', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    host.setCodexProxyAuthInjection('env-key');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-openai-envkey-exec', 'thread-openai-envkey-exec', 'PRODUCT_PROMPT');
    setSessionProvider('session-openai-envkey-exec', 'openai');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'gpt-5.5',
        tools: [
          { type: 'custom', name: 'exec', description: 'run a command' },
          { type: 'function', name: 'read_file', parameters: { type: 'object' } },
        ],
        tool_choice: { type: 'custom', name: 'exec' },
      };
      const ctx = {
        reqId: 3262,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-openai-envkey-exec' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toMatchObject({
        tools: [
          expect.objectContaining({
            type: 'function',
            name: 'exec',
            parameters: expect.objectContaining({ required: ['input'] }),
          }),
          { type: 'function', name: 'read_file', parameters: { type: 'object' } },
        ],
        tool_choice: expect.objectContaining({ type: 'function' }),
      });
    } finally {
      host.unregister('session-openai-envkey-exec');
      clearSessionProvider('session-openai-envkey-exec');
    }
  });

  it('keeps native exec when oauth-bearer adopts the built-in OpenAI session', async () => {
    const host = await freshCodexProxyHost();
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    host.setCodexProxyAuthInjection('oauth-bearer');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-openai-oauth-exec', 'thread-openai-oauth-exec', 'PRODUCT_PROMPT');
    setSessionProvider('session-openai-oauth-exec', 'openai');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'gpt-5.5',
        tools: [{ type: 'custom', name: 'exec', description: 'run a command' }],
        tool_choice: { type: 'custom', name: 'exec' },
      };
      const ctx = {
        reqId: 3263,
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-openai-oauth-exec' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toMatchObject({
        tools: [{ type: 'custom', name: 'exec' }],
        tool_choice: { type: 'custom', name: 'exec' },
      });
    } finally {
      host.unregister('session-openai-oauth-exec');
      clearSessionProvider('session-openai-oauth-exec');
    }
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

  it('drops Codex namespace tools for XD Gateway Grok models', async () => {
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{ id: 'x-ai/grok-4.5', agents: ['codex'] }]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xd-grok', 'thread-xd-grok', 'PRODUCT_PROMPT');
    setSessionProvider('session-xd-grok', 'xd');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] },
          { type: 'web_search', external_web_access: true },
        ],
        tool_choice: { type: 'namespace', name: 'multi_agent_v1' },
        parallel_tool_calls: false,
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-grok' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toEqual({
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'web_search' },
        ],
        // The forced namespace choice references a removed tool; fail closed to
        // 'none' rather than widening to 'auto' (which would let Grok call the
        // surviving exec_command/web_search the caller never selected).
        tool_choice: 'none',
        parallel_tool_calls: false,
      });
    } finally {
      clearSessionProvider('session-xd-grok');
      setXdGatewayModels([]);
    }
  });

  it('still sanitizes implicit-session Grok namespace tools while the gateway catalog is non-authoritative', async () => {
    // A pending/failed /models fetch leaves xdGatewayModelsAuthoritative=false
    // with an empty list. The empty list must NOT be used as negative evidence
    // for an implicit session (no explicit provider): the env-key default route
    // still sends it to XD, so leaving namespace tools untouched would re-trigger
    // the schema 400 (PR #2444 Codex P1).
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels, markXdGatewayModelAccessUnknown } = await import('../active-catalog.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([]);
    markXdGatewayModelAccessUnknown();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xd-grok-implicit', 'thread-xd-grok-implicit', 'PRODUCT_PROMPT');
    clearSessionProvider('session-xd-grok-implicit');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] },
        ],
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-grok-implicit' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toMatchObject({
        model: 'x-ai/grok-4.5',
        tools: [{ type: 'function', name: 'exec_command' }],
      });
    } finally {
      clearSessionProvider('session-xd-grok-implicit');
      setXdGatewayModels([], { authoritative: false });
    }
  });

  it('sanitizes out-of-scope x-ai/grok tools even when the session belongs to a non-xd provider', async () => {
    // A provider-oauth xAI session that sends an `x-ai/grok*` request falls
    // through the xAI scope gate (xAI modelPrefixes cover `xai/`, not the
    // gateway's `x-ai/` namespace) and is routed back to the XD Gateway by
    // gatewayDefaultRouteDecision. The compat transform must still clean the
    // namespace tools; returning early just because providerId === 'xai' left
    // them untouched and re-triggered the Grok schema 400 (PR #2444 Codex P2).
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{ id: 'x-ai/grok-4.5', agents: ['codex'] }], { authoritative: true });
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xai-grok-fallback', 'thread-xai-grok-fallback', 'PRODUCT_PROMPT');
    setSessionProvider('session-xai-grok-fallback', 'xai');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] },
        ],
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xai-grok-fallback' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toMatchObject({
        model: 'x-ai/grok-4.5',
        tools: [{ type: 'function', name: 'exec_command' }],
      });
    } finally {
      clearSessionProvider('session-xai-grok-fallback');
      setXdGatewayModels([]);
    }
  });

  it('cleans Grok namespace tools for a built-in openai session under env-key (passthrough to XD)', async () => {
    // Under env-key auth injection, a built-in session provider (e.g. the
    // default `openai` catalog entry with universal routing) is NOT adopted by
    // the router; an x-ai/grok* request passes through to the default XD
    // Gateway. The compat transform must still clean namespace tools even
    // though providerRoutingServesWireModel returns true for the universal
    // openai routing — trusting it would leave the tools untouched and
    // re-trigger the Grok schema 400 (PR #2444 Codex P2).
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{ id: 'x-ai/grok-4.5', agents: ['codex'] }], { authoritative: true });
    host.setCodexProxyAuthInjection('env-key');
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-openai-envkey', 'thread-openai-envkey', 'PRODUCT_PROMPT');
    setSessionProvider('session-openai-envkey', 'openai');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] },
        ],
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-openai-envkey' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toMatchObject({
        model: 'x-ai/grok-4.5',
        tools: [{ type: 'function', name: 'exec_command' }],
      });
    } finally {
      clearSessionProvider('session-openai-envkey');
      setXdGatewayModels([]);
    }
  });

  it('drops Grok search when live web access is explicitly disabled', async () => {
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{ id: 'x-ai/grok-4.5', agents: ['codex'] }]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xd-grok-no-live-search', 'thread-xd-grok-no-live-search', 'PRODUCT_PROMPT');
    setSessionProvider('session-xd-grok-no-live-search', 'xd');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'exec_command' },
          { type: 'web_search', external_web_access: false },
        ],
        tool_choice: { type: 'web_search' },
        parallel_tool_calls: true,
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-grok-no-live-search' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toEqual({
        model: 'x-ai/grok-4.5',
        tools: [{ type: 'function', name: 'exec_command' }],
        // The forced web_search choice was dropped (cache-only prohibition);
        // collapsing to 'none' keeps exec_command uncallable instead of
        // silently widening the request to auto-selected tool calls.
        tool_choice: 'none',
        parallel_tool_calls: true,
      });
    } finally {
      clearSessionProvider('session-xd-grok-no-live-search');
      setXdGatewayModels([]);
    }
  });

  it('removes Grok tool controls when every declared tool is unsupported', async () => {
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{ id: 'x-ai/grok-4.5', agents: ['codex'] }]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xd-grok-no-tools', 'thread-xd-grok-no-tools', 'PRODUCT_PROMPT');
    setSessionProvider('session-xd-grok-no-tools', 'xd');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [{ type: 'namespace', name: 'multi_agent_v1', tools: [] }],
        tool_choice: 'none',
        parallel_tool_calls: false,
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-grok-no-tools' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toEqual({ model: 'x-ai/grok-4.5' });
    } finally {
      clearSessionProvider('session-xd-grok-no-tools');
      setXdGatewayModels([]);
    }
  });

  it('preserves surviving allowed_tools choices after Grok sanitization', async () => {
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { setSessionProvider, clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{ id: 'x-ai/grok-4.5', agents: ['codex'] }]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xd-grok-allowed-tools', 'thread-xd-grok-allowed-tools', 'PRODUCT_PROMPT');
    setSessionProvider('session-xd-grok-allowed-tools', 'xd');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'read_file' },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] },
        ],
        tool_choice: {
          type: 'allowed_tools',
          mode: 'required',
          tools: [
            { type: 'function', name: 'read_file' },
            { type: 'namespace', name: 'multi_agent_v1' },
          ],
        },
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-xd-grok-allowed-tools' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toMatchObject({
        tools: [{ type: 'function', name: 'read_file' }],
        tool_choice: {
          type: 'allowed_tools',
          mode: 'required',
          tools: [{ type: 'function', name: 'read_file' }],
        },
      });
    } finally {
      clearSessionProvider('session-xd-grok-allowed-tools');
      setXdGatewayModels([]);
    }
  });

  it('sanitizes XD Gateway Grok namespace tools when parent session is on a different provider', async () => {
    // A subagent can be frozen to x-ai/grok via the catalog even though its
    // parent session belongs to the default ChatGPT provider. The routing
    // transform claims this request for xd; the compat transform must match.
    const host = await freshCodexProxyHost();
    const { setXdGatewayModels } = await import('../active-catalog.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    setXdGatewayModels([{ id: 'x-ai/grok-4.5', agents: ['codex'] }]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    // Deliberately do NOT set session provider to xd — simulate parent on
    // default provider while subagent targets Grok.
    host.registerComposed('session-default', 'thread-default', 'PRODUCT_PROMPT');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'read_file' },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] },
        ],
        tool_choice: 'auto',
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-default' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      // namespace tool must be stripped even though session provider is not xd,
      // because the xd catalog claims this wire model.
      expect(current).toMatchObject({
        tools: [{ type: 'function', name: 'read_file' }],
      });
    } finally {
      clearSessionProvider('session-default');
      setXdGatewayModels([]);
    }
  });

  it('still cleans XD Gateway Grok tools on an implicit session even when a non-xd provider lists the same id', async () => {
    // Regression: when providerId is null (implicit session) and a custom
    // provider also declares x-ai/grok-* in its catalog, the old nonXdHandoff
    // check skipped cleanup — but merely listing the id does not route THIS
    // request there (an explicit selection would set a non-null providerId).
    // The implicit default/env-key route still lands on the xd gateway, so the
    // namespace tools must be stripped.
    const host = await freshCodexProxyHost();
    const { buildUserProvider } = await import('@cindy/model-providers');
    const { setCustomProviders, setXdGatewayModels } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    setXdGatewayModels([{ id: 'x-ai/grok-4.5', agents: ['codex'] }]);
    setCustomProviders([
      buildUserProvider({
        id: 'grok-alias-provider',
        name: 'Grok Alias Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://grok-alias.example/v1',
            wireProtocol: 'openai-responses',
            models: [{ id: 'x-ai/grok-4.5', name: 'Grok 4.5' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => null);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-implicit-alias', 'thread-implicit-alias', 'PRODUCT_PROMPT');

    try {
      const transforms = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]?.transformRequest ?? [];
      let current: unknown = {
        model: 'x-ai/grok-4.5',
        tools: [
          { type: 'function', name: 'read_file' },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] },
        ],
        tool_choice: { type: 'namespace', name: 'multi_agent_v1' },
      };
      const ctx = {
        method: 'POST',
        url: '/responses',
        headers: { 'thread-id': 'thread-implicit-alias' },
      };
      for (const transform of transforms) {
        const next = transform(current, ctx);
        if (next !== null && next !== undefined) current = next;
      }

      expect(current).toMatchObject({
        tools: [{ type: 'function', name: 'read_file' }],
        tool_choice: 'none',
      });
    } finally {
      setCustomProviders([]);
      setCustomProviderKeyReader(() => null);
      setXdGatewayModels([]);
    }
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
    const { BUNDLED_CATALOG } = await import('@cindy/model-providers');
    const { setActiveCatalog, setXaiDiscoveredModels } = await import('../active-catalog.js');
    const { clearSessionProvider } = await import('../session-provider-store.js');
    setActiveCatalog(BUNDLED_CATALOG);
    setXaiDiscoveredModels([{ id: 'xai/grok-code-fast' }]);
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    host.registerComposed('session-xai-implicit', 'thread-xai-implicit', 'PRODUCT_PROMPT');
    clearSessionProvider('session-xai-implicit');

    try {
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
    } finally {
      setXaiDiscoveredModels(null);
      setActiveCatalog(BUNDLED_CATALOG);
    }
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
    expect(transforms).toHaveLength(21); // encrypted activeStrip, image generation activeStrip, provider-aware Guardian reviewer, locked Subagent route, instructions 注入, locked Subagent exec guard, Gateway 原生 web_search, 跨来源压缩块兼容, xAI ModelInput activeStrip, exec function adapter, strict gateway history 兼容, xAI ModelInput sanitize, DeepSeek V4 custom tool 兼容, xAI Responses 兼容, XD Gateway Grok 兼容, ByteDance Seed tool 兼容, MiniMax effort 兼容, provider model rewrite, 视觉桥(短路), stripNonAnthropicFields, dump
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

/**
 * 额度回调的安装门(#2626)。桥的 localHandler 绕开 compat-proxy 的转发层, 转发层上的
 * rate-limit observer 看不到这些响应, 只能由 host 在这里回喂 —— 但必须只对
 * 「内置 Anthropic + 订阅 OAuth + 官方 hostname」这一种路由安装, 其余形态误装会把
 * 别的账号 / 别的上游的数据写进 Claude 订阅快照。
 */
describe('createModelRoutingTransform —— Anthropic 桥的额度回调安装门', () => {
  it('installs the quota callback for builtin Anthropic subscription OAuth and feeds the shared recorder', async () => {
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
    const {
      resetClaudeRateLimitHeadersDedup,
      setClaudeRateLimitHeadersListener,
    } = await import('../claude-rate-limit-headers-observer.js');

    const model: import('@cindy/model-providers').CatalogModel = {
      id: 'claude-quota-callback',
      name: 'Quota Callback',
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
      providerId === 'anthropic' && agent === 'codex' ? 'claude-subscription-token' : null
    ));
    host.registerComposed('session-quota-callback', 'thread-quota-callback', 'PRODUCT_PROMPT');
    clearSessionProvider('session-quota-callback');
    host.setCodexProxyGatewayKeyReader(() => null);
    host.setCodexProxyAuthInjection('oauth-bearer');
    resetClaudeRateLimitHeadersDedup();
    const listener = vi.fn();
    setClaudeRateLimitHeadersListener(listener);

    try {
      await Promise.resolve(host.createModelRoutingTransform()(
        { model: model.id, input: [{ role: 'user', content: 'hello' }] },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-quota-callback' },
        },
      ));

      const config = (mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
        {
          onUpstreamResponse?: (info: {
            status: number;
            responseHeaders: Headers;
            requestHeaders: Readonly<Record<string, string>>;
          }) => void;
        },
      ]>).at(-1)?.[0];
      expect(config?.onUpstreamResponse).toBeTypeOf('function');

      // 回调真的把 headers 喂到了共用入口 —— 只断言「装上了」会漏掉接错线的情形。
      config?.onUpstreamResponse?.({
        status: 200,
        responseHeaders: new Headers({
          'anthropic-ratelimit-unified-5h-utilization': '0.34',
          'anthropic-ratelimit-unified-status': 'allowed',
        }),
        requestHeaders: { authorization: 'Bearer claude-subscription-token' },
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].fiveHour.utilization).toBeCloseTo(34, 5);
      expect(listener.mock.calls[0][0].source).toBe('unified-headers');
      expect(listener.mock.calls[0][1]).toBe('claude-subscription-token');
    } finally {
      host.unregister('session-quota-callback');
      clearSessionProvider('session-quota-callback');
      setProviderOAuthTokenReader(() => null);
      setProviderViewsReader(async () => []);
      setAnthropicDiscoveredModels([]);
      setXdGatewayModels([]);
      host.setCodexProxyGatewayKeyReader(() => null);
      setClaudeRateLimitHeadersListener(() => undefined);
    }
  });

  it('does not install it for a custom anthropic-compatible provider on an API key', async () => {
    const host = await freshCodexProxyHost();
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
    host.registerComposed('session-quota-gate-custom', 'thread-quota-gate-custom', 'PRODUCT_PROMPT');
    setSessionProvider('session-quota-gate-custom', 'anthropic-compatible');
    host.setCodexProxyAuthInjection('env-key');

    try {
      await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'claude-compatible' },
        {
          reqId: 1,
          method: 'POST',
          url: '/responses',
          headers: { 'thread-id': 'thread-quota-gate-custom' },
        },
      ));

      const config = (mockState.createResponsesAnthropicHandler.mock.calls as unknown as Array<[
        { upstreamBase: string; onUpstreamResponse?: unknown },
      ]>).at(-1)?.[0];
      expect(config?.upstreamBase).toBe('https://messages.provider.example/v1');
      // 非官方 hostname + 非订阅 OAuth:两道门任一不满足都不装
      expect(config?.onUpstreamResponse).toBeUndefined();
    } finally {
      host.unregister('session-quota-gate-custom');
      clearSessionProvider('session-quota-gate-custom');
      setCustomProviders([]);
      setCustomProviderKeyReader(() => null);
    }
  });
});

describe('createModelRoutingTransform —— custom Provider native imagegen prefix', () => {
  it('routes generate/edit to the selected custom Provider and strips internal actor auth', async () => {
    const host = await freshCodexProxyHost();
    const { BUNDLED_CATALOG, buildUserProvider } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { deriveCodexCustomProviderRoutes } = await import('../codex-custom-provider-route.js');
    const provider = buildUserProvider({
      id: 'image-provider',
      name: 'Image Provider',
      runtimes: {
        codex: {
          baseUrl: 'https://images.example/v1',
          requestPath: '/v1/responses',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [
            { id: 'chat-image', name: 'Chat Image' },
            { id: 'chat-text', name: 'Chat Text', supportsImageInput: true },
          ],
        },
      },
    });
    const catalog = { ...BUNDLED_CATALOG, providers: [...BUNDLED_CATALOG.providers, provider] };
    setActiveCatalog(catalog);
    setCustomProviderKeyReader(() => 'provider-key');
    const route = deriveCodexCustomProviderRoutes(catalog)[0]!;
    host.setCodexAppliedCustomProviderRoutes([route]);

    try {
      const imageDecision = await Promise.resolve(
        host.createModelRoutingTransform()(
          { model: 'gpt-image-2', prompt: 'draw' },
          {
            reqId: 1,
            method: 'POST',
            url: `/_cindy/custom-provider/${route.routeId}/images/generations`,
            headers: {
              authorization: 'Bearer chatgpt-oauth',
              'chatgpt-account-id': 'account',
              'x-openai-actor-authorization': 'local-image-extension',
            },
          },
        ),
      );
      expect(imageDecision).toEqual(
        expect.objectContaining({
          upstreamOverride: 'https://images.example/v1',
          pathOverride: '/images/generations',
          headerOverride: expect.objectContaining({ authorization: 'Bearer provider-key' }),
          headerDelete: expect.arrayContaining([
            'chatgpt-account-id',
            'x-openai-actor-authorization',
          ]),
        }),
      );

      const responseDecision = await Promise.resolve(
        host.createModelRoutingTransform()(
          { model: 'chat-image', input: [] },
          {
            reqId: 2,
            method: 'POST',
            url: `/_cindy/custom-provider/${route.routeId}/responses`,
            headers: { authorization: 'Bearer placeholder' },
          },
        ),
      );
      expect(responseDecision).toEqual(
        expect.objectContaining({
          upstreamOverride: 'https://images.example/v1',
          pathOverride: '/responses',
        }),
      );

      const secondModelDecision = await Promise.resolve(
        host.createModelRoutingTransform()(
          { model: 'chat-text', input: [] },
          {
            reqId: 3,
            method: 'POST',
            url: `/_cindy/custom-provider/${route.routeId}/responses`,
            headers: {},
          },
        ),
      );
      expect(secondModelDecision).toEqual(
        expect.objectContaining({
          upstreamOverride: 'https://images.example/v1',
          pathOverride: '/responses',
        }),
      );
    } finally {
      setCustomProviderKeyReader(() => null);
      host.setCodexAppliedCustomProviderRoutes([]);
      setActiveCatalog(BUNDLED_CATALOG);
    }
  });

  it('keeps auth-none, generic OAuth, and Provider-owned actor headers isolated on the prefix', async () => {
    const host = await freshCodexProxyHost();
    const { BUNDLED_CATALOG, buildUserProvider } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const {
      setCustomProviderHeaderReader,
      setCustomProviderKeyReader,
      setOAuthTokenReader,
    } = await import('../provider-route.js');
    const { deriveCodexCustomProviderRoutes } = await import('../codex-custom-provider-route.js');
    const providers = [
      buildUserProvider({
        id: 'none-images',
        name: 'None Images',
        auth: { method: 'none' },
        runtimes: {
          codex: {
            baseUrl: 'http://127.0.0.1:44551/v1',
            wireProtocol: 'openai-responses',
            supportsImageGeneration: true,
            models: [{ id: 'none-image', name: 'None Image' }],
          },
        },
      }),
      buildUserProvider({
        id: 'oauth-images',
        name: 'OAuth Images',
        auth: {
          method: 'oauth',
          oauth: {
            authorizeUrl: 'https://oauth-images.example/authorize',
            tokenUrl: 'https://oauth-images.example/token',
            clientId: 'public-client',
            scopes: 'images',
          },
        },
        runtimes: {
          codex: {
            baseUrl: 'https://oauth-images.example/v1',
            wireProtocol: 'openai-responses',
            supportsImageGeneration: true,
            models: [{ id: 'oauth-image', name: 'OAuth Image' }],
          },
        },
      }),
      buildUserProvider({
        id: 'actor-images',
        name: 'Actor Images',
        runtimes: {
          codex: {
            baseUrl: 'https://actor-images.example/v1',
            wireProtocol: 'openai-responses',
            supportsImageGeneration: true,
            headers: { 'X-OpenAI-Actor-Authorization': 'provider-owned-actor' },
            models: [{ id: 'actor-image', name: 'Actor Image' }],
          },
        },
      }),
    ];
    const catalog = {
      ...BUNDLED_CATALOG,
      providers: [...BUNDLED_CATALOG.providers, ...providers],
    };
    const routes = deriveCodexCustomProviderRoutes(catalog);
    setActiveCatalog(catalog);
    setCustomProviderKeyReader(() => 'fake-api-key');
    setCustomProviderHeaderReader((providerId) =>
      providerId === 'actor-images'
        ? { 'X-OpenAI-Actor-Authorization': 'provider-owned-actor' }
        : null,
    );
    setOAuthTokenReader(() => 'fake-oauth-token');
    host.setCodexAppliedCustomProviderRoutes(routes);

    try {
      const decisionFor = (providerId: string) => {
        const route = routes.find((candidate) => candidate.providerId === providerId)!;
        return Promise.resolve(host.createModelRoutingTransform()(
          { model: 'gpt-image-2' },
          {
            reqId: 1,
            method: 'POST',
            url: `/_cindy/custom-provider/${route.routeId}/images/generations`,
            headers: {
              authorization: 'Bearer loopback-placeholder',
              'x-openai-actor-authorization': 'local-image-extension',
            },
          },
        ));
      };
      const none = await decisionFor('none-images');
      expect(none).toEqual(expect.objectContaining({
        upstreamOverride: 'http://127.0.0.1:44551/v1',
        headerDelete: expect.arrayContaining([
          'authorization',
          'x-openai-actor-authorization',
        ]),
      }));
      expect(none?.headerOverride?.authorization).toBeUndefined();

      none?.forwardLifecycle?.onStart?.();
      none?.forwardLifecycle?.onFailure?.('retry-rejected');
      const noneLifecycleLogs = [
        ...mockState.logger.info.mock.calls,
        ...mockState.logger.warn.mock.calls,
      ]
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('codex_image_generation_forward_'));
      expect(noneLifecycleLogs).toHaveLength(2);
      expect(JSON.stringify(noneLifecycleLogs)).not.toContain('authSource');
      expect(noneLifecycleLogs[1]).toContain('outcome       : local_retry_rejected');

      const oauth = await decisionFor('oauth-images');
      expect(oauth).toEqual(expect.objectContaining({
        upstreamOverride: 'https://oauth-images.example/v1',
        headerOverride: expect.objectContaining({ authorization: 'Bearer fake-oauth-token' }),
        headerDelete: expect.arrayContaining(['x-openai-actor-authorization']),
      }));

      const actor = await decisionFor('actor-images');
      expect(actor).toEqual(expect.objectContaining({
        headerOverride: expect.objectContaining({
          authorization: 'Bearer fake-api-key',
          'x-openai-actor-authorization': 'provider-owned-actor',
        }),
      }));
      expect(actor?.headerDelete ?? []).not.toContain('x-openai-actor-authorization');
    } finally {
      host.setCodexAppliedCustomProviderRoutes([]);
      setCustomProviderHeaderReader(() => null);
      setCustomProviderKeyReader(() => null);
      setOAuthTokenReader(() => null);
      setActiveCatalog(BUNDLED_CATALOG);
    }
  });

  it('rejects malformed, deleted and stale prefixed routes without falling back', async () => {
    const host = await freshCodexProxyHost();
    const invalid = await Promise.resolve(
      host.createModelRoutingTransform()(
        { model: 'gpt-image-2' },
        {
          reqId: 1,
          method: 'POST',
          url: '/_cindy/custom-provider/not-a-route/images/edits',
          headers: {},
        },
      ),
    );
    expect(invalid).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));

    const deleted = await Promise.resolve(
      host.createModelRoutingTransform()(
        { model: 'gpt-image-2' },
        {
          reqId: 2,
          method: 'POST',
          url: '/_cindy/custom-provider/0123456789abcdefabcd/images/edits',
          headers: {},
        },
      ),
    );
    expect(deleted).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));
  });

  it('gates image endpoints by the frozen capability while keeping generic Responses routing', async () => {
    const host = await freshCodexProxyHost();
    const { BUNDLED_CATALOG, buildUserProvider } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { deriveCodexCustomProviderRoutes } = await import('../codex-custom-provider-route.js');
    const provider = buildUserProvider({
      id: 'future-capability-provider',
      name: 'Future Capability Provider',
      runtimes: {
        codex: {
          baseUrl: 'https://future-capability.example/v1',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [{ id: 'future-chat', name: 'Future Chat' }],
        },
      },
    });
    const catalog = {
      ...BUNDLED_CATALOG,
      providers: [...BUNDLED_CATALOG.providers, provider],
    };
    const route = deriveCodexCustomProviderRoutes(catalog)[0]!;
    const futureOnlyRoute = {
      ...route,
      capabilities: { imageGeneration: false, futureCapabilityFixture: true },
    };
    setActiveCatalog(catalog);
    setCustomProviderKeyReader(() => 'future-provider-key');
    host.setCodexAppliedCustomProviderRoutes([futureOnlyRoute]);

    try {
      const imageDecision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'gpt-image-2' },
        {
          reqId: 1,
          method: 'POST',
          url: `/_cindy/custom-provider/${route.routeId}/images/generations`,
          headers: {},
        },
      ));
      expect(imageDecision).toEqual(
        expect.objectContaining({ localHandler: expect.any(Function) }),
      );

      const responseDecision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'future-chat', input: [] },
        {
          reqId: 2,
          method: 'POST',
          url: `/_cindy/custom-provider/${route.routeId}/responses`,
          headers: {},
        },
      ));
      expect(responseDecision).toEqual(expect.objectContaining({
        upstreamOverride: 'https://future-capability.example/v1',
        pathOverride: '/responses',
      }));
    } finally {
      host.setCodexAppliedCustomProviderRoutes([]);
      setCustomProviderKeyReader(() => null);
      setActiveCatalog(BUNDLED_CATALOG);
    }
  });

  it('keeps the running Host snapshot during capability/model changes and fails closed after deletion', async () => {
    const host = await freshCodexProxyHost();
    const { BUNDLED_CATALOG, buildUserProvider } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const { setCustomProviderKeyReader } = await import('../provider-route.js');
    const { deriveCodexCustomProviderRoutes } = await import('../codex-custom-provider-route.js');
    const beforeProvider = buildUserProvider({
      id: 'busy-image-provider',
      name: 'Busy Image Provider',
      runtimes: {
        codex: {
          baseUrl: 'https://busy-images.example/v1',
          requestPath: '/v1/responses',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [{ id: 'old-image-chat', name: 'Old Image Chat' }],
        },
      },
    });
    const beforeCatalog = {
      ...BUNDLED_CATALOG,
      providers: [...BUNDLED_CATALOG.providers, beforeProvider],
    };
    const route = deriveCodexCustomProviderRoutes(beforeCatalog)[0]!;
    setActiveCatalog(beforeCatalog);
    setCustomProviderKeyReader(() => 'provider-key');
    host.setCodexAppliedCustomProviderRoutes([route]);

    try {
      // Settings is already ahead (last true cancelled and model list replaced),
      // while a busy turn still runs on the old app-server snapshot.
      const changedProvider = buildUserProvider({
        id: 'busy-image-provider',
        name: 'Busy Image Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://busy-images.example/v1',
            requestPath: '/v1/responses',
            wireProtocol: 'openai-responses',
            models: [{ id: 'new-text-chat', name: 'New Text Chat' }],
          },
        },
      });
      setActiveCatalog({
        ...BUNDLED_CATALOG,
        providers: [...BUNDLED_CATALOG.providers, changedProvider],
      });

      const oldTurnDecision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'old-image-chat', input: [] },
        {
          reqId: 1,
          method: 'POST',
          url: `/_cindy/custom-provider/${route.routeId}/responses`,
          headers: {},
        },
      ));
      expect(oldTurnDecision).toEqual(expect.objectContaining({
        upstreamOverride: 'https://busy-images.example/v1',
        pathOverride: '/responses',
      }));

      // Provider deletion is an irrecoverable boundary: retain the prefix
      // ownership but reject locally, never fall through to Gateway/ChatGPT.
      setActiveCatalog(BUNDLED_CATALOG);
      const deletedDecision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'gpt-image-2' },
        {
          reqId: 2,
          method: 'POST',
          url: `/_cindy/custom-provider/${route.routeId}/images/edits`,
          headers: {},
        },
      ));
      expect(deletedDecision).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));

      // Once the hard cut applies the new Host snapshot, the old prefix stops selecting.
      host.setCodexAppliedCustomProviderRoutes([]);
      const afterRestartDecision = await Promise.resolve(host.createModelRoutingTransform()(
        { model: 'gpt-image-2' },
        {
          reqId: 3,
          method: 'POST',
          url: `/_cindy/custom-provider/${route.routeId}/images/generations`,
          headers: {},
        },
      ));
      expect(afterRestartDecision).toEqual(
        expect.objectContaining({ localHandler: expect.any(Function) }),
      );
    } finally {
      host.setCodexAppliedCustomProviderRoutes([]);
      setCustomProviderKeyReader(() => null);
      setActiveCatalog(BUNDLED_CATALOG);
    }
  });

  it('never combines an old Host image route with a newer credential generation', async () => {
    const host = await freshCodexProxyHost();
    const { BUNDLED_CATALOG, buildUserProvider } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const { beginProviderRouteMutation, setCustomProviderKeyReader } =
      await import('../provider-route.js');
    const { deriveCodexCustomProviderRoutes } = await import('../codex-custom-provider-route.js');
    const providerFor = (baseUrl: string) =>
      buildUserProvider({
        id: 'busy-credential-image-provider',
        name: 'Busy Credential Image Provider',
        runtimes: {
          codex: {
            baseUrl,
            wireProtocol: 'openai-responses',
            supportsImageGeneration: true,
            models: [{ id: 'image-chat', name: 'Image Chat' }],
          },
        },
      });
    const oldProvider = providerFor('https://old-credential-images.example/v1');
    const oldCatalog = {
      ...BUNDLED_CATALOG,
      providers: [...BUNDLED_CATALOG.providers, oldProvider],
    };
    setActiveCatalog(oldCatalog);
    setCustomProviderKeyReader(() => 'old-provider-key');
    const oldRoute = deriveCodexCustomProviderRoutes(oldCatalog)[0]!;
    host.setCodexAppliedCustomProviderRoutes([oldRoute]);
    let finishMutation: ReturnType<typeof beginProviderRouteMutation> | null = null;

    try {
      finishMutation = beginProviderRouteMutation(oldProvider.id);
      const newProvider = providerFor('https://new-credential-images.example/v1');
      const newCatalog = {
        ...BUNDLED_CATALOG,
        providers: [...BUNDLED_CATALOG.providers, newProvider],
      };
      setActiveCatalog(newCatalog);
      setCustomProviderKeyReader(() => 'new-provider-key');

      const duringMutation = await Promise.resolve(
        host.createModelRoutingTransform()(
          { model: 'gpt-image-2' },
          {
            reqId: 1,
            method: 'POST',
            url: `/_cindy/custom-provider/${oldRoute.routeId}/images/generations`,
            headers: {},
          },
        ),
      );
      expect(duringMutation).toEqual(
        expect.objectContaining({ localHandler: expect.any(Function) }),
      );

      finishMutation.commit();
      finishMutation();
      const staleHost = await Promise.resolve(
        host.createModelRoutingTransform()(
          { model: 'gpt-image-2' },
          {
            reqId: 2,
            method: 'POST',
            url: `/_cindy/custom-provider/${oldRoute.routeId}/images/generations`,
            headers: {},
          },
        ),
      );
      expect(staleHost).toEqual(expect.objectContaining({ localHandler: expect.any(Function) }));

      const newRoute = deriveCodexCustomProviderRoutes(newCatalog)[0]!;
      host.setCodexAppliedCustomProviderRoutes([newRoute]);
      const restartedHost = await Promise.resolve(
        host.createModelRoutingTransform()(
          { model: 'gpt-image-2' },
          {
            reqId: 3,
            method: 'POST',
            url: `/_cindy/custom-provider/${newRoute.routeId}/images/generations`,
            headers: {},
          },
        ),
      );
      expect(restartedHost).toEqual(
        expect.objectContaining({
          upstreamOverride: 'https://new-credential-images.example/v1',
          headerOverride: expect.objectContaining({ authorization: 'Bearer new-provider-key' }),
        }),
      );
      expect(JSON.stringify(newRoute)).not.toContain('new-provider-key');
    } finally {
      finishMutation?.();
      host.setCodexAppliedCustomProviderRoutes([]);
      setCustomProviderKeyReader(() => null);
      setActiveCatalog(BUNDLED_CATALOG);
    }
  });

  it('routes a real multipart edit through the prefix with byte-identical body and Provider auth', async () => {
    const sensitiveResponseBody = '{"result":"private-upstream-response"}';
    const received: Array<{
      path: string;
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
    }> = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'content-type': 'application/json' }).end(sensitiveResponseBody);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    let upstreamClosed = false;
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const upstreamUrl = `http://private-user:private-password@127.0.0.1:${(upstream.address() as AddressInfo).port}/v1?private-query=value#private-fragment`;
    const expectedLoggedUpstream = `${upstreamOrigin}/v1`;
    const host = await freshCodexProxyHost();
    const actualProxy = await vi.importActual<typeof import('@cindy/anthropic-compat-proxy')>(
      '@cindy/anthropic-compat-proxy',
    );
    mockState.createAnthropicCompatProxy.mockImplementationOnce(
      actualProxy.createAnthropicCompatProxy,
    );
    const { BUNDLED_CATALOG, buildUserProvider } = await import('@cindy/model-providers');
    const { setActiveCatalog } = await import('../active-catalog.js');
    const { setCustomProviderHeaderReader, setCustomProviderKeyReader } = await import('../provider-route.js');
    const { deriveCodexCustomProviderRoutes } = await import('../codex-custom-provider-route.js');
    const provider = buildUserProvider({
      id: 'private-stored-provider-id',
      name: 'Private Provider Display Name',
      runtimes: {
        codex: {
          baseUrl: upstreamUrl,
          requestPath: '/v1/responses',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [{ id: 'image-chat', name: 'Image Chat' }],
        },
      },
    });
    const catalog = {
      ...BUNDLED_CATALOG,
      providers: [...BUNDLED_CATALOG.providers, provider],
    };
    const route = deriveCodexCustomProviderRoutes(catalog)[0]!;
    setActiveCatalog(catalog);
    setCustomProviderKeyReader(() => 'fake-provider-authorization-secret');
    setCustomProviderHeaderReader(() => ({
      'x-private-vendor-header': 'private-vendor-header-value',
    }));
    host.setCodexAppliedCustomProviderRoutes([route]);
    const boundary = 'cindy-native-edit';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="private-image-name.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from([0, 255, 128, 13, 10, 77]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const requestRawTarget = (
      proxyEndpoint: string,
      target: string,
      method: string,
      contentType?: string,
      rawBody?: Buffer | string,
    ) =>
      new Promise<number>((resolve, reject) => {
        const proxy = new URL(proxyEndpoint);
        const requestBody = rawBody === undefined
          ? undefined
          : Buffer.isBuffer(rawBody)
            ? rawBody
            : Buffer.from(rawBody);
        const req = httpRequest(
          {
            hostname: proxy.hostname,
            port: proxy.port,
            method,
            path: target,
            headers: {
              ...(contentType ? { 'content-type': contentType } : {}),
              ...(requestBody ? { 'content-length': String(requestBody.length) } : {}),
              authorization: 'Bearer loopback-placeholder',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        if (requestBody) req.write(requestBody);
        req.end();
      });

    try {
      await host.ensureCodexProxyReady();
      const proxyEndpoint = host.getCodexProxyEndpoint();
      mockState.logger.info.mockClear();
      mockState.logger.warn.mockClear();
      mockState.logger.debug.mockClear();
      const invalidRequests = [
        {
          path: '/_cindy/custom-provider/not-a-route/images/edits',
          method: 'POST',
          contentType: `multipart/form-data; boundary=${boundary}`,
          requestBody: body,
        },
        {
          path: `/_cindy/custom-provider/${route.routeId}/images/edits/extra`,
          method: 'POST',
          contentType: 'application/json',
          requestBody: '{}',
        },
        {
          path: `/_cindy/custom-provider%2F${route.routeId}%2Fimages%2Fedits`,
          method: 'POST',
          contentType: 'application/octet-stream',
          requestBody: body,
        },
        {
          path: `/_cindy/custom-provider/${route.routeId}/images/edits`,
          method: 'PUT',
          contentType: `multipart/form-data; boundary=${boundary}`,
          requestBody: body,
        },
        {
          path: `/_cindy/custom-provider/${route.routeId}/files`,
          method: 'POST',
          contentType: 'application/json',
          requestBody: '{}',
        },
        { path: '/_cindy/custom-provider', method: 'POST' },
        { path: '/_cindy/custom-provider/', method: 'POST' },
        // Retired capability-specific prototype namespace must fail closed, never hit Gateway.
        { path: `/_cindy/imagegen/${route.routeId}/images/edits`, method: 'POST' },
        { path: '//_cindy//custom-provider//', method: 'GET' },
        { path: '/_cindy/custom-provider/../responses', method: 'POST', contentType: 'application/json', requestBody: '{}' },
        { path: '/_cindy/custom-provider/./responses', method: 'POST' },
        { path: '/_cindy/custom-provider/%2e%2e/responses', method: 'POST', contentType: 'text/plain', requestBody: 'opaque' },
        { path: '/_CINDY/Custom-Provider/anything', method: 'POST' },
        { path: '/_cindy/custom-provid%65r/anything', method: 'POST' },
        { path: `/_cindy/custom-provider%2f${route.routeId}%2fimages%2fedits`, method: 'POST' },
        { path: `/_cindy/custom-provider%5c${route.routeId}%5cimages%5cedits`, method: 'POST' },
        { path: `/_cindy\\custom-provider\\${route.routeId}\\images\\edits`, method: 'POST' },
        { path: `/_cindy/custom-provider/${route.routeId}/images/edits#fragment`, method: 'POST' },
        { path: `/other/../_cindy/custom-provider/${route.routeId}/images/edits`, method: 'POST' },
        {
          path: `${proxyEndpoint}/_cindy/custom-provider/${route.routeId}/images/edits/extra`,
          method: 'POST',
          contentType: `multipart/form-data; boundary=${boundary}`,
          requestBody: body,
        },
        {
          path: `${proxyEndpoint}\\_cindy\\custom-provider\\${route.routeId}\\images\\edits`,
          method: 'POST',
          contentType: 'application/octet-stream',
          requestBody: body,
        },
      ];
      for (const invalidRequest of invalidRequests) {
        const status = await requestRawTarget(
          proxyEndpoint,
          invalidRequest.path,
          invalidRequest.method,
          invalidRequest.contentType,
          invalidRequest.requestBody,
        );
        expect(status, invalidRequest.path).toBeGreaterThanOrEqual(400);
      }
      expect(received).toHaveLength(0);
      const imageGenerationLogLines = (): string[] =>
        [...mockState.logger.info.mock.calls, ...mockState.logger.warn.mock.calls]
          .map((call) => String(call[0] ?? ''))
          .filter((line) => line.includes('codex_image_generation_forward_'));
      expect(imageGenerationLogLines()).toEqual([]);

      const response = await fetch(
        `${proxyEndpoint}/_cindy/custom-provider/${route.routeId}/images/edits`,
        {
          method: 'POST',
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            authorization: 'Bearer loopback-placeholder',
            'x-openai-actor-authorization': 'local-image-extension',
          },
          body,
        },
      );
      expect(response.status).toBe(200);
      const generationBody = JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'private-generation-prompt',
        size: '1536x1024',
        quality: 'high',
        background: 'transparent',
        n: 2,
        output_format: 'png',
        output_compression: 85,
        moderation: 'auto',
        partial_images: 1,
        stream: false,
        response_format: 'b64_json',
        unknown_private_field: 'private-unknown-value',
        input: { image_url: 'data:image/png;base64,private-base64-payload' },
      });
      const generationResponse = await fetch(
        `${proxyEndpoint}/_cindy/custom-provider/${route.routeId}/images/generations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer loopback-placeholder',
            'x-openai-actor-authorization': 'local-image-extension',
          },
          body: generationBody,
        },
      );
      expect(generationResponse.status).toBe(200);
      const customModelBody = JSON.stringify({
        model: 'vendor-image-model-v2',
        prompt: 'second-private-prompt',
      });
      expect(
        (
          await fetch(`${proxyEndpoint}/_cindy/custom-provider/${route.routeId}/images/generations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: customModelBody,
          })
        ).status,
      ).toBe(200);
      const overlongModel = `private-overlong-prefix-${'x'.repeat(140)}-private-overlong-tail`;
      expect(
        (
          await fetch(`${proxyEndpoint}/_cindy/custom-provider/${route.routeId}/images/generations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: overlongModel, prompt: 'third-private-prompt' }),
          })
        ).status,
      ).toBe(200);
      expect(received).toHaveLength(4);
      expect(received[0]?.path).toBe('/v1/images/edits?private-query=value');
      expect(received[0]?.body).toEqual(body);
      expect(received[0]?.headers['content-type']).toBe(
        `multipart/form-data; boundary=${boundary}`,
      );
      expect(received[0]?.headers['content-length']).toBe(String(body.length));
      expect(received[0]?.headers.authorization).toBe('Bearer fake-provider-authorization-secret');
      expect(received[0]?.headers['x-private-vendor-header']).toBe('private-vendor-header-value');
      expect(received[0]?.headers['x-openai-actor-authorization']).toBeUndefined();
      expect(received[1]?.path).toBe('/v1/images/generations?private-query=value');
      expect(received[1]?.body.toString('utf8')).toBe(generationBody);
      expect(received[1]?.headers.authorization).toBe('Bearer fake-provider-authorization-secret');

      const successfulLogs = imageGenerationLogLines();
      expect(successfulLogs).toHaveLength(8);
      for (const [operation, expectedCount] of [
        ['edit', 2],
        ['generation', 6],
      ] as const) {
        const operationLogs = successfulLogs.filter((line) =>
          line.includes(`operation     : ${operation}`),
        );
        expect(operationLogs).toHaveLength(expectedCount);
        expect(operationLogs[0]).toContain('codex_image_generation_forward_start');
        expect(operationLogs[1]).toContain('codex_image_generation_forward_complete');
        const correlationIds = operationLogs.map(
          (line) => /correlationId\s+:\s+([0-9a-f-]{36})/.exec(line)?.[1],
        );
        expect(correlationIds[0]).toBeTruthy();
        expect(correlationIds[1]).toBe(correlationIds[0]);
        expect(operationLogs[1]).toContain('status        : 200');
        expect(operationLogs[1]).toContain('outcome       : success');
        expect(operationLogs[1]).toMatch(/durationMs\s+:\s+\d+/);
      }
      for (const line of successfulLogs) {
        expect(line).toContain(`routeId       : ${route.routeId}`);
        expect(line).toContain('target        : custom-provider');
        expect(line).not.toContain('authSource');
        expect(line).not.toContain('upstreamUrl');
        expect(line).not.toContain('imageParams');
      }

      const detailLogs = mockState.logger.debug.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('codex_image_generation_forward_details'));
      expect(detailLogs).toHaveLength(4);
      const editDetails = detailLogs.filter((line) => /operation\s+:\s+edit/.test(line));
      expect(editDetails).toHaveLength(1);
      expect(editDetails[0]).toContain('upstreamUrl');
      expect(editDetails[0]).toContain(`${expectedLoggedUpstream}/images/edits`);
      expect(editDetails[0]).not.toContain('imageParams');
      const generationDetails = detailLogs.filter((line) =>
        /operation\s+:\s+generation/.test(line),
      );
      expect(generationDetails).toHaveLength(3);
      expect(generationDetails[0]).toContain('upstreamUrl');
      expect(generationDetails[0]).toContain(`${expectedLoggedUpstream}/images/generations`);
      for (const expected of [
        '"model": "gpt-image-2"',
        '"size": "1536x1024"',
        '"quality": "high"',
        '"background": "transparent"',
        '"n": 2',
        '"output_format": "png"',
        '"output_compression": 85',
        '"moderation": "auto"',
        '"partial_images": 1',
        '"stream": false',
        '"response_format": "b64_json"',
      ]) {
        expect(generationDetails[0]).toContain(expected);
      }
      expect(generationDetails[1]).toContain('"model": "vendor-image-model-v2"');
      expect(generationDetails[2]).toContain('"model": "[truncated]"');
      expect(JSON.stringify(detailLogs)).not.toContain('private-overlong-tail');

      const sensitiveValues = [
        'authSource',
        upstreamUrl,
        '127.0.0.1',
        'private-user',
        'private-password',
        'private-query',
        'private-fragment',
        'private-stored-provider-id',
        'Private Provider Display Name',
        'fake-provider-authorization-secret',
        'authorization',
        'x-private-vendor-header',
        'private-vendor-header-value',
        'private-generation-prompt',
        'private-base64-payload',
        'private-unknown-value',
        'second-private-prompt',
        'third-private-prompt',
        'private-image-name.bin',
        'private-upstream-response',
      ];
      const serializedSuccessfulLogs = JSON.stringify(successfulLogs);
      for (const sensitiveValue of sensitiveValues) {
        expect(serializedSuccessfulLogs).not.toContain(sensitiveValue);
      }
      const serializedDetails = JSON.stringify(detailLogs);
      for (const sensitiveValue of sensitiveValues.filter((value) =>
        [upstreamUrl, '127.0.0.1'].includes(value),
      )) {
        expect(serializedDetails).toContain(
          sensitiveValue === upstreamUrl ? expectedLoggedUpstream : sensitiveValue,
        );
      }
      for (const sensitiveValue of sensitiveValues.filter(
        (value) => ![upstreamUrl, '127.0.0.1'].includes(value),
      )) {
        expect(serializedDetails).not.toContain(sensitiveValue);
      }

      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      upstreamClosed = true;
      mockState.logLevel = 'info';
      const transportResponse = await fetch(
        `${proxyEndpoint}/_cindy/custom-provider/${route.routeId}/images/generations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: generationBody,
        },
      );
      expect(transportResponse.status).toBe(502);
      const transportLogs = imageGenerationLogLines().slice(8);
      expect(transportLogs).toHaveLength(2);
      expect(transportLogs[0]).toContain('codex_image_generation_forward_start');
      expect(transportLogs[1]).toContain('codex_image_generation_forward_failure');
      expect(transportLogs[1]).toContain('outcome       : network_error');
      const transportCorrelationIds = transportLogs.map(
        (line) => /correlationId\s+:\s+([0-9a-f-]{36})/.exec(line)?.[1],
      );
      expect(transportCorrelationIds[0]).toBeTruthy();
      expect(transportCorrelationIds[1]).toBe(transportCorrelationIds[0]);
      const serializedTransportLogs = JSON.stringify(transportLogs);
      for (const sensitiveValue of [...sensitiveValues, 'ECONNREFUSED']) {
        expect(serializedTransportLogs).not.toContain(sensitiveValue);
      }
      expect(
        mockState.logger.debug.mock.calls.filter((call) =>
          String(call[0] ?? '').includes('codex_image_generation_forward_details'),
        ),
      ).toHaveLength(4);
      expect(mockState.createAnthropicCompatProxy.mock.calls[0]?.[0]).not.toHaveProperty(
        'forwardLifecycleObserver',
      );
    } finally {
      await host.disposeCodexProxy();
      host.setCodexAppliedCustomProviderRoutes([]);
      setCustomProviderHeaderReader(() => null);
      setCustomProviderKeyReader(() => null);
      setActiveCatalog(BUNDLED_CATALOG);
      if (!upstreamClosed) {
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    }
  });

  it('owns every private custom Provider prefix before opaque body transforms', async () => {
    const host = await freshCodexProxyHost();
    mockState.createAnthropicCompatProxy.mockResolvedValueOnce({
      url: 'http://127.0.0.1:43210',
      dispose: vi.fn(async () => undefined),
    });
    await host.ensureCodexProxyReady();
    const options = mockState.createAnthropicCompatProxy.mock.calls[0]?.[0];
    expect(
      options.bypassRequestTransforms(
        {},
        {
          url: '/_cindy/custom-provider/0123456789abcdefabcd/images/edits',
        },
      ),
    ).toBe(true);
    expect(options.bypassRequestTransforms({}, { url: '/images/edits' })).toBe(false);
    expect(
      options.bypassRequestTransforms(
        {},
        {
          url: '/_cindy/custom-provider/0123456789abcdefabcd/responses',
        },
      ),
    ).toBe(true);
    expect(
      options.routeOpaqueRequestBody({
        url: '/_cindy/custom-provider%2F0123456789abcdefabcd%2Fimages%2Fedits',
      }),
    ).toBe(true);
    expect(options.routeOpaqueRequestBody({ url: '/images/edits' })).toBe(false);
  });
});
