import { describe, it, expect, vi } from 'vitest';

import { BUNDLED_CATALOG, connectedProvidersForAgent } from '@cindy/model-providers';

import { createProviderService } from '../provider-service.js';

/** 注入内置 bundled 目录作为「当前生效目录」(桌面端真实注入的是 active-catalog 的 getActiveCatalog)。 */
const bundledCatalog = () => BUNDLED_CATALOG;

describe('createProviderService', () => {
  it('lists providers with injected connection state', async () => {
    const svc = createProviderService({
      getCatalog: bundledCatalog,
      connection: { xd: () => true, anthropic: () => false, openai: () => false, xai: () => false },
    });
    const providers = await svc.listProviders();
    const byId = Object.fromEntries(providers.map((p) => [p.id, p.connected]));
    expect(byId).toEqual({ anthropic: false, openai: false, xai: false, xd: true });
  });

  it('reflects live connection changes (catalog read fresh each call)', async () => {
    let xdConnected = false;
    const getCatalog = vi.fn(bundledCatalog);
    const svc = createProviderService({
      getCatalog,
      connection: { xd: () => xdConnected, anthropic: () => false, openai: () => false, xai: () => false },
    });

    expect((await svc.listProviders()).find((p) => p.id === 'xd')!.connected).toBe(false);
    xdConnected = true;
    expect((await svc.listProviders()).find((p) => p.id === 'xd')!.connected).toBe(true);
    // 目录每次现读(active-catalog 已持有进程级单例,零额外 IO);连接态实时反映。
    expect(getCatalog).toHaveBeenCalledTimes(2);
  });

  it('supports async connection readers (codex oauth)', async () => {
    const svc = createProviderService({
      getCatalog: bundledCatalog,
      connection: {
        xd: () => false,
        anthropic: () => false,
        openai: async () => true,
        xai: () => false,
      },
    });
    const openai = (await svc.listProviders()).find((p) => p.id === 'openai')!;
    expect(openai.connected).toBe(true);
  });

  it('treats catalog no-auth providers as connected without credentials', async () => {
    const noAuthProvider = {
      ...BUNDLED_CATALOG.providers[0],
      id: 'local-no-auth',
      name: 'Local no-auth',
      auth: { method: 'none' as const },
    };
    const svc = createProviderService({
      getCatalog: () => ({
        version: 'no-auth-test',
        providers: [...BUNDLED_CATALOG.providers, noAuthProvider],
      }),
      connection: {
        xd: () => false,
        anthropic: () => false,
        openai: () => false,
        xai: () => false,
      },
    });

    expect(
      (await svc.listProviders()).find((provider) => provider.id === noAuthProvider.id)?.connected,
    ).toBe(true);
  });

  it('keeps a disabled legacy no-auth provider disconnected', async () => {
    const base = BUNDLED_CATALOG.providers[0];
    const disabledProvider = {
      ...base,
      id: 'legacy-remote-no-auth',
      name: 'Legacy remote no-auth',
      auth: { method: 'none' as const },
      routing: Object.fromEntries(
        Object.entries(base.routing).map(([agent, routing]) => [
          agent,
          routing ? { ...routing, disabled: true } : routing,
        ]),
      ),
    };
    const svc = createProviderService({
      getCatalog: () => ({
        version: 'disabled-no-auth-test',
        providers: [disabledProvider],
      }),
      connection: {
        xd: () => false,
        anthropic: () => false,
        openai: () => false,
        xai: () => false,
      },
    });

    expect((await svc.listProviders())[0]?.connected).toBe(false);
  });

  it('keeps a no-auth provider disconnected when its declared runtime has no routing descriptor', async () => {
    const base = BUNDLED_CATALOG.providers[0];
    const missingRouteProvider = {
      ...base,
      id: 'missing-route-no-auth',
      name: 'Missing route no-auth',
      auth: { method: 'none' as const },
      routing: {},
    };
    const svc = createProviderService({
      getCatalog: () => ({ version: 'missing-route-no-auth-test', providers: [missingRouteProvider] }),
      connection: {
        xd: () => false,
        anthropic: () => false,
        openai: () => false,
        xai: () => false,
      },
    });

    const providers = await svc.listProviders();
    expect(providers[0]?.connected).toBe(false);
    expect(connectedProvidersForAgent(providers, base.agents[0]!)).toHaveLength(0);
  });

  it('does not promote a disabled runtime when another runtime keeps a no-auth provider connected', async () => {
    const base = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xd')!;
    const mixedProvider = {
      ...base,
      id: 'mixed-local-no-auth',
      name: 'Mixed local no-auth',
      auth: { method: 'none' as const },
      routing: {
        ...base.routing,
        codex: { ...base.routing.codex!, disabled: true },
      },
    };
    const svc = createProviderService({
      getCatalog: () => ({ version: 'mixed-runtime-test', providers: [mixedProvider] }),
      connection: {
        xd: () => false,
        anthropic: () => false,
        openai: () => false,
        xai: () => false,
      },
    });

    const providers = await svc.listProviders();
    expect(providers[0]?.connected).toBe(true);
    expect(connectedProvidersForAgent(providers, 'claude-code')).toHaveLength(1);
    expect(connectedProvidersForAgent(providers, 'codex')).toHaveLength(0);
  });
});
