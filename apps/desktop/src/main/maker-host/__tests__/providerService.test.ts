import { describe, it, expect, vi } from 'vitest';

import { BUNDLED_CATALOG } from '@cindy/model-providers';

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
});
