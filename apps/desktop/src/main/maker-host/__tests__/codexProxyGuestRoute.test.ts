/**
 * 供应商分享受邀者任务独占的 Codex proxy：推理请求的模型必须由分享的供应商提供，请求必须属于
 * 登记过的受邀者会话；认不出会话时只有分享的是网关 / ChatGPT 订阅且鉴权形态一致才按默认路由直达，
 * 不做按模型的隐式推断。自定义供应商路径(冻结路由只有分享的那一个)与控制面请求照常。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp/cindy-codex-guest-test'), getAppPath: vi.fn(() => process.cwd()) },
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../../logger.js', () => {
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => logger, getLogLevel: () => 'info', getLogDir: () => '/tmp/cindy-codex-guest-test/logs' };
});
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

import { buildUserProvider } from '@cindy/model-providers';
import type { RoutingDecision } from '@cindy/anthropic-compat-proxy';

import { getActiveCatalog, setCustomProviders, setDiscoveredCodexModels } from '../active-catalog';
import { createCodexGuestRoutingGuard, createModelRoutingTransform, registerComposed, registerReviewerRouteContext, unregister } from '../codex-proxy-host';
import { CODEX_CUSTOM_PROVIDER_ROUTE_ROOT, deriveCodexCustomProviderRoutes } from '../codex-custom-provider-route';
import { registerGuestProviderRoute, resetGuestProviderRoutesForTest } from '../guest-provider-route-store';
import { bindHostedSessionProvider, clearAllSessionProviders, setSessionProvider } from '../session-provider-store';
import { setCustomProviderKeyReader } from '../provider-route';

function ctx(url: string, headers: Record<string, string> = {}, method = 'POST') {
  return { reqId: 1, method, url, headers } as never;
}

async function statusOf(input: RoutingDecision | null | undefined | Promise<RoutingDecision | null | undefined>): Promise<number | undefined> {
  const decision = await input;
  if (!decision?.localHandler) return undefined;
  let status: number | undefined;
  const res = { headersSent: false, writeHead: (code: number) => { status = code; return res; }, end: () => res };
  await decision.localHandler({ res } as never);
  return status;
}

describe('Codex proxy guard for shared-provider guests', () => {
  beforeEach(() => {
    const provider = (id: string, model: string) => buildUserProvider({
      id,
      name: id,
      runtimes: { codex: { baseUrl: `https://${id}.example/v1`, wireProtocol: 'openai-responses', models: [{ id: model, name: model }] } },
    });
    setCustomProviders([provider('shared-a', 'shared-model'), provider('other-b', 'other-model')]);
    registerGuestProviderRoute('guest-session', 'shared-a');
    registerComposed('guest-session', 'guest-thread', 'prompt');
  });

  afterEach(() => {
    unregister('guest-session');
    unregister('owner-session');
    unregister('local-session');
    resetGuestProviderRoutesForTest();
    clearAllSessionProviders();
    setCustomProviders([]);
    setCustomProviderKeyReader(() => null);
    setDiscoveredCodexModels([]);
  });

  it('authorizes an owner Guardian request using the registered parent model', async () => {
    let allowed = true;
    const parentModel = 'gpt-5.5';
    setDiscoveredCodexModels([{ id: parentModel, name: parentModel, contextWindow: 272000, efforts: [], defaultEffort: null }]);
    bindHostedSessionProvider('owner-session', 'openai', (providerId, model) => allowed && providerId === 'openai' && model === parentModel);
    registerReviewerRouteContext('owner-session', 'owner-thread', parentModel);
    const transform = createModelRoutingTransform('oauth-bearer');
    const request = () => transform({ model: 'codex-auto-review' }, ctx('/responses', {
      'thread-id': 'owner-review', 'x-openai-subagent': 'guardian', 'x-codex-parent-thread-id': 'owner-thread',
    }));
    expect(await request()).toMatchObject({ upstreamOverride: 'https://chatgpt.com/backend-api/codex' });
    allowed = false;
    expect(await statusOf(await request())).toBe(403);
  });

  it('lets a guest request for a shared model continue to the session route', async () => {
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key');
    expect(await guard({ model: 'shared-model' }, ctx('/responses', { 'thread-id': 'guest-thread' }))).toBeUndefined();
  });

  it('refuses a model the shared provider does not offer, even from the guest session', async () => {
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key');
    expect(await statusOf(guard({ model: 'other-model' }, ctx('/responses', { 'thread-id': 'guest-thread' })))).toBe(403);
    expect(await statusOf(guard({ model: 'codex/gpt-5.5' }, ctx('/responses', { 'thread-id': 'guest-thread' })))).toBe(403);
  });

  // A member allowlist must also guard the frozen custom path and take effect without restarting the task.
  it('rechecks model grants for custom routes and refuses requests without a task identity', async () => {
    let allowed = true;
    registerGuestProviderRoute('guest-session', 'shared-a', (model) => allowed && model === 'shared-model', () => true);
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key');
    const path = `${CODEX_CUSTOM_PROVIDER_ROUTE_ROOT}/0123456789abcdef0123/responses`;
    const request = () => guard({ model: 'shared-model' }, ctx(path, { 'thread-id': 'guest-thread' }));
    expect(await request()).toBeUndefined();
    expect(await statusOf(guard({ model: 'shared-model' }, ctx(path)))).toBe(403);
    allowed = false;
    expect(await statusOf(request())).toBe(403);
    expect(await statusOf(guard({ model: 'other-model' }, ctx(path, { 'thread-id': 'guest-thread' })))).toBe(403);
  });

  // Unit regression for review 4327641928 / provider-sharing §12. Guest-only tests
  // missed same-account hosted requests. Minimum: authorized parent A and child B
  // at the same provider; the production proxy must deny B and observe live grants.
  it.each(['ordinary', 'custom'].flatMap(pathKind => ['shared-a', 'other-b'].map(childProvider => ({ pathKind, childProvider }))))('checks same-account child grants on $pathKind routes to $childProvider', async ({ pathKind, childProvider }) => {
    setCustomProviders(['shared-a', 'other-b'].map(id => buildUserProvider({ id, name: id, runtimes: {
      codex: { baseUrl: `https://${id}.example/v1`, wireProtocol: 'openai-responses', supportsImageGeneration: true,
        models: ['shared-model', 'private-model'].map(id => ({ id, name: id })) },
    } })));
    setCustomProviderKeyReader(() => 'fixture-key');
    let allowedModel = 'shared-model';
    bindHostedSessionProvider('owner-session', 'shared-a', (id, model) => model === allowedModel && id === (model === 'shared-model' ? 'shared-a' : childProvider));
    registerComposed('owner-session', 'owner-thread', 'prompt', {
      subagentRoute: { providerId: childProvider, catalogModel: 'private-model', reasoningEffort: null },
    });
    const routes = deriveCodexCustomProviderRoutes(getActiveCatalog());
    const path = pathKind === 'custom' ? `${CODEX_CUSTOM_PROVIDER_ROUTE_ROOT}/${routes[0].routeId}/responses` : '/responses';
    const transform = createModelRoutingTransform('env-key', routes);
    const request = (child: boolean) => transform({ model: 'shared-model' }, ctx(path, child ? {
      'thread-id': 'owner-child', 'x-openai-subagent': 'collab_spawn', 'x-codex-parent-thread-id': 'owner-thread',
    } : { 'thread-id': 'owner-thread' }));
    expect(await request(false)).toMatchObject({ upstreamOverride: 'https://shared-a.example/v1' });
    expect(await statusOf(await request(true))).toBe(403);
    allowedModel = 'private-model';
    expect(await request(true)).toMatchObject({ upstreamOverride: `https://${childProvider}.example/v1` });
    allowedModel = '';
    expect(await statusOf(await request(true))).toBe(403);
    setSessionProvider('local-session', 'shared-a');
    registerComposed('local-session', 'local-thread', 'prompt');
    expect(await transform({ model: 'private-model' }, ctx(path, { 'thread-id': 'local-thread' })))
      .toMatchObject({ upstreamOverride: 'https://shared-a.example/v1' });
  });

  // Unit regression for review 4326610462: the public guard must authorize Guardian's
  // actual reviewer model, including live revocation. Existing tests only sent catalog ids;
  // the minimal failure is an allowlisted parent with the internal codex-auto-review marker.
  it.each([
    ['shared-a', '/responses'],
    ['shared-a', `${CODEX_CUSTOM_PROVIDER_ROUTE_ROOT}/0123456789abcdef0123/responses`],
    ['openai', '/responses'],
  ])('authorizes Guardian by its parent model on %s %s', async (providerId, path) => {
    const model = providerId === 'openai' ? 'gpt-5.5' : 'shared-model';
    let allowed = true;
    registerGuestProviderRoute('guest-session', providerId, candidate => allowed && candidate === model, () => true);
    registerReviewerRouteContext('guest-session', 'guest-thread', model);
    const guard = createCodexGuestRoutingGuard(providerId, providerId === 'openai' ? 'oauth-bearer' : 'env-key', 'guest-session');
    const body = { model: 'codex-auto-review' };
    const request = () => guard(body, ctx(path, {
      'thread-id': 'guardian-child',
      'x-openai-subagent': 'guardian',
      'x-codex-parent-thread-id': 'guest-thread',
    }));
    expect(await request()).toBeUndefined();
    expect(await statusOf(guard(body, ctx(path, { 'thread-id': 'guest-thread' })))).toBe(403);
    allowed = false;
    expect(await statusOf(request())).toBe(403);
  });

  it('refuses requests that do not belong to the registered guest session', async () => {
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key');
    // 认不出会话：分享的是自定义供应商，没有可直达的默认路由。
    expect(await statusOf(guard({ model: 'shared-model' }, ctx('/responses')))).toBe(403);
    // 会话属于本机用户自己的任务。
    setSessionProvider('owner-session', 'shared-a');
    registerComposed('owner-session', 'owner-thread', 'prompt');
    expect(await statusOf(guard({ model: 'shared-model' }, ctx('/responses', { 'thread-id': 'owner-thread' })))).toBe(403);
  });

  // A guest Codex fork binds its proxy to the fork host's own key, which is never registered:
  // thread/fork and rollback need no upstream, so every request must be refused, including
  // control-plane GETs and headers that name another guest's registered thread.
  it('refuses everything for a proxy bound to an unregistered guest session', async () => {
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key', 'local-fork:00000000-0000-4000-8000-000000000000');
    expect(await statusOf(guard({ model: 'shared-model' }, ctx('/responses')))).toBe(403);
    expect(await statusOf(guard(undefined, ctx('/models', {}, 'GET')))).toBe(403);
    expect(await statusOf(guard({ model: 'shared-model' }, ctx('/responses', { 'thread-id': 'guest-thread' })))).toBe(403);
    expect(await statusOf(guard({ model: 'other-model' }, ctx(`${CODEX_CUSTOM_PROVIDER_ROUTE_ROOT}/0123456789abcdef0123/responses`)))).toBe(403);
  });

  it('routes an unresolved request straight to the default upstream only when that is the shared provider', async () => {
    const gateway = createCodexGuestRoutingGuard('xd', 'env-key');
    // 模型核对按 xd 的目录：这里的 fixture 没有 xd 模型，所以推理请求被拒；非推理路径只看默认路由。
    expect(await gateway({ model: 'gpt-image-1' }, ctx('/images/generations'))).toBeNull();
    const mismatched = createCodexGuestRoutingGuard('xd', 'oauth-bearer');
    return statusOf(mismatched({ model: 'gpt-image-1' }, ctx('/images/generations')))
      .then((status) => expect(status).toBe(403));
  });

  it('leaves custom-provider paths and control-plane requests to the frozen routing', async () => {
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key');
    expect(await guard({ model: 'other-model' }, ctx(`${CODEX_CUSTOM_PROVIDER_ROUTE_ROOT}/0123456789abcdef0123/responses`))).toBeUndefined();
    expect(await guard(undefined, ctx('/models', {}, 'GET'))).toBeUndefined();
  });
});
