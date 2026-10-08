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

import { setCustomProviders } from '../active-catalog';
import { createCodexGuestRoutingGuard, registerComposed, unregister } from '../codex-proxy-host';
import { CODEX_CUSTOM_PROVIDER_ROUTE_ROOT } from '../codex-custom-provider-route';
import { registerGuestProviderRoute, resetGuestProviderRoutesForTest } from '../guest-provider-route-store';
import { clearAllSessionProviders, setSessionProvider } from '../session-provider-store';

function ctx(url: string, headers: Record<string, string> = {}, method = 'POST') {
  return { reqId: 1, method, url, headers } as never;
}

async function statusOf(decision: RoutingDecision | null | undefined): Promise<number | undefined> {
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
    resetGuestProviderRoutesForTest();
    clearAllSessionProviders();
    setCustomProviders([]);
  });

  it('lets a guest request for a shared model continue to the session route', () => {
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key');
    expect(guard({ model: 'shared-model' }, ctx('/responses', { 'thread-id': 'guest-thread' }))).toBeUndefined();
  });

  it('refuses a model the shared provider does not offer, even from the guest session', async () => {
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key');
    expect(await statusOf(guard({ model: 'other-model' }, ctx('/responses', { 'thread-id': 'guest-thread' })))).toBe(403);
    expect(await statusOf(guard({ model: 'codex/gpt-5.5' }, ctx('/responses', { 'thread-id': 'guest-thread' })))).toBe(403);
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

  it('routes an unresolved request straight to the default upstream only when that is the shared provider', () => {
    const gateway = createCodexGuestRoutingGuard('xd', 'env-key');
    // 模型核对按 xd 的目录：这里的 fixture 没有 xd 模型，所以推理请求被拒；非推理路径只看默认路由。
    expect(gateway({ model: 'gpt-image-1' }, ctx('/images/generations'))).toBeNull();
    const mismatched = createCodexGuestRoutingGuard('xd', 'oauth-bearer');
    return statusOf(mismatched({ model: 'gpt-image-1' }, ctx('/images/generations')))
      .then((status) => expect(status).toBe(403));
  });

  it('leaves custom-provider paths and control-plane requests to the frozen routing', () => {
    const guard = createCodexGuestRoutingGuard('shared-a', 'env-key');
    expect(guard({ model: 'other-model' }, ctx(`${CODEX_CUSTOM_PROVIDER_ROUTE_ROOT}/0123456789abcdef0123/responses`))).toBeUndefined();
    expect(guard(undefined, ctx('/models', {}, 'GET'))).toBeUndefined();
  });
});
