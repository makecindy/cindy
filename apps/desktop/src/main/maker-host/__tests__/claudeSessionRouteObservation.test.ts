/**
 * claudeSessionRouteObservation.test.ts
 * ---------------------------------------------------------------------------
 * proxy routingTransform ② 段(默认路由)的 per-session 生效路由观察:
 *   - gateway-spawn(带 x-api-key)passthrough → 记 'gateway'(即使本机 key 已清,
 *     child 冻结凭证仍走网关 —— 观察值必须反映实际流量)
 *   - oauth-spawn + 有网关 key(换 key 决策)→ 记 'gateway'
 *   - oauth-spawn + 无 key + Anthropic 模型(直连)→ 记 'subscription'
 *   - 无 key + 非 Anthropic 模型 passthrough(路由不明确)→ 不记录
 *   - 请求无 session header → 正常路由, 不记录
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestTransformCtx, RoutingDecision } from '@cindy/anthropic-compat-proxy';

const routeMocks = vi.hoisted(() => ({
  resolveSessionRouteDecision: vi.fn<() => RoutingDecision | null>(() => null),
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
vi.mock('../provider-route', () => ({
  // 默认路由会话: 显式供应商解析恒 null; 网关默认决策 = 有 key 才换。
  resolveSessionRouteDecision: routeMocks.resolveSessionRouteDecision,
  gatewayDefaultRouteDecision: vi.fn((_agent: string, gatewayKey: string | null) =>
    gatewayKey ? { headerOverride: { 'x-api-key': gatewayKey } } : null),
}));
// bridge 分流用例需要 handler 存在(真模块懒装配依赖订阅凭证环境)。
// handle 按 bridgeHandleImpl 可编程:失败归因用例需要它写不同的响应状态码。
const bridgeMock = vi.hoisted(() => ({
  bridgeHandleImpl: undefined as
    | ((args: { res: { statusCode: number } }) => Promise<void>)
    | undefined,
}));
vi.mock('../anthropic-responses-bridge-host', () => ({
  getResponsesBridgeHandler: () => ({
    handle: (args: { res: { statusCode: number } }) =>
      bridgeMock.bridgeHandleImpl ? bridgeMock.bridgeHandleImpl(args) : Promise.resolve(),
  }),
}));

import {
  createClaudeSessionFailedRequestObserver,
  createModelRoutingTransform,
  setClaudeProxyGatewayKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import { clearSessionProvider, setSessionProvider } from '../session-provider-store';
import {
  readClaudeSessionRoute,
  readClaudeSessionRouteState,
  takeClaudeRequestRoute,
  resetClaudeSessionRouteRegistryForTest,
} from '../claude-session-route-registry';

const SESSION_HEADER = { 'x-claude-code-session-id': 'sdk-abc' };

function ctxWith(headers: Record<string, string>, reqId = 1): RequestTransformCtx {
  return { reqId, method: 'POST', url: '/v1/messages', headers };
}

describe('claude session route observation (routing transform ② 段)', () => {
  let gatewayKey: string | null = null;

  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
    gatewayKey = null;
    routeMocks.resolveSessionRouteDecision.mockReset();
    routeMocks.resolveSessionRouteDecision.mockReturnValue(null);
    bridgeMock.bridgeHandleImpl = undefined;
    setClaudeProxyGatewayKeyReader(() => gatewayKey);
    setClaudeProxySessionIdResolver((sdkId) => (sdkId === 'sdk-abc' ? 'sess-1' : null));
  });

  afterEach(() => {
    clearSessionProvider('sess-1');
  });

  it('records gateway for x-api-key (gateway-spawn) passthrough even when the live key is gone', () => {
    const transform = createModelRoutingTransform();
    // 本机 key 已清(gatewayKey=null), 但 child 冻结的 x-api-key 仍在请求上。
    const decision = transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
    );
    expect(decision).toBeNull();  // passthrough
    expect(readClaudeSessionRoute('sess-1')).toBe('gateway');
    expect(takeClaudeRequestRoute(1)).toEqual({ sessionId: 'sess-1', route: 'gateway' });
  });

  it('records gateway for oauth-spawn requests swapped onto the gateway key', () => {
    gatewayKey = 'sk-live';
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(decision).toEqual({ headerOverride: { 'x-api-key': 'sk-live' } });
    expect(readClaudeSessionRoute('sess-1')).toBe('gateway');
  });

  it('records subscription for oauth-spawn anthropic-direct requests (no gateway key)', () => {
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(decision).toEqual({ upstreamOverride: 'https://api.anthropic.com' });
    expect(readClaudeSessionRoute('sess-1')).toBe('subscription');
  });

  it('records exact routes for explicitly selected XD and Anthropic providers', () => {
    setSessionProvider('sess-1', 'xd');
    routeMocks.resolveSessionRouteDecision.mockReturnValueOnce({
      headerOverride: { 'x-api-key': 'sk-gw' },
    });
    expect(
      createModelRoutingTransform()(
        { model: 'claude-opus-4-8[1m]' },
        { ...ctxWith(SESSION_HEADER), reqId: 21 } as never,
      ),
    ).toEqual({ headerOverride: { 'x-api-key': 'sk-gw' } });
    expect(takeClaudeRequestRoute(21)).toEqual({ sessionId: 'sess-1', route: 'gateway' });

    setSessionProvider('sess-1', 'anthropic');
    routeMocks.resolveSessionRouteDecision.mockReturnValueOnce({
      upstreamOverride: 'https://api.anthropic.com',
    });
    expect(
      createModelRoutingTransform()(
        { model: 'claude-opus-4-8[1m]' },
        { ...ctxWith(SESSION_HEADER), reqId: 22 } as never,
      ),
    ).toEqual({ upstreamOverride: 'https://api.anthropic.com' });
    expect(takeClaudeRequestRoute(22)).toEqual({ sessionId: 'sess-1', route: 'subscription' });
  });

  it('records gateway for an explicitly selected XD passthrough with a frozen child key', () => {
    setSessionProvider('sess-1', 'xd');
    const decision = createModelRoutingTransform()(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }, 23),
    );
    expect(decision).toBeNull();
    expect(takeClaudeRequestRoute(23)).toEqual({ sessionId: 'sess-1', route: 'gateway' });
  });

  it('does not record ambiguous no-key non-anthropic passthroughs', () => {
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'gpt-5.5[1m]' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(decision).toBeNull();
    expect(readClaudeSessionRoute('sess-1')).toBeNull();
  });

  it('routes but does not record when the request has no session header', () => {
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(decision).toEqual({ upstreamOverride: 'https://api.anthropic.com' });
    expect(readClaudeSessionRoute('sess-1')).toBeNull();
  });

  it('corrects the recorded route when credentials change between requests', () => {
    const transform = createModelRoutingTransform();
    // 第一笔: 无 key → 直连订阅。
    transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(readClaudeSessionRoute('sess-1')).toBe('subscription');
    // 用户配上网关 key → 下一笔换 key 走网关, 观察值自动纠正。
    gatewayKey = 'sk-live';
    transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(readClaudeSessionRoute('sess-1')).toBe('gateway');
  });

  it('attributes a failed bridge (chatgpt/) response without clobbering the session route', async () => {
    // 失败归因在响应侧:bridge handler 写出 ≥400 才记 lastFailedRequestBridge=true;
    // 会话主路由(chip 计费形态)不被 bridge 覆写改判(PR review P1 ×2)。
    gatewayKey = 'sk-live';
    const transform = createModelRoutingTransform();
    transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    const decision = transform(
      { model: 'chatgpt/gpt-5.5' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    ) as { localHandler: (args: { res: { statusCode: number } }) => Promise<void> };
    expect(decision).toHaveProperty('localHandler');
    // 请求发起本身不改归因(并发时按发起序置/清会误归因,PR review P1)。
    expect(readClaudeSessionRouteState('sess-1')).toEqual({
      route: 'gateway',
      lastFailedRequestBridge: false,
    });
    // bridge 响应失败(429)→ 归因 bridge;主路由不变。
    bridgeMock.bridgeHandleImpl = async ({ res }) => {
      res.statusCode = 429;
    };
    await decision.localHandler({ res: { statusCode: 0 } });
    expect(readClaudeSessionRouteState('sess-1')).toEqual({
      route: 'gateway',
      lastFailedRequestBridge: true,
    });
  });

  it('does not attribute a successful bridge response, and handler throws count as bridge failures', async () => {
    const transform = createModelRoutingTransform();
    const okDecision = transform(
      { model: 'chatgpt/gpt-5.5' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    ) as { localHandler: (args: { res: { statusCode: number } }) => Promise<void> };
    bridgeMock.bridgeHandleImpl = async ({ res }) => {
      res.statusCode = 200;
    };
    await okDecision.localHandler({ res: { statusCode: 0 } });
    expect(readClaudeSessionRouteState('sess-1').lastFailedRequestBridge).toBe(false);

    // handler 抛错 → runLocalHandler 会写 502,同样归因 bridge 失败。
    bridgeMock.bridgeHandleImpl = async () => {
      throw new Error('upstream 429');
    };
    await expect(okDecision.localHandler({ res: { statusCode: 0 } })).rejects.toThrow();
    expect(readClaudeSessionRouteState('sess-1').lastFailedRequestBridge).toBe(true);
  });

  it('attributes bridge failures for sessions with an explicit provider too', async () => {
    // 显式 XD/自定义会话的子代理 bridge 覆写同样绕过会话来源:失败归因不限
    // 默认路由会话(PR review P1);但 route 槽仍只记默认路由请求 → 保持 null。
    setSessionProvider('sess-1', 'xd');
    try {
      const transform = createModelRoutingTransform();
      const decision = transform(
        { model: 'xai/grok-4.5' },
        ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
      ) as { localHandler: (args: { res: { statusCode: number } }) => Promise<void> };
      bridgeMock.bridgeHandleImpl = async ({ res }) => {
        res.statusCode = 429;
      };
      await decision.localHandler({ res: { statusCode: 0 } });
      expect(readClaudeSessionRouteState('sess-1')).toEqual({
        route: null,
        lastFailedRequestBridge: true,
      });
    } finally {
      setSessionProvider('sess-1', null);
    }
  });

  it('failed forward-path POSTs overwrite the attribution back to non-bridge', () => {
    // forward 路径观察器(false 侧):最后落地的失败决定归因。
    const observer = createClaudeSessionFailedRequestObserver();
    resetClaudeSessionRouteRegistryForTest();
    // 先有一笔 bridge 失败归因……
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'chatgpt/gpt-5.5' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    ) as { localHandler: (args: { res: { statusCode: number } }) => Promise<void> };
    bridgeMock.bridgeHandleImpl = async ({ res }) => {
      res.statusCode = 429;
    };
    return decision.localHandler({ res: { statusCode: 0 } }).then(() => {
      expect(readClaudeSessionRouteState('sess-1').lastFailedRequestBridge).toBe(true);
      // ……随后 forward 路径 POST 失败落地 → 覆写为非 bridge。
      observer({ method: 'POST', status: 429, requestHeaders: SESSION_HEADER });
      expect(readClaudeSessionRouteState('sess-1').lastFailedRequestBridge).toBe(false);
      // 成功响应 / GET 不参与归因。
      observer({ method: 'POST', status: 200, requestHeaders: SESSION_HEADER });
      observer({ method: 'GET', status: 404, requestHeaders: SESSION_HEADER });
      expect(readClaudeSessionRouteState('sess-1').lastFailedRequestBridge).toBe(false);
    });
  });
});
