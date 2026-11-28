/**
 * Integration, Refs #11306: exercise real /responses HTTP on the Desktop Codex
 * proxy. A retired built-in model on a hosted owner task should receive a safe
 * model error. Routing unit tests do not verify the reply or upstream dispatch.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { BUNDLED_CATALOG, buildUserProvider, type Catalog } from '@cindy/model-providers';
import { expect, it, onTestFinished, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ upstream: '', catalog: undefined as Catalog | undefined }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} }),
  getLogLevel: () => 'info',
  getLogDir: tmpdir,
}));
vi.mock('../../clientEndpointsService.js', async () => {
  const { TEST_CLIENT_ENDPOINTS } = await import('../../../test/vitest/clientEndpointsFixture');
  return { getClientEndpoint: (key: keyof typeof TEST_CLIENT_ENDPOINTS) => TEST_CLIENT_ENDPOINTS[key] };
});
vi.mock('../../model-access/effectiveEndpoint.js', () => ({ effectiveXdGatewayBaseUrl: () => fixture.upstream }));
vi.mock('../codex-gateway-config.desktop.js', async importOriginal => ({
  ...await importOriginal<typeof import('../codex-gateway-config.desktop.js')>(),
  get CODEX_OAUTH_UPSTREAM() { return fixture.upstream; },
}));
vi.mock('../outbound-proxy-resolver.js', () => ({ resolveDesktopOutboundProxy: () => null }));
vi.mock('../silent-encrypted-retry-store.js', () => ({ readSilentEncryptedRetrySettings: () => ({ enabled: false }) }));
vi.mock('../active-catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../active-catalog.js')>(),
  getActiveCatalog: () => {
    if (!fixture.catalog) throw new Error('Fixture catalog not configured');
    return fixture.catalog;
  },
}));

it('explains built-in hosted model refusal and preserves custom and local behavior', async () => {
  const forwarded: string[] = [];
  let withdrawn = false;
  const api = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const { model } = JSON.parse(Buffer.concat(parts).toString('utf8'));
    forwarded.push(model);
    res.writeHead(!withdrawn || model === 'synthetic-healthy' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ syntheticUpstream: true }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  onTestFinished(async () => {
    api.closeAllConnections();
    await new Promise<void>(resolve => api.close(() => resolve()));
  });
  fixture.upstream = 'http://127.0.0.1:' + (api.address() as AddressInfo).port;
  const openai = BUNDLED_CATALOG.providers.find(provider => provider.id === 'openai')!;
  const healthy = { ...openai.models.codex![0]!, id: 'synthetic-healthy' };
  const retired = { ...healthy, id: 'synthetic-retired' };
  const routing = openai.routing.codex!;
  const builtin = { ...openai, models: { codex: [healthy, retired] },
    routing: { codex: { ...routing, upstream: fixture.upstream } } };
  const custom = buildUserProvider({ id: 'synthetic-custom', name: 'Synthetic custom', runtimes: {
    codex: { baseUrl: fixture.upstream, wireProtocol: 'openai-responses', supportsImageGeneration: true,
      models: [{ id: retired.id, name: retired.id }] },
  } });
  fixture.catalog = { ...BUNDLED_CATALOG, modelRegistry: undefined, providers: [builtin, custom] };
  const sessions = await import('../session-provider-store.js');
  const proxy = await import('../codex-proxy-host.desktop.js');
  const { deriveCodexCustomProviderRoutes } = await import('../codex-custom-provider-route.js');
  const [customRoute] = deriveCodexCustomProviderRoutes(fixture.catalog);
  expect(customRoute?.providerId).toBe(custom.id);
  proxy.setCodexAppliedCustomProviderRoutes([customRoute!]);
  proxy.setCodexProxyAuthInjection('oauth-bearer');
  proxy.setCodexProxyGatewayKeyReader(() => null);
  sessions.setSessionProvider('local-session', 'openai');
  const hosted = sessions.bindHostedSessionProvider('hosted-session', 'openai', () => true);
  const customHosted = sessions.bindHostedSessionProvider('custom-session', custom.id, () => true);
  proxy.registerComposed('local-session', 'local-thread', '');
  proxy.registerComposed('hosted-session', 'hosted-thread', '');
  proxy.registerComposed('custom-session', 'custom-thread', '');
  try {
    await proxy.ensureCodexProxyReady();
    expect(proxy.isCodexProxyHandleReady()).toBe(true);
    const endpoint = proxy.getCodexProxyEndpoint();
    expect(new URL(endpoint).hostname).toBe('127.0.0.1');
    const send = (thread: string, model: string, path = '/responses') => fetch(new URL(path, endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'thread-id': thread, authorization: 'Bearer synthetic' },
      body: JSON.stringify({ model, input: 'fixture' }),
      signal: AbortSignal.timeout(4000),
    });
    for (const thread of ['local-thread', 'hosted-thread']) {
      const offered = await send(thread, retired.id);
      expect(offered.status).toBe(200);
      await offered.json();
    }
    fixture.catalog = { ...fixture.catalog, providers: [
      { ...builtin, models: { codex: [healthy] } },
      { ...custom, models: { codex: [] } },
    ] };
    withdrawn = true;

    const denied = await send('hosted-thread', retired.id);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(await denied.json()).toEqual({ error: {
      type: 'invalid_request_error',
      code: 'remote_model_not_allowed',
      message: 'This model is not available for this remote task.',
    } });

    for (const path of ['/responses', `/_cindy/custom-provider/${customRoute!.routeId}/responses`]) {
      const customDenied = await send('custom-thread', retired.id, path);
      expect(customDenied.status).toBe(403);
      expect(await customDenied.json()).toEqual({ error: {
        type: 'invalid_request_error',
        code: 'remote_model_not_allowed',
        message: 'This custom Provider route is unavailable.',
      } });
    }

    const healthyResult = await send('hosted-thread', healthy.id);
    expect(healthyResult.status).toBe(200);
    expect(await healthyResult.json()).toEqual({ syntheticUpstream: true });

    const localResult = await send('local-thread', retired.id);
    expect(localResult.status).toBe(404);
    expect(await localResult.json()).toEqual({ syntheticUpstream: true });
    expect(forwarded).toEqual([retired.id, retired.id, healthy.id, retired.id]);
  } finally {
    await proxy.disposeCodexProxy();
    hosted.release();
    customHosted.release();
    sessions.clearSessionProvider('local-session');
  }
}, 15_000);
