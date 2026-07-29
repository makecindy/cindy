/**
 * title-one-shot —— 会话标题「单次 HTTP」生成器测试。
 *
 * 覆盖三块:
 *   1. provider 解析(WYSIWYG):DB 显式来源优先 / 无显式则 nativeDefaultSourceId / 零已连接→null。
 *   2. buildTitleTarget:据 catalog titleModel 组装目标(模型 / 最低 effort / wire / upstream)
 *      —— 同时锁定 providers.json 里三家 titleModel 的配置(haiku / gpt-5.4-mini / gpt-5.4-mini)。
 *   3. generateTitleViaProvider:三家 wire 各发一次 fetch,断言 URL/headers/body 形状 + 响应解析;
 *      凭证缺失 / 非 2xx → 返回 null(不抛、不试别家)。
 *
 * electron 在此 mock(stub app.getPath)纯粹是为了让 import 链(auth-adapters 顶层单例)能在
 * 无 electron 的 vitest 里加载;真正的凭证 / fetch / 会话 provider 全部经 deps 注入,不碰真实实现。
 */

import { describe, expect, it, vi } from 'vitest';

const { mockGetAppCapabilities } = vi.hoisted(() => ({
  mockGetAppCapabilities: vi.fn(() => ({ canUseCindyGateway: true })),
}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: mockGetAppCapabilities,
}));

// xd 网关上游运行期来自 model-access server 下发(effectiveXdGatewayBaseUrl),
// 端点清单已不承载网关端点(2026-07-17 退役)——单测 mock 成 fixture 值。
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

// 只取 toSdkModelString,避免在 vitest 里加载整个 maker-core runtime(含 agent SDK 图)。
vi.mock('@cindy/maker-core', () => ({
  toSdkModelString: (m: string) => (m === 'claude-haiku-4-5' ? 'claude-haiku-4-5-20251001' : m),
}));

// SUT 链(runtime-configs.claudeUpstreamEndpoint → effectiveXdGatewayBaseUrl)运行期读
// model-access 下发的 endpoint;单测 mock 成 fixture 值(与 XD_GATEWAY_BASE_URL 断言值同源)。
vi.mock('../../model-access/effectiveEndpoint.js', async () => {
  const { TEST_XD_GATEWAY_BASE_URL } = await import('../../../test/vitest/clientEndpointsFixture');
  return { effectiveXdGatewayBaseUrl: () => TEST_XD_GATEWAY_BASE_URL };
});

import {
  buildTitleTarget,
  generateTitleViaProvider,
  parseResponsesSse,
  type TitleOneShotDeps,
} from '../title-one-shot.js';
import { setDiscoveredCodexModels, setXdGatewayModels } from '../active-catalog.js';

/** openai 是动态清单供应商(2026-07-19 统一重构):注入 codex 注册表快照模拟运行时形态。 */
async function withDiscoveredMini<T>(fn: () => T | Promise<T>): Promise<T> {
  setDiscoveredCodexModels([
    {
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4-Mini',
      group: 'gpt',
      sortOrder: 22,
      contextWindow: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
      status: 'active',
    },
  ]);
  try {
    return await fn();
  } finally {
    setDiscoveredCodexModels([]);
  }
}
import type { ProviderView } from '@cindy/model-providers';

/** 造一个 fetch 替身:按传入 handler 返回类 Response 对象,并记录调用。 */
function fakeFetch(
  handler: (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    ok?: boolean;
    status?: number;
    json?: unknown;
    text?: string;
  },
) {
  return vi.fn(async (url: unknown, init: unknown) => {
    const r = handler(String(url), (init ?? {}) as { headers?: Record<string, string>; body?: string });
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text ?? '',
    };
  }) as unknown as NonNullable<TitleOneShotDeps['fetchImpl']>;
}

/** 造一个最小 ProviderView stub(nativeDefaultSourceId 只用 .id)。 */
function providerStub(id: string): ProviderView {
  return { id, connected: true, name: id, agents: ['claude-code', 'codex'], models: {}, routing: {} } as unknown as ProviderView;
}

// ── Provider 解析(WYSIWYG)─────────────────────────────────────────────────

describe('generateTitleViaProvider — provider 解析', () => {
  it('DB 有显式来源且在可路由 rail 内 → 走该来源(不落默认解析)', async () => {
    const fetchImpl = fakeFetch(() => ({
      json: { content: [{ type: 'text', text: '标题' }] },
    }));
    const title = await generateTitleViaProvider(
      { sessionId: 's1', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => 'anthropic',
        // rail 同时含默认来源 xd:显式选择必须压过 nativeDefault。
        listConnectedProviders: async () => [providerStub('xd'), providerStub('anthropic')],
        readAnthropicOAuth: () => ({ accessToken: 'tok' }),
      },
    );
    expect(title).toBe('标题');
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain('anthropic.com');
  });

  it('显式来源不在可路由 rail(停用/断开)→ 跳过,不发请求(PR #744 停用轴)', async () => {
    const fetchImpl = fakeFetch(() => ({
      json: { content: [{ type: 'text', text: '不应出现' }] },
    }));
    const title = await generateTitleViaProvider(
      { sessionId: 's1', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => 'anthropic',
        // rail 只有 xd:显式来源 anthropic 已停用/断开 → 跳过,不回落默认来源。
        listConnectedProviders: async () => [providerStub('xd')],
        readAnthropicOAuth: () => ({ accessToken: 'tok' }),
      },
    );
    expect(title).toBeNull();
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(0);
  });

  it('DB 无显式 + xd 已连接 → 走 xd(cc 默认)', async () => {
    const fetchImpl = fakeFetch(() => ({
      json: { choices: [{ message: { content: '网关标题' } }] },
    }));
    const title = await generateTitleViaProvider(
      { sessionId: 's2', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => null,
        listConnectedProviders: async () => [providerStub('xd')],
        readGatewayKey: () => 'gk',
      },
    );
    expect(title).toBe('网关标题');
  });

  it('DB 无显式 + 只有 anthropic 已连接(无 xd)→ 走 anthropic', async () => {
    const fetchImpl = fakeFetch(() => ({
      json: { content: [{ type: 'text', text: '订阅标题' }] },
    }));
    const title = await generateTitleViaProvider(
      { sessionId: 's3', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => null,
        listConnectedProviders: async () => [providerStub('anthropic')],
        readAnthropicOAuth: () => ({ accessToken: 'tok' }),
      },
    );
    expect(title).toBe('订阅标题');
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain('anthropic.com');
  });

  it('DB 无显式 + codex 会话 + openai 已连接 → 走 openai', async () => {
    const SSE = [
      'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"codex标题"}]}]}}',
    ].join('\n');
    const fetchImpl = fakeFetch(() => ({ text: SSE }));
    const title = await generateTitleViaProvider(
      { sessionId: 's4', agentKind: 'codex', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => null,
        listConnectedProviders: async () => [providerStub('openai')],
        readCodexCreds: () => ({ accessToken: 'ctok', accountId: 'acc' }),
      },
    );
    expect(title).toBe('codex标题');
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain('chatgpt.com');
  });

  it('零已连接来源 → null,不发请求', async () => {
    const fetchImpl = fakeFetch(() => ({ json: {} }));
    const title = await generateTitleViaProvider(
      { sessionId: 's5', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => null,
        listConnectedProviders: async () => [],
      },
    );
    expect(title).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── buildTitleTarget(锁定 catalog titleModel 配置)────────────────────────

describe('buildTitleTarget(锁定 catalog titleModel 配置)', () => {
  it('本地模式不构造 XD 网关标题请求', () => {
    mockGetAppCapabilities.mockReturnValueOnce({ canUseCindyGateway: false });
    expect(buildTitleTarget('xd')).toBeNull();
  });
  it('anthropic → haiku / Messages,haiku 无 effort', () => {
    expect(buildTitleTarget('anthropic')).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
      effort: null,
      wire: 'anthropic-messages',
      upstream: 'https://api.anthropic.com',
    });
  });
  it('openai → gpt-5.4-mini / Responses,最低 effort=low(效仿运行时注入注册表快照)', async () => {
    await withDiscoveredMini(() => {
      expect(buildTitleTarget('openai')).toEqual({
        providerId: 'openai',
        model: 'gpt-5.4-mini',
        effort: 'low',
        wire: 'codex-responses',
        upstream: 'https://chatgpt.com/backend-api/codex',
      });
    });
  });
  it('openai 注册表未注入(清单为空)→ effort=null(SDK 默认档),标题请求仍可发', () => {
    expect(buildTitleTarget('openai')).toMatchObject({
      providerId: 'openai',
      model: 'gpt-5.4-mini',
      effort: null,
    });
  });
  it('xd → gpt-5.4-mini / 网关 chat-completions(/v1 upstream)', () => {
    // xd 模型以网关实时清单为准(默认空):注入 titleModel 同 id 条目,
    // 元数据(efforts)回落目录静态条目 → 最低 effort = low。
    setXdGatewayModels([{ id: 'gpt-5.4-mini' }]);
    try {
      expect(buildTitleTarget('xd')).toEqual({
        providerId: 'xd',
        model: 'gpt-5.4-mini',
        effort: 'low',
        wire: 'gateway-chat',
        upstream: `${XD_GATEWAY_BASE_URL}/v1`,
      });
    } finally {
      setXdGatewayModels([]);
    }
  });
  it('未知 provider → null', () => {
    expect(buildTitleTarget('does-not-exist')).toBeNull();
  });
});

// ── generateTitleViaProvider — anthropic(Messages)────────────────────────

describe('generateTitleViaProvider — anthropic(Messages)', () => {
  it('200 → 解析 content[].text;请求形状正确', async () => {
    const fetchImpl = fakeFetch(() => ({ json: { content: [{ type: 'text', text: 'TS 编译报错排查' }] } }));
    const title = await generateTitleViaProvider(
      { sessionId: 's1', agentKind: 'claude-code', prompt: '为这条消息起标题：编译报错' },
      {
        fetchImpl,
        readSessionProviderId: async () => 'anthropic',
        listConnectedProviders: async () => [providerStub('anthropic')],
        readAnthropicOAuth: () => ({ accessToken: 'atok' }),
      },
    );
    expect(title).toBe('TS 编译报错排查');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers.authorization).toBe('Bearer atok');
    expect(init.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-haiku-4-5-20251001'); // 经 toSdkModelString 还原
    expect(body.messages).toEqual([{ role: 'user', content: '为这条消息起标题：编译报错' }]);
    expect(body.system).toBeUndefined(); // 不注入身份段
  });
  it('无 OAuth → null,不发请求', async () => {
    const fetchImpl = fakeFetch(() => ({ json: {} }));
    const title = await generateTitleViaProvider(
      { sessionId: 's1', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => 'anthropic',
        listConnectedProviders: async () => [providerStub('anthropic')],
        readAnthropicOAuth: () => null,
      },
    );
    expect(title).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('非 2xx → null', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 401, json: {} }));
    const title = await generateTitleViaProvider(
      { sessionId: 's1', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => 'anthropic',
        listConnectedProviders: async () => [providerStub('anthropic')],
        readAnthropicOAuth: () => ({ accessToken: 'atok' }),
      },
    );
    expect(title).toBeNull();
  });
});

// ── generateTitleViaProvider — openai(codex Responses SSE)───────────────

describe('generateTitleViaProvider — openai(codex Responses SSE)', () => {
  const SSE = [
    'data: {"type":"response.output_text.delta","delta":"接力"}',
    'data: {"type":"response.output_text.delta","delta":"测试"}',
    'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"接力测试"}]}]}}',
    'data: [DONE]',
  ].join('\n');

  it('200 SSE → 解析 output_text;header/body 正确,带最低 effort', async () => {
    const fetchImpl = fakeFetch(() => ({ text: SSE }));
    const title = await withDiscoveredMini(() =>
      generateTitleViaProvider(
        { sessionId: 's2', agentKind: 'codex', prompt: '起个标题' },
        {
          fetchImpl,
          readSessionProviderId: async () => 'openai',
          listConnectedProviders: async () => [providerStub('openai')],
          readCodexCreds: () => ({ accessToken: 'ctok', accountId: 'acc-1' }),
        },
      ),
    );
    expect(title).toBe('接力测试');
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init.headers.authorization).toBe('Bearer ctok');
    expect(init.headers['chatgpt-account-id']).toBe('acc-1');
    expect(init.headers.originator).toBe('codex_cli_rs');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5.4-mini');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'low' });
  });
  it('无 codex 凭证 → null,不发请求', async () => {
    const fetchImpl = fakeFetch(() => ({ text: SSE }));
    const title = await generateTitleViaProvider(
      { sessionId: 's2', agentKind: 'codex', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => 'openai',
        listConnectedProviders: async () => [providerStub('openai')],
        readCodexCreds: () => null,
      },
    );
    expect(title).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── generateTitleViaProvider — xd(网关 chat-completions)─────────────────

describe('generateTitleViaProvider — xd(网关 chat-completions)', () => {
  it('200 → 解析 choices[].message.content;请求形状正确', async () => {
    const fetchImpl = fakeFetch(() => ({ json: { choices: [{ message: { content: '网关标题' } }] } }));
    const title = await generateTitleViaProvider(
      { sessionId: 's3', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => 'xd',
        listConnectedProviders: async () => [providerStub('xd')],
        readGatewayKey: () => 'gk-1',
      },
    );
    expect(title).toBe('网关标题');
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe(`${XD_GATEWAY_BASE_URL}/v1/chat/completions`);
    expect(init.headers.authorization).toBe('Bearer gk-1');
    expect(JSON.parse(init.body).model).toBe('gpt-5.4-mini');
  });
  it('无网关 key → null', async () => {
    const fetchImpl = fakeFetch(() => ({ json: {} }));
    const title = await generateTitleViaProvider(
      { sessionId: 's3', agentKind: 'claude-code', prompt: 'x' },
      {
        fetchImpl,
        readSessionProviderId: async () => 'xd',
        listConnectedProviders: async () => [providerStub('xd')],
        readGatewayKey: () => null,
      },
    );
    expect(title).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── parseResponsesSse ─────────────────────────────────────────────────────

describe('parseResponsesSse', () => {
  it('优先 response.completed 的 final 文本', () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"部分"}',
      'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"完整标题"}]}]}}',
    ].join('\n');
    expect(parseResponsesSse(sse)).toBe('完整标题');
  });
  it('只有 delta 时累加 delta', () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"abc"}',
      'data: {"type":"response.output_text.delta","delta":"def"}',
    ].join('\n');
    expect(parseResponsesSse(sse)).toBe('abcdef');
  });
  it('跳过非 JSON / 心跳行,不抛', () => {
    expect(parseResponsesSse(': keep-alive\n\ndata: not-json\ndata: [DONE]')).toBe('');
  });
});
