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

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
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

const SESSION_HEADER = { 'x-claude-code-session-id': 'sdk-grok' };

function ctxWith(headers: Record<string, string>) {
  return { reqId: 1, method: 'POST', url: '/v1/messages', headers } as never;
}

describe('cc routingTransform — xAI 会话的辅助请求回落默认路由 (issue #886)', () => {
  let gatewayKey: string | null;

  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
    gatewayKey = 'sk-gw';
    setClaudeProxyGatewayKeyReader(() => gatewayKey);
    setClaudeProxySessionIdResolver((sdkId) => (sdkId === 'sdk-grok' ? 'sess-grok' : null));
    setSessionProvider('sess-grok', 'xai');
  });

  afterEach(() => {
    clearSessionProvider('sess-grok');
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
});
