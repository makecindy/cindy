import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  endpoint: 'https://model.cn.example',
  buildEndpoint: 'https://model.cn.example',
  loads: [] as Array<{
    source: Record<string, unknown>;
    resolve: (catalog: unknown) => void;
  }>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  net: { request: vi.fn() },
}));

vi.mock('@cindy/model-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/model-providers')>();
  return {
    ...actual,
    loadCatalog: vi.fn(
      (source: Record<string, unknown>) =>
        new Promise((resolve) => {
          h.loads.push({ source, resolve });
        }),
    ),
  };
});

vi.mock('../../manifestService.js', () => ({
  getBaseUrl: () => 'https://legacy-build-cdn.example',
  isDev: () => false,
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getBuildClientEndpoint: () => h.buildEndpoint,
  getClientEndpoint: () => h.endpoint,
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ mode: 'signed-out', user: null }),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'signed-out', dataOwnerId: null }),
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: false }),
}));
vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasLegacyOwnerNamespaceClaim: () => false,
}));
vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => null,
  desktopCodexAuthAdapter: {
    hasCodexOAuthLogin: () => false,
    hasCodexOAuthLoginReadOnly: () => false,
    hasCodexOAuthLoginUnbound: () => false,
  },
}));
vi.mock('../claude-credentials-store.js', () => ({
  hasClaudeAiOAuth: () => false,
  hasClaudeAiOAuthUnbound: () => false,
}));
vi.mock('../grok-oauth-login.js', () => ({
  getGrokAccessToken: () => null,
  hasGrokOAuthLogin: () => false,
  hasGrokOAuthLoginUnbound: () => false,
  resetGrokOAuthMemoryCache: () => undefined,
}));
vi.mock('../generic-oauth.js', () => ({
  configureGenericOAuth: () => undefined,
  hasGenericOAuthLogin: () => false,
  readCachedGenericOAuthAccessToken: () => null,
  resetGenericOAuthMemoryCache: () => undefined,
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  genericOAuthSecretIo: {},
  readCustomProviderKey: () => null,
  setProviderSecretsClearedListener: () => undefined,
  addProviderSecretsClearedListener: () => undefined,
}));
vi.mock('../provider-route.js', () => ({
  setCustomProviderKeyReader: () => undefined,
  setOAuthTokenReader: () => undefined,
  setProviderOAuthTokenReader: () => undefined,
}));
vi.mock('../provider-diagnostics.js', () => ({
  setDiagnosticsKeyReader: () => undefined,
  setDiagnosticsOAuthTokenReader: () => undefined,
}));
vi.mock('../codex-model-discovery.js', () => ({
  readCodexDiscoveredModels: async () => null,
  readCodexDiscoveredModelsForAuthRefresh: async () => [],
}));
vi.mock('../model-discovery/anthropic.js', () => ({
  getAnthropicModelDiscoveryFailure: () => null,
  loadAnthropicModelsFromDiskCache: async () => undefined,
  refreshAnthropicModelsFromHttp: async () => undefined,
}));

import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';
import { getActiveCatalog } from '../active-catalog.js';
import {
  ensureActiveCatalogLoaded,
  reloadActiveCatalogForEndpointChange,
} from '../createDesktopProviderService.js';

function catalogNamed(name: string): Catalog {
  return {
    ...BUNDLED_CATALOG,
    providers: BUNDLED_CATALOG.providers.map((provider, index) =>
      index === 0 ? { ...provider, name } : provider,
    ),
  };
}

function activeMarker(): string | undefined {
  return getActiveCatalog().providers[0]?.name;
}

describe('provider catalog realm reload', () => {
  it('invalidates the old realm immediately and ignores a stale cross-realm response', async () => {
    const initial = ensureActiveCatalogLoaded();
    expect(h.loads[0]?.source).toMatchObject({
      baseUrl: 'https://model.cn.example',
      fallbackBaseUrl: 'https://legacy-build-cdn.example',
    });
    h.loads[0]!.resolve(catalogNamed('catalog-cn-initial'));
    await initial;
    expect(activeMarker()).toBe('catalog-cn-initial');

    h.endpoint = 'https://model.global.example';
    const globalReload = reloadActiveCatalogForEndpointChange();
    // Endpoint activation must synchronously remove the CN catalog before any await.
    expect(activeMarker()).not.toBe('catalog-cn-initial');
    expect(h.loads[1]?.source).toMatchObject({
      baseUrl: 'https://model.global.example',
    });
    expect(h.loads[1]?.source.fallbackBaseUrl).toBeUndefined();

    // A quick switch back to CN supersedes the still-pending Global request.
    h.endpoint = 'https://model.cn.example';
    const cnReload = reloadActiveCatalogForEndpointChange();
    h.loads[1]!.resolve(catalogNamed('catalog-global-stale'));
    await globalReload;
    expect(activeMarker()).not.toBe('catalog-global-stale');

    h.loads[2]!.resolve(catalogNamed('catalog-cn-latest'));
    await cnReload;
    expect(activeMarker()).toBe('catalog-cn-latest');
  });
});
