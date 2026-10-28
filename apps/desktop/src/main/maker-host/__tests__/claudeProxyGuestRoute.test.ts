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
vi.mock('../anthropic-responses-bridge-host', () => ({
  getResponsesBridgeHandler: () => ({ handle: async ({ res }: { res: { writeHead(status: number): void; end(): void } }) => {
    res.writeHead(204);
    res.end();
  } }),
  getPiNativeSubscriptionHandler: () => async ({ res }: { res: { writeHead(status: number): void; end(): void } }) => {
    res.writeHead(204);
    res.end();
  },
}));

import { DEVICE_HOSTED_GUEST_ROUTE_HEADER } from '@cindy/maker-core';
import { buildRegistry, buildUserProvider } from '@cindy/model-providers';
import type { RoutingDecision } from '@cindy/anthropic-compat-proxy';

import {
  createModelRoutingTransform,
  setClaudeProxyGatewayKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import { getActiveCatalog, setCustomProviders, setXdGatewayModels } from '../active-catalog';
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
import { bindHostedSessionProvider, clearAllSessionProviders, getSessionProvider } from '../session-provider-store';
import { registerPiProxySession } from '../pi-proxy-session-auth';

const SHARED_UPSTREAM = 'https://shared.example/api/anthropic';
const OTHER_UPSTREAM = 'https://other.example/api/anthropic';

function ctxWith(headers: Record<string, string>) {
  return { reqId: 1, method: 'POST', url: '/v1/messages', headers };
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
      pi: {
        baseUrl,
        wireProtocol: 'anthropic-messages',
        models: [{ id: model, name: model }, { id: `${model}-private`, name: `${model}-private` }],
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
    setXdGatewayModels(['google/gemini-3.7-flash', 'gemini-3.6-flash'].map(id => ({ id, agents: ['pi'] })));
    installProviders();
    transform = createModelRoutingTransform();
  });

  afterEach(() => {
    resetGuestProviderRoutesForTest();
    clearAllSessionProviders();
    setCustomProviders([]);
    setXdGatewayModels([]);
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

  // The catalog offers this model, but each person's current grant must remain the authority.
  it('isolates model grants for two people and enforces revocation on the next proxy request', async () => {
    let allowed = true;
    const first = registerGuestProviderRoute('first-person', 'shared-a', () => allowed);
    const second = registerGuestProviderRoute('second-person', 'shared-a', () => false);
    const request = (token: string) => Promise.resolve(transform(
      { model: 'shared-model' }, ctxWith({ [GUEST_ROUTE_HEADER]: token, 'x-api-key': 'placeholder' }),
    ));
    expect((await request(first.token))?.upstreamOverride).toBe(SHARED_UPSTREAM);
    expect(await statusOf(await request(second.token))).toBe(403);
    allowed = false;
    expect(await statusOf(await request(first.token))).toBe(403);
  });

  // Unit regression for review 4327117965: the real proxy must return 403 when
  // only the other catalog profile is granted. Existing coverage had one model
  // with a compatible [1m] wire alias, never two independently authorized entries.
  it.each([
    ['shared-model', 'shared-model[1m]'],
    ['shared-model[1m]', 'shared-model'],
  ])('keeps 1M catalog profiles distinct when only %s is granted', async (granted, denied) => {
    setCustomProviders([buildUserProvider({
      id: 'shared-a', name: 'Shared', runtimes: { 'claude-code': {
        baseUrl: SHARED_UPSTREAM, wireProtocol: 'anthropic-messages',
        models: [{ id: 'shared-model', name: 'Standard' }, { id: 'shared-model[1m]', name: '1M' }],
      } },
    })]);
    const { token } = registerGuestProviderRoute('guest-session', 'shared-a', model => model === granted);
    const request = (model: string) => Promise.resolve(transform(
      { model }, ctxWith({ [GUEST_ROUTE_HEADER]: token, 'x-api-key': 'placeholder' }),
    ));
    expect((await request(granted))?.upstreamOverride).toBe(SHARED_UPSTREAM);
    expect(await statusOf(await request(denied))).toBe(403);
    if (denied.endsWith('[1m]')) expect(await statusOf(await request(denied.replace('[1m]', '[1M]')))).toBe(403);
  });

  it('keeps disabled 1M catalog profiles from borrowing an enabled base profile', async () => {
    const provider = buildUserProvider({
      id: 'shared-a', name: 'Shared', runtimes: { 'claude-code': {
        baseUrl: SHARED_UPSTREAM, wireProtocol: 'anthropic-messages',
        models: [{ id: 'shared-model', name: 'Standard' }, { id: 'shared-model[1m]', name: '1M' }],
      } },
    });
    provider.models['claude-code']![1]!.disabled = true;
    setCustomProviders([provider]);
    const { token } = registerGuestProviderRoute('guest-session', 'shared-a', () => true);
    const decision = await Promise.resolve(transform(
      { model: 'shared-model[1m]' }, ctxWith({ [GUEST_ROUTE_HEADER]: token, 'x-api-key': 'placeholder' }),
    ));
    expect(await statusOf(decision)).toBe(403);
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
      expect(shared?.upstreamOverride).toBe(SHARED_UPSTREAM);
    } finally {
      disposeRoot();
      disposeChild();
    }
  });

  // Unit regression for #6592 / provider-sharing §12: the production routing transform must
  // deny an ungranted Pi model before any upstream/native handler. Earlier coverage only
  // changed providers. Minimal failure: two models at one provider, only the first granted.
  it.each(['guest', 'owner'].flatMap(trust => ['shared-a', 'openai', 'xai', 'xd'].map(providerId => ({ trust, providerId }))))('rechecks live Pi model grants for $trust $providerId root and child routes', async ({ trust, providerId }) => {
    const models = getActiveCatalog().providers.find(provider => provider.id === providerId)!.models.pi!;
    const [first, second] = models.filter(model => !model.disabled);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const wireId = (id: string) => providerId === 'openai' ? id.replace(/^chatgpt\//, '')
      : providerId === 'xai' ? id.replace(/^xai\//, '') : id;
    let allowedModel = first.id;
    if (trust === 'guest') registerGuestProviderRoute('pi-model-guest', providerId, async model => model === allowedModel);
    else bindHostedSessionProvider('pi-model-guest', providerId, (id, model) => id === providerId && model === allowedModel);
    registerGuestProviderRoute('other-person', providerId, () => false);
    const disposers = [
      registerPiProxySession('pi-model-guest', 'root-token', () => providerId),
      registerPiProxySession('pi-model-guest', 'child-token', () => providerId, { scope: 'subagent-route' }),
      registerPiProxySession('other-person', 'other-token', () => providerId),
      registerPiProxySession('local-pi', 'local-token', () => providerId),
    ];
    const request = (model: string, token: string, sessionId = 'pi-model-guest') => Promise.resolve(transform(
      providerId === 'xd' ? { contents: [] } : { model: wireId(model) }, { ...ctxWith({
        'x-cindy-pi-session-id': sessionId,
        'x-cindy-pi-session-token': token,
        'x-cindy-pi-provider-id': providerId,
      }), ...(providerId === 'xd' ? { url: `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse` } : {}) },
    ));
    const expectAllowed = async (decision: RoutingDecision | null) => {
      if (providerId === 'openai' || providerId === 'xai') expect(await statusOf(decision)).toBe(204);
      else if (providerId === 'xd') expect(decision?.headerOverride?.authorization).toBe('Bearer sk-gw');
      else expect(decision?.upstreamOverride).toBe(SHARED_UPSTREAM);
    };
    try {
      for (const token of ['root-token', 'child-token']) {
        await expectAllowed(await request(first.id, token));
        expect(await statusOf(await request(second.id, token))).toBe(403);
        expect(await statusOf(await request('unknown-model', token))).toBe(403);
        expect(await statusOf(await request('', token))).toBe(403);
      }
      expect(await statusOf(await request(first.id, 'other-token', 'other-person'))).toBe(403);
      const forgedPath = { ...ctxWith({
        'x-cindy-pi-session-id': 'pi-model-guest',
        'x-cindy-pi-session-token': 'root-token',
        'x-cindy-pi-provider-id': providerId,
      }), url: `/v1beta/models/${encodeURIComponent(first.id)}:streamGenerateContent` };
      // A URL naming an allowed model cannot hide a different/opaque subscription body.
      expect(await statusOf(await transform({ model: wireId(second.id) }, forgedPath))).toBe(403);
      expect(await statusOf(await transform(undefined, forgedPath))).toBe(403);
      if (providerId === 'xd') {
        expect(await statusOf(await transform({ model: first.id }, {
          ...forgedPath, url: `/v1beta/models/${encodeURIComponent(second.id)}:streamGenerateContent`,
        }))).toBe(403);
      }
      // A live change must revoke the old model and allow the newly granted model without restart.
      allowedModel = second.id;
      for (const token of ['root-token', 'child-token']) {
        expect(await statusOf(await request(first.id, token))).toBe(403);
        await expectAllowed(await request(second.id, token));
      }
      // Local Pi is independent of restrictions on guests sharing the same provider.
      await expectAllowed(await request(first.id, 'local-token', 'local-pi'));
    } finally {
      for (const dispose of disposers) dispose();
    }
  });

  it('allows an authorized owner child provider independently of the parent provider', async () => {
    let childAllowed = true;
    bindHostedSessionProvider('owner-parent', 'shared-a', (providerId, model) => childAllowed && providerId === 'other-b' && model === 'other-model');
    const dispose = registerPiProxySession('owner-parent', 'owner-child', () => 'other-b', { scope: 'subagent-route' });
    const request = () => transform({ model: 'other-model' }, ctxWith({
      'x-cindy-pi-session-id': 'owner-parent', 'x-cindy-pi-session-token': 'owner-child', 'x-cindy-pi-provider-id': 'other-b',
    }));
    try {
      expect(await request()).toMatchObject({ upstreamOverride: OTHER_UPSTREAM });
      childAllowed = false;
      expect(await statusOf(await request())).toBe(403);
    } finally { dispose(); }
  });

  // Unit regression for review 4328205893 / provider-sharing §12. Pi coverage
  // missed CC's per-request provider inference. A hosted child must use
  // the actual custom/subscription provider's live grant, not its parent's.
  it.each(['implicit', 'subscription'])('authorizes the resolved Claude child provider on the %s route', async (routeKind) => {
    const childProvider = routeKind === 'implicit' ? 'other-b' : 'xai';
    const parentProvider = routeKind === 'implicit' ? 'xai' : 'xd';
    const model = routeKind === 'implicit' ? 'other-model' : getActiveCatalog().providers.find(p => p.id === 'xai')!.models['claude-code']![0].id;
    let childAllowed = true;
    bindHostedSessionProvider('owner-parent', parentProvider, (providerId, id) => childAllowed && providerId === childProvider && id === model);
    setClaudeProxySessionIdResolver(() => 'owner-parent');
    const request = () => transform({ model }, ctxWith({ 'x-claude-code-session-id': 'owner-sdk', 'x-api-key': 'sk-gw' }));
    if (routeKind === 'implicit') expect(await request()).toMatchObject({ upstreamOverride: OTHER_UPSTREAM });
    else expect(await statusOf(await request())).toBe(204);
    childAllowed = false;
    expect(await statusOf(await request())).toBe(403);
    // Granting only the parent cannot authorize a request routed elsewhere.
    bindHostedSessionProvider('owner-parent', parentProvider, providerId => providerId === parentProvider);
    expect(await statusOf(await request())).toBe(403);
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

  it('matches models of the shared provider only, ignoring the 1M suffix', async () => {
    installProviders();
    expect(await guestProviderOffersModel('shared-a', 'claude-code', 'shared-model')).toBe(true);
    expect(await guestProviderOffersModel('shared-a', 'claude-code', 'shared-model[1m]')).toBe(true);
    expect(await guestProviderOffersModel('shared-a', 'claude-code', 'other-model')).toBe(false);
    expect(await guestProviderOffersModel('shared-a', 'codex', 'shared-model')).toBe(false);
    expect(await guestProviderOffersModel('shared-a', 'claude-code', '')).toBe(false);
  });

  it('keeps only the shared provider\'s Codex routes for a guest host', () => {
    const routes = [{ providerId: 'shared-a', routeId: 'a' }, { providerId: 'other-b', routeId: 'b' }];
    expect(restrictCodexRoutesToGuestProvider(routes, 'shared-a')).toEqual([{ providerId: 'shared-a', routeId: 'a' }]);
    expect(restrictCodexRoutesToGuestProvider(routes, 'xd')).toEqual([]);
    expect(restrictCodexRoutesToGuestProvider(routes, undefined)).toBe(routes);
  });
});
