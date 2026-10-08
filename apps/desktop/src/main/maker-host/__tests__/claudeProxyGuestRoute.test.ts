/**
 * 供应商分享受邀者的 Claude Code 请求(带路由令牌)只能经分享的那一个供应商、用它提供的模型。
 * 别的模型(包括本机其它供应商、订阅前缀模型)本地拒绝，不按模型推断改道，也不落默认网关；
 * 令牌无效或已撤销时拒绝。不带令牌的本机用户请求路由不变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../outbound-fetch.js', () => ({ outboundFetch: vi.fn() }));
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

import { DEVICE_HOSTED_GUEST_ROUTE_HEADER } from '@cindy/maker-core';
import { buildRegistry, buildUserProvider } from '@cindy/model-providers';
import type { RoutingDecision } from '@cindy/anthropic-compat-proxy';

import {
  createModelRoutingTransform,
  setClaudeProxyGatewayKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import { getActiveCatalog, setCustomProviders } from '../active-catalog';
import {
  GUEST_ROUTE_HEADER,
  guestProviderOffersModel,
  guestProviderRouteForSession,
  guestProviderRouteForToken,
  registerGuestProviderRoute,
  resetGuestProviderRoutesForTest,
  restrictCodexRoutesToGuestProvider,
} from '../guest-provider-route-store';
import {
  setCustomProviderKeyReader,
  setPendingCredentialSwitchReader,
  setProviderOAuthTokenReader,
  setProviderViewsReader,
} from '../provider-route';
import { clearAllSessionProviders, getSessionProvider } from '../session-provider-store';
import { registerPiProxySession } from '../pi-proxy-session-auth';

const SHARED_UPSTREAM = 'https://shared.example/api/anthropic';
const OTHER_UPSTREAM = 'https://other.example/api/anthropic';

function ctxWith(headers: Record<string, string>) {
  return { reqId: 1, method: 'POST', url: '/v1/messages', headers } as never;
}

async function statusOf(decision: RoutingDecision | null): Promise<number | undefined> {
  if (!decision?.localHandler) return undefined;
  let status: number | undefined;
  const res = { headersSent: false, writeHead: (code: number) => { status = code; return res; }, end: () => res };
  await decision.localHandler({ res } as never);
  return status;
}

function installProviders(): void {
  const provider = (id: string, baseUrl: string, model: string) => buildUserProvider({
    id,
    name: id,
    runtimes: {
      'claude-code': {
        baseUrl,
        wireProtocol: 'anthropic-messages',
        models: [{ id: model, name: model }],
      },
    },
  });
  setCustomProviders([
    provider('shared-a', SHARED_UPSTREAM, 'shared-model'),
    provider('other-b', OTHER_UPSTREAM, 'other-model'),
  ]);
  setCustomProviderKeyReader((id) => `${id}-key`);
  setProviderViewsReader(async () => buildRegistry(getActiveCatalog(), { 'shared-a': true, 'other-b': true }));
}

describe('Claude proxy routing for shared-provider guests', () => {
  let transform: ReturnType<typeof createModelRoutingTransform>;

  beforeEach(() => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setClaudeProxySessionIdResolver(() => null);
    setPendingCredentialSwitchReader(() => undefined);
    setProviderOAuthTokenReader(() => null);
    installProviders();
    transform = createModelRoutingTransform();
  });

  afterEach(() => {
    resetGuestProviderRoutesForTest();
    clearAllSessionProviders();
    setCustomProviders([]);
    setCustomProviderKeyReader(() => null);
    setProviderViewsReader(async () => []);
  });

  it('uses the same header name as maker-core', () => {
    expect(GUEST_ROUTE_HEADER).toBe(DEVICE_HOSTED_GUEST_ROUTE_HEADER);
  });

  it('routes a guest request for a shared model to the shared provider and strips the token', async () => {
    const { token } = registerGuestProviderRoute('guest-session', 'shared-a');
    const decision = await Promise.resolve(transform(
      { model: 'shared-model' },
      ctxWith({ [GUEST_ROUTE_HEADER]: token, 'x-api-key': 'placeholder' }),
    ));
    expect(decision).toMatchObject({
      upstreamOverride: SHARED_UPSTREAM,
      headerOverride: { 'x-api-key': 'shared-a-key' },
    });
    expect(decision?.headerDelete).toContain(GUEST_ROUTE_HEADER);
  });

  it.each([
    ['a model of another provider on this computer', 'other-model'],
    ['a subscription-prefixed model', 'chatgpt/gpt-5.5'],
    ['an Anthropic model the shared provider does not offer', 'claude-haiku-4-5'],
  ])('refuses %s instead of re-routing it', async (_label, model) => {
    const { token } = registerGuestProviderRoute('guest-session', 'shared-a');
    const decision = await Promise.resolve(transform(
      { model },
      ctxWith({ [GUEST_ROUTE_HEADER]: token, 'x-api-key': 'sk-gw' }),
    ));
    expect(decision?.upstreamOverride).toBeUndefined();
    expect(await statusOf(decision)).toBe(403);
  });

  it('refuses an unknown or released route token', async () => {
    const unknown = await Promise.resolve(transform(
      { model: 'shared-model' },
      ctxWith({ [GUEST_ROUTE_HEADER]: 'forged', 'x-api-key': 'sk-gw' }),
    ));
    expect(await statusOf(unknown)).toBe(401);
    const binding = registerGuestProviderRoute('guest-session', 'shared-a');
    binding.release();
    const released = await Promise.resolve(transform(
      { model: 'shared-model' },
      ctxWith({ [GUEST_ROUTE_HEADER]: binding.token, 'x-api-key': 'sk-gw' }),
    ));
    expect(await statusOf(released)).toBe(401);
    expect(getSessionProvider('guest-session')).toBeNull();
  });

  it('refuses a body-less request unless the shared provider is the default gateway', async () => {
    const { token } = registerGuestProviderRoute('guest-session', 'shared-a');
    const decision = await Promise.resolve(transform(undefined, ctxWith({ [GUEST_ROUTE_HEADER]: token })));
    expect(await statusOf(decision)).toBe(403);
  });

  it('refuses a guest Pi request whose token belongs to another provider', async () => {
    registerGuestProviderRoute('pi-guest', 'shared-a');
    const disposeRoot = registerPiProxySession('pi-guest', 'root-token', () => 'shared-a');
    // 假设子代理令牌被签发给了本机的其它供应商：受邀者守门仍然拒绝。
    const disposeChild = registerPiProxySession('pi-guest', 'child-token', () => 'other-b', { scope: 'subagent-route' });
    try {
      const foreign = await Promise.resolve(transform({ model: 'other-model' }, ctxWith({
        'x-cindy-pi-session-id': 'pi-guest',
        'x-cindy-pi-session-token': 'child-token',
        'x-cindy-pi-provider-id': 'other-b',
      })));
      expect(await statusOf(foreign)).toBe(403);
      const gateway = await Promise.resolve(transform({ model: 'other-model' }, ctxWith({
        'x-cindy-pi-session-id': 'pi-guest',
        'x-cindy-pi-session-token': 'root-token',
        'x-cindy-pi-provider-id': 'xd',
      })));
      expect(await statusOf(gateway)).toBe(403);
      const shared = await Promise.resolve(transform({ model: 'shared-model' }, ctxWith({
        'x-cindy-pi-session-id': 'pi-guest',
        'x-cindy-pi-session-token': 'root-token',
        'x-cindy-pi-provider-id': 'shared-a',
      })));
      // 分享的供应商：受邀者守门放行，照常按会话来源路由(这里的 fixture 没有 Pi 运行时)。
      expect(await statusOf(shared)).not.toBe(403);
    } finally {
      disposeRoot();
      disposeChild();
    }
  });

  it('keeps requests without a route token on the existing routing (same-account unchanged)', async () => {
    const decision = await Promise.resolve(transform({ model: 'other-model' }, ctxWith({ 'x-api-key': 'sk-gw' })));
    expect(decision).toMatchObject({
      upstreamOverride: OTHER_UPSTREAM,
      headerOverride: { 'x-api-key': 'other-b-key' },
    });
  });
});

describe('guest provider route store', () => {
  afterEach(() => {
    resetGuestProviderRoutesForTest();
    clearAllSessionProviders();
    setCustomProviders([]);
  });

  it('binds the session provider, replaces an older binding and releases only its own', () => {
    const first = registerGuestProviderRoute('s1', 'shared-a');
    expect(getSessionProvider('s1')).toBe('shared-a');
    expect(guestProviderRouteForToken(first.token)).toEqual({ sessionId: 's1', providerId: 'shared-a' });
    const second = registerGuestProviderRoute('s1', 'shared-a');
    expect(guestProviderRouteForToken(first.token)).toBeNull();
    first.release();
    expect(guestProviderRouteForSession('s1')).toEqual({ sessionId: 's1', providerId: 'shared-a' });
    expect(getSessionProvider('s1')).toBe('shared-a');
    second.release();
    expect(guestProviderRouteForSession('s1')).toBeNull();
    expect(getSessionProvider('s1')).toBeNull();
  });

  it('stops honouring a token once the session provider is cleared', () => {
    const { token } = registerGuestProviderRoute('s1', 'shared-a');
    clearAllSessionProviders();
    expect(guestProviderRouteForToken(token)).toBeNull();
  });

  it('matches models of the shared provider only, ignoring the 1M suffix', () => {
    installProviders();
    expect(guestProviderOffersModel('shared-a', 'claude-code', 'shared-model')).toBe(true);
    expect(guestProviderOffersModel('shared-a', 'claude-code', 'shared-model[1m]')).toBe(true);
    expect(guestProviderOffersModel('shared-a', 'claude-code', 'other-model')).toBe(false);
    expect(guestProviderOffersModel('shared-a', 'codex', 'shared-model')).toBe(false);
    expect(guestProviderOffersModel('shared-a', 'claude-code', '')).toBe(false);
  });

  it('keeps only the shared provider\'s Codex routes for a guest host', () => {
    const routes = [{ providerId: 'shared-a', routeId: 'a' }, { providerId: 'other-b', routeId: 'b' }];
    expect(restrictCodexRoutesToGuestProvider(routes, 'shared-a')).toEqual([{ providerId: 'shared-a', routeId: 'a' }]);
    expect(restrictCodexRoutesToGuestProvider(routes, 'xd')).toEqual([]);
    expect(restrictCodexRoutesToGuestProvider(routes, undefined)).toBe(routes);
  });
});
