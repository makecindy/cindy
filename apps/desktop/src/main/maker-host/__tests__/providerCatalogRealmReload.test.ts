import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  endpoint: 'https://model.cn.example',
  buildEndpoint: 'https://model.cn.example',
  owner: 'owner-default',
  canUseCindyGateway: true,
  loads: [] as Array<{
    source: Record<string, unknown>;
    resolve: (
      catalog: unknown,
      capabilityEvidence?: 'current' | 'fallback',
      unverifiedXdMediaKinds?: readonly ('image' | 'video' | 'embedding')[],
    ) => void;
  }>,
  refreshLoads: [] as Array<{
    source: Record<string, unknown>;
    resolve: (result: unknown) => void;
  }>,
  customProviderRead: vi.fn(),
  casUpdate: vi.fn(async (..._args: unknown[]) => true),
  migrateManaged: vi.fn((_config?: unknown) => null as unknown),
  getGrokAccessToken: vi.fn(),
  recoverGrokAuthAfterRejection: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
  net: { request: vi.fn() },
}));

vi.mock('@cindy/model-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/model-providers')>();
  return {
    ...actual,
    loadCatalog: vi.fn(
      (
        source: Record<string, unknown>,
        _io: unknown,
        onResolved?: (result: unknown) => void,
      ) =>
        new Promise((resolve) => {
          h.loads.push({
            source,
            resolve: (
              catalog,
              capabilityEvidence = 'current',
              unverifiedXdMediaKinds = capabilityEvidence === 'current'
                ? []
                : ['image', 'video', 'embedding'],
            ) => {
              onResolved?.({
                catalog,
                source: capabilityEvidence === 'current' ? 'remote' : 'cache',
                capabilityEvidence,
                unverifiedXdMediaKinds,
              });
              resolve(catalog);
            },
          });
        }),
    ),
    loadCatalogWithSource: vi.fn(
      (source: Record<string, unknown>) =>
        new Promise((resolve) => {
          h.refreshLoads.push({ source, resolve });
        }),
    ),
  };
});

vi.mock('../../manifestService.js', () => ({
  getBaseUrl: () => 'https://legacy-build-cdn.example',
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getBuildClientEndpoint: () => h.buildEndpoint,
  getClientEndpoint: () => h.endpoint,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: h.warn,
    error: vi.fn(),
  }),
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ mode: 'signed-out', user: null }),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'signed-out', dataOwnerId: h.owner }),
  activeOwnerScopeKey: () => `signed-out:${h.owner ?? 'none'}`,
  ownerScopedUserDataPath: (...segments: string[]) =>
    path.join(os.tmpdir(), 'provider-catalog-realm-reload', h.owner, ...segments),
}));
vi.mock('../../../shared/brandRegion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/brandRegion.js')>();
  return { ...actual, CURRENT_CINDY_REGION: 'cn' };
});
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: h.canUseCindyGateway }),
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
  getGrokAccessToken: h.getGrokAccessToken,
  peekGrokAccessToken: () => null,
  hasGrokOAuthLogin: () => false,
  hasGrokOAuthLoginUnbound: () => false,
  recoverGrokAuthAfterRejection: h.recoverGrokAuthAfterRejection,
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
  setProviderViewsReader: () => undefined,
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
vi.mock('../custom-provider-header-secrets.js', () => ({
  listCustomProvidersWithSecureHeaders: () => h.customProviderRead(),
}));
vi.mock('../../local-model-runtime/managedOllamaProvider.js', () => ({
  migrateManagedOllamaOnCatalogLoad: async () => false,
  migrateManagedOllamaProvider: (config: unknown) => h.migrateManaged(config),
}));
vi.mock('../../local-model-runtime/localConnectHarness.js', () => ({
  migrateLocalConnectPresetsOnCatalogLoad: async () => 0,
}));
vi.mock('../../../shared/localConnectHarness.js', () => ({
  migrateLocalConnectPresetsOnCatalogLoad: async () => 0,
  migrateLocalConnectProvider: () => null,
}));
vi.mock('../custom-provider-store.js', () => ({
  updateCustomProviderIfUnchanged: (...args: unknown[]) => h.casUpdate(...args),
}));

import {
  BUNDLED_CATALOG,
  buildUserProvider,
  type Catalog,
  type CustomProviderConfig,
} from '@cindy/model-providers';
import { deriveCindyMediaConfig } from '../../cindy-brain/cindyMediaCatalog.js';
import {
  getActiveCatalog,
  commitModelPlaneFromCatalog,
  setActiveCatalog,
  setActiveCatalogChangedListener,
  setCustomProviderConfigs,
  setCustomProviders,
} from '../active-catalog.js';
import {
  __testing,
  ensureActiveCatalogLoaded,
  getDesktopSelectableCatalog,
  refreshActiveCatalogFromSource,
  refreshCustomProvidersIntoCatalog,
  reloadActiveCatalogForEndpointChange,
  syncLocalCatalogOverridesIntoActiveCatalog,
} from '../createDesktopProviderService.js';

function catalogNamed(name: string, updatedAt?: string): Catalog {
  return {
    ...BUNDLED_CATALOG,
    ...(updatedAt && BUNDLED_CATALOG.modelRegistry
      ? { modelRegistry: { ...BUNDLED_CATALOG.modelRegistry, updatedAt } }
      : {}),
    providers: BUNDLED_CATALOG.providers.map((provider, index) =>
      index === 0 ? { ...provider, name } : provider,
    ),
  };
}

function activeMarker(): string | undefined {
  return getActiveCatalog().providers[0]?.name;
}

describe('provider catalog realm reload', () => {
  it('passes xAI rejection context into forced recovery and never replays the stale token', async () => {
    h.getGrokAccessToken.mockReset();
    h.recoverGrokAuthAfterRejection.mockReset();

    h.getGrokAccessToken.mockResolvedValueOnce('ordinary-token');
    await expect(__testing.readXaiProviderOAuthToken()).resolves.toBe('ordinary-token');
    expect(h.recoverGrokAuthAfterRejection).not.toHaveBeenCalled();

    h.recoverGrokAuthAfterRejection.mockResolvedValueOnce('refreshed');
    h.getGrokAccessToken.mockResolvedValueOnce('fresh-token');
    await expect(
      __testing.readXaiProviderOAuthToken({
        forceRefresh: true,
        staleToken: 'rejected-token',
      }),
    ).resolves.toBe('fresh-token');
    expect(h.recoverGrokAuthAfterRejection).toHaveBeenLastCalledWith('rejected-token');

    h.recoverGrokAuthAfterRejection.mockResolvedValueOnce('unchanged');
    await expect(
      __testing.readXaiProviderOAuthToken({
        forceRefresh: true,
        staleToken: 'rejected-token',
      }),
    ).resolves.toBeNull();
    expect(h.getGrokAccessToken).toHaveBeenCalledTimes(2);

    h.recoverGrokAuthAfterRejection.mockResolvedValueOnce('superseded');
    h.getGrokAccessToken.mockResolvedValueOnce('replacement-token');
    await expect(
      __testing.readXaiProviderOAuthToken({
        forceRefresh: true,
        staleToken: 'rejected-token',
      }),
    ).resolves.toBe('replacement-token');

    await expect(
      __testing.readXaiProviderOAuthToken({ forceRefresh: true }),
    ).resolves.toBeNull();
    expect(h.recoverGrokAuthAfterRejection).toHaveBeenCalledTimes(3);
  });

  it('drops a stale owner custom-provider read and clears the current snapshot on failure', async () => {
    const provider: CustomProviderConfig = {
      id: 'owner-a-provider',
      name: 'Owner A Provider',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://owner-a.example/anthropic',
          models: [{ id: 'owner-a-model', name: 'Owner A Model' }],
        },
      },
    };
    let resolveOwnerA!: (configs: CustomProviderConfig[]) => void;
    const ownerALoad = new Promise<CustomProviderConfig[]>((resolve) => {
      resolveOwnerA = resolve;
    });
    h.customProviderRead.mockReturnValueOnce(ownerALoad);
    let ownerAIsCurrent = true;
    const staleRefresh = refreshCustomProvidersIntoCatalog(() => ownerAIsCurrent);

    setCustomProviders([]);
    ownerAIsCurrent = false;
    resolveOwnerA([provider]);
    await staleRefresh;
    expect(getActiveCatalog().providers.some((entry) => entry.id === provider.id)).toBe(false);

    setCustomProviders([buildUserProvider(provider)]);
    h.customProviderRead.mockRejectedValueOnce(new Error('stale owner A DB read failed'));
    await refreshCustomProvidersIntoCatalog(() => false);
    expect(getActiveCatalog().providers.some((entry) => entry.id === provider.id)).toBe(true);

    h.customProviderRead.mockRejectedValueOnce(new Error('owner B DB read failed'));
    await refreshCustomProvidersIntoCatalog();
    expect(getActiveCatalog().providers.some((entry) => entry.id === provider.id)).toBe(false);
    h.customProviderRead.mockReset();
  });

  it('does not publish a migrated snapshot after a failed CAS write', async () => {
    const original: CustomProviderConfig = {
      id: 'cas-provider',
      name: 'Original',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://original.example/anthropic',
          models: [{ id: 'original-model', name: 'Original Model' }],
        },
      },
    };
    const edited: CustomProviderConfig = {
      ...original,
      name: 'Edited by user',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://edited.example/anthropic',
          models: [{ id: 'user-model', name: 'User Model' }],
        },
      },
    };
    const migrated: CustomProviderConfig = {
      ...original,
      runtimes: {
        'claude-code': {
          baseUrl: 'https://migrated.example/anthropic',
          models: [{ id: 'stale-model', name: 'Stale Model' }],
        },
      },
    };
    h.migrateManaged.mockReset();
    h.casUpdate.mockReset();
    h.customProviderRead.mockReset();
    h.migrateManaged.mockImplementation((config: unknown) =>
      (config as CustomProviderConfig).id === original.id ? migrated : null,
    );
    h.casUpdate.mockResolvedValueOnce(false);
    h.customProviderRead.mockResolvedValueOnce([original]).mockResolvedValueOnce([edited]);

    await refreshCustomProvidersIntoCatalog();

    expect(h.casUpdate).toHaveBeenCalled();
    const published = getActiveCatalog().providers.find((entry) => entry.id === original.id);
    expect(published?.name).toBe('Edited by user');
    expect(published?.models['claude-code']?.[0]).toMatchObject({ id: 'user-model' });
    expect(JSON.stringify(published)).not.toContain('stale-model');
    expect(JSON.stringify(published)).not.toContain('migrated.example');
    setCustomProviders([]);
    h.migrateManaged.mockReset();
    h.casUpdate.mockReset();
    h.customProviderRead.mockReset();
    h.migrateManaged.mockImplementation(() => null);
    h.casUpdate.mockResolvedValue(true);
  });

  it('reprojects custom efforts once on Registry refresh and preserves the custom route', async () => {
    const current = structuredClone(catalogNamed('custom-before', '2026-08-12T10:00:00.000Z'));
    const currentEntry = current.modelRegistry?.models.find(
      (entry) => entry.id === 'openai/gpt-5.6-sol',
    );
    if (!currentEntry) throw new Error('expected gpt-5.6-sol Registry entry');
    currentEntry.perAgent = { ...currentEntry.perAgent, codex: { efforts: ['high'] } };
    setActiveCatalog(current);

    const config: CustomProviderConfig = {
      id: 'registry-relay',
      name: 'Registry Relay',
      runtimes: {
        codex: {
          baseUrl: 'https://relay.example/v1',
          models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
        },
      },
    };
    setCustomProviderConfigs([config]);

    const next = structuredClone(catalogNamed('custom-after', '2026-08-12T11:00:00.000Z'));
    const nextEntry = next.modelRegistry?.models.find(
      (entry) => entry.id === 'openai/gpt-5.6-sol',
    );
    if (!nextEntry) throw new Error('expected gpt-5.6-sol Registry entry');
    nextEntry.perAgent = {
      ...nextEntry.perAgent,
      codex: { efforts: ['high', 'max', 'ultra'], defaultEffort: 'ultra' },
    };

    const events: number[] = [];
    setActiveCatalogChangedListener((revision) => events.push(revision));
    try {
      setActiveCatalog(next);
      const provider = getActiveCatalog().providers.find((entry) => entry.id === config.id);
      expect(provider).toMatchObject({
        id: config.id,
        routing: { codex: { upstream: 'https://relay.example/v1' } },
      });
      expect(provider?.models.codex?.[0]).toMatchObject({
        id: 'gpt-5.6-sol',
        efforts: ['high', 'max', 'ultra'],
        defaultEffort: 'ultra',
      });
      expect(events).toHaveLength(1);
    } finally {
      setActiveCatalogChangedListener(null);
      setCustomProviders([]);
    }
  });

  it('keeps the current custom projection when full or model-plane catalogs omit Registry', () => {
    const current = structuredClone(catalogNamed('registry-bearing', '2026-08-12T12:00:00.000Z'));
    const entry = current.modelRegistry?.models.find(
      (candidate) => candidate.id === 'openai/gpt-5.6-sol',
    );
    if (!entry) throw new Error('expected gpt-5.6-sol Registry entry');
    entry.perAgent = {
      ...entry.perAgent,
      codex: { efforts: ['minimal', 'max'], defaultEffort: 'max' },
    };
    setActiveCatalog(current);
    const config: CustomProviderConfig = {
      id: 'registry-relay',
      name: 'Registry Relay',
      runtimes: {
        codex: {
          baseUrl: 'https://relay.example/v1',
          models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
        },
      },
    };
    setCustomProviderConfigs([config]);

    const withoutRegistry = structuredClone(current);
    delete withoutRegistry.modelRegistry;
    setActiveCatalog(withoutRegistry);
    expect(
      getActiveCatalog().providers.find((provider) => provider.id === config.id)?.models.codex?.[0],
    ).toMatchObject({ efforts: ['minimal', 'max'], defaultEffort: 'max' });
    expect(getActiveCatalog().modelRegistry).toBeUndefined();

    setActiveCatalog(current);
    commitModelPlaneFromCatalog(withoutRegistry);
    expect(
      getActiveCatalog().providers.find((provider) => provider.id === config.id)?.models.codex?.[0],
    ).toMatchObject({ efforts: ['minimal', 'max'], defaultEffort: 'max' });
    expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-08-12T12:00:00.000Z');
    setCustomProviders([]);
  });

  it('does not revive cleared owner configs on a later Registry refresh', () => {
    const config: CustomProviderConfig = {
      id: 'old-owner-relay',
      name: 'Old owner relay',
      runtimes: {
        codex: {
          baseUrl: 'https://old-owner.example/v1',
          models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
        },
      },
    };
    setCustomProviderConfigs([config]);
    setCustomProviders([]);
    setActiveCatalog(catalogNamed('next-owner-catalog', '2026-08-12T13:00:00.000Z'));
    expect(getActiveCatalog().providers.some((provider) => provider.id === config.id)).toBe(false);
  });

  it('persists only a digest of a catalog scope that may contain URL credentials', () => {
    const scope = 'https://catalog.example/models?access_token=do-not-persist';
    const envelope = __testing.catalogLkgEnvelope(scope, '{"schemaVersion":1}');

    expect(envelope).toMatchObject({
      version: 2,
      scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      catalog: '{"schemaVersion":1}',
    });
    expect(JSON.stringify(envelope)).not.toContain(scope);
    expect(JSON.stringify(envelope)).not.toContain('do-not-persist');
  });

  it('uses a unique temporary path for every LKG write', () => {
    const first = __testing.catalogLkgTemporaryPath('/catalog.json');
    const second = __testing.catalogLkgTemporaryPath('/catalog.json');

    expect(first).not.toBe(second);
    expect(first).toMatch(/\/catalog\.json\.\d+\.[0-9a-f-]+\.tmp$/);
    expect(second).toMatch(/\/catalog\.json\.\d+\.[0-9a-f-]+\.tmp$/);
  });

  it('serializes the complete LKG replacement transaction for the same scope', async () => {
    const events: string[] = [];
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const first = __testing.serializeCatalogLkgWrite('/same-catalog.json', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));

    const second = __testing.serializeCatalogLkgWrite('/same-catalog.json', async () => {
      events.push('second:start');
      events.push('second:end');
    });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    finishFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps a newer LKG when an older response queues behind it for the same scope', async () => {
    const scope = `https://catalog.example.test/${randomUUID()}`;
    const file = __testing.catalogLkgPath(scope);
    const older = JSON.stringify(catalogNamed('OLDER', '2026-07-30T00:00:00.000Z'));
    const newer = JSON.stringify(catalogNamed('NEWER', '2026-08-01T00:00:00.000Z'));

    try {
      await __testing.writeCatalogLkg(scope, older);
      const newerCommit = __testing.writeCatalogLkg(scope, newer);
      const staleCommit = __testing.writeCatalogLkg(scope, older);

      await expect(newerCommit).resolves.toBe(newer);
      await expect(staleCommit).resolves.toBe(newer);
      await expect(__testing.readCatalogLkg(scope)).resolves.toBe(newer);
    } finally {
      await fsp.rm(file, { force: true });
      await fsp.rm(`${file}.bak`, { force: true });
    }
  });

  it('keeps the LKG when the same registry revision is republished with different content', () => {
    const updatedAt = '2026-08-01T00:00:00.000Z';
    const currentCatalog = catalogNamed('CURRENT', updatedAt);
    const incomingCatalog = structuredClone(currentCatalog);
    const registryEntry = incomingCatalog.modelRegistry?.models[0];
    if (!registryEntry) throw new Error('expected bundled model registry entry');
    registryEntry.name = `${registryEntry.name} (republished)`;
    const current = JSON.stringify(currentCatalog);
    const incoming = JSON.stringify(incomingCatalog);

    expect(__testing.selectCatalogLkgSnapshot(incoming, current)).toBe(current);
  });

  it('keeps a Registry-bearing LKG when a later serialized write omits Registry', () => {
    const currentCatalog = catalogNamed('CURRENT', '2026-08-01T00:00:00.000Z');
    const incomingCatalog = structuredClone(currentCatalog);
    delete incomingCatalog.modelRegistry;
    const current = JSON.stringify(currentCatalog);
    const incoming = JSON.stringify(incomingCatalog);

    expect(__testing.selectCatalogLkgSnapshot(incoming, current)).toBe(current);
  });

  it('replaces an existing LKG through a Windows-safe backup path', async () => {
    const files = new Set(['/catalog.json', '/catalog.tmp']);
    const calls: Array<[string, string]> = [];
    let firstReplace = true;
    const fileIo = {
      async rename(from: string, to: string) {
        calls.push([from, to]);
        if (firstReplace && from === '/catalog.tmp' && to === '/catalog.json') {
          firstReplace = false;
          throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
        }
        if (!files.has(from)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        files.delete(from);
        files.add(to);
      },
      async rm(target: string) {
        files.delete(target);
      },
    };

    await __testing.replaceCatalogLkgFile('/catalog.tmp', '/catalog.json', fileIo);

    expect(calls).toEqual([
      ['/catalog.tmp', '/catalog.json'],
      ['/catalog.json', '/catalog.json.bak'],
      ['/catalog.tmp', '/catalog.json'],
    ]);
    expect(files).toEqual(new Set(['/catalog.json']));
  });

  it('restores the previous LKG if the replacement still fails', async () => {
    const files = new Set(['/catalog.json', '/catalog.tmp']);
    let temporaryAttempts = 0;
    const fileIo = {
      async rename(from: string, to: string) {
        if (from === '/catalog.tmp') {
          temporaryAttempts += 1;
          throw Object.assign(new Error('locked'), {
            code: temporaryAttempts === 1 ? 'EPERM' : 'EBUSY',
          });
        }
        if (!files.has(from)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        files.delete(from);
        files.add(to);
      },
      async rm(target: string) {
        files.delete(target);
      },
    };

    await expect(
      __testing.replaceCatalogLkgFile('/catalog.tmp', '/catalog.json', fileIo),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(files.has('/catalog.json')).toBe(true);
    expect(files.has('/catalog.json.bak')).toBe(false);
  });

  it('invalidates the old realm immediately and ignores a stale cross-realm response', async () => {
    const initial = ensureActiveCatalogLoaded();
    expect(h.loads[0]?.source).toMatchObject({
      baseUrl: 'https://model.cn.example',
      fallbackBaseUrl: 'https://legacy-build-cdn.example',
    });
    h.loads[0]!.resolve(catalogNamed('catalog-cn-initial'), 'current', ['embedding']);
    await initial;
    expect(activeMarker()).toBe('catalog-cn-initial');
    const startupXd = getDesktopSelectableCatalog().providers.find(
      (provider) => provider.id === 'xd',
    );
    expect(startupXd?.imageModels).toEqual([]);
    expect(startupXd?.videoModels).toEqual([]);
    expect(startupXd?.embeddingModels).toEqual([]);

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

  it('keeps bundled/LKG/waiting catalogs region-safe without hiding discovered xAI media', async () => {
    const catalogWithXaiMedia = structuredClone(catalogNamed('catalog-with-xai-media'));
    const xai = catalogWithXaiMedia.providers.find((provider) => provider.id === 'xai');
    if (!xai) throw new Error('expected xAI provider');
    xai.imageModels = [
      { id: 'xai/grok-imagine-image', name: 'Grok Imagine Image' },
    ];
    xai.imageDefaults = { standard: 'xai/grok-imagine-image' };
    xai.videoModels = [
      { id: 'xai/grok-imagine-video', name: 'Grok Imagine Video' },
      { id: 'xai/grok-imagine-video-1.5', name: 'Grok Imagine Video 1.5' },
    ];
    xai.videoDefaults = { standard: 'xai/grok-imagine-video' };

    h.endpoint = 'https://model.cn-fallback.example';
    const fallbackReload = reloadActiveCatalogForEndpointChange();

    // The endpoint-switch window uses bundled data, but it cannot advertise Global XD media.
    const waitingXd = getDesktopSelectableCatalog().providers.find((provider) => provider.id === 'xd');
    expect(waitingXd?.imageModels).toEqual([]);
    expect(waitingXd?.embeddingModels).toEqual([]);
    expect(waitingXd?.videoModels?.map((model) => model.id)).not.toContain('happyhorse');

    h.loads.at(-1)!.resolve(catalogWithXaiMedia, 'fallback');
    await fallbackReload;

    const fallbackCatalog = getDesktopSelectableCatalog();
    const fallbackXd = fallbackCatalog.providers.find((provider) => provider.id === 'xd');
    expect(fallbackXd?.imageModels).toEqual([]);
    expect(fallbackXd?.embeddingModels).toEqual([]);
    expect(fallbackXd?.videoModels?.map((model) => model.id)).not.toContain('happyhorse');
    expect(
      fallbackCatalog.providers.find((provider) => provider.id === 'xai')?.videoModels?.map(
        (model) => model.id,
      ),
    ).toEqual(['xai/grok-imagine-video', 'xai/grok-imagine-video-1.5']);
    expect(deriveCindyMediaConfig(fallbackCatalog.providers, 'embed')).toEqual({
      models: [],
      defaults: null,
    });
    expect(
      deriveCindyMediaConfig(fallbackCatalog.providers, 'video').models.map((model) => model.id),
    ).toContain('xai/grok-imagine-video-1.5');

    h.endpoint = 'https://model.cn-current.example';
    const currentReload = reloadActiveCatalogForEndpointChange();
    expect(
      getDesktopSelectableCatalog()
        .providers.find((provider) => provider.id === 'xd')
        ?.videoModels?.map((model) => model.id),
    ).not.toContain('happyhorse');
    const currentCatalogWithExplicitXd = structuredClone(catalogWithXaiMedia);
    const explicitXd = currentCatalogWithExplicitXd.providers.find(
      (provider) => provider.id === 'xd',
    );
    if (!explicitXd) throw new Error('expected XD provider');
    explicitXd.imageModels = [];
    delete explicitXd.imageDefaults;
    explicitXd.embeddingModels = [];
    delete explicitXd.embeddingDefaults;
    explicitXd.videoModels = [{ id: 'seedance-fast', name: 'Seedance Fast' }];
    explicitXd.videoDefaults = { standard: 'seedance-fast' };
    h.loads.at(-1)!.resolve(currentCatalogWithExplicitXd, 'current');
    await currentReload;

    const currentCatalog = getDesktopSelectableCatalog();
    const currentXd = currentCatalog.providers.find((provider) => provider.id === 'xd');
    expect(currentXd?.imageModels).toEqual([]);
    expect(currentXd?.embeddingModels).toEqual([]);
    expect(currentXd?.videoModels).toEqual([]);
    expect(deriveCindyMediaConfig(currentCatalog.providers, 'embed')).toEqual({
      models: [],
      defaults: null,
    });
    expect(
      currentCatalog.providers.find((provider) => provider.id === 'xai')?.videoModels?.map(
        (model) => model.id,
      ),
    ).toEqual(['xai/grok-imagine-video', 'xai/grok-imagine-video-1.5']);

    // Restore the baseline expected by the following realm-race tests.
    h.endpoint = 'https://model.cn.example';
    const reset = reloadActiveCatalogForEndpointChange();
    h.loads.at(-1)!.resolve(catalogNamed('catalog-cn-latest'));
    await reset;
  });

  it('keeps bundled XD backfill field-scoped across endpoint reload and refresh', async () => {
    const inheritedAll = structuredClone(catalogNamed('current-with-bundled-xd'));
    const inheritedXai = inheritedAll.providers.find((provider) => provider.id === 'xai');
    if (!inheritedXai) throw new Error('expected xAI provider');
    inheritedXai.imageModels = [
      { id: 'xai/grok-imagine-image', name: 'Grok Imagine Image' },
    ];
    inheritedXai.videoModels = [
      { id: 'xai/grok-imagine-video', name: 'Grok Imagine Video' },
    ];

    h.endpoint = 'https://model.cn-primary-missing-xd.example';
    const reload = reloadActiveCatalogForEndpointChange();
    h.loads.at(-1)!.resolve(
      inheritedAll,
      'current',
      ['image', 'video', 'embedding'],
    );
    await reload;

    const projectedAll = getDesktopSelectableCatalog();
    const projectedAllXd = projectedAll.providers.find((provider) => provider.id === 'xd');
    expect(projectedAllXd?.imageModels).toEqual([]);
    expect(projectedAllXd?.embeddingModels).toEqual([]);
    expect(projectedAllXd?.videoModels?.map((model) => model.id)).not.toContain('happyhorse');
    expect(projectedAll.providers.find((provider) => provider.id === 'xai')?.videoModels).toEqual(
      inheritedXai.videoModels,
    );

    const inheritedEmbedding = structuredClone(inheritedAll);
    const inheritedEmbeddingXd = inheritedEmbedding.providers.find(
      (provider) => provider.id === 'xd',
    );
    if (!inheritedEmbeddingXd) throw new Error('expected XD provider');
    inheritedEmbeddingXd.imageModels = [
      { id: 'gateway-current-image', name: 'Gateway Current Image' },
    ];
    inheritedEmbeddingXd.videoModels = [
      { id: 'gateway-current-video', name: 'Gateway Current Video' },
    ];

    const partialRefresh = refreshActiveCatalogFromSource();
    await Promise.resolve();
    h.refreshLoads.at(-1)!.resolve({
      catalog: inheritedEmbedding,
      source: 'remote',
      capabilityEvidence: 'current',
      unverifiedXdMediaKinds: ['embedding'],
    });
    await partialRefresh;

    const projectedEmbedding = getDesktopSelectableCatalog().providers.find(
      (provider) => provider.id === 'xd',
    );
    expect(projectedEmbedding?.imageModels).toEqual([]);
    expect(projectedEmbedding?.videoModels).toEqual([]);
    expect(projectedEmbedding?.embeddingModels).toEqual([]);

    const evidenceUpgrade = refreshActiveCatalogFromSource();
    await Promise.resolve();
    h.refreshLoads.at(-1)!.resolve({
      catalog: structuredClone(inheritedEmbedding),
      source: 'remote',
      capabilityEvidence: 'current',
      unverifiedXdMediaKinds: [],
    });
    await evidenceUpgrade;

    expect(
      getDesktopSelectableCatalog()
        .providers.find((provider) => provider.id === 'xd')
        ?.embeddingModels,
    ).toEqual(inheritedEmbeddingXd.embeddingModels);

    h.endpoint = 'https://model.cn.example';
    const reset = reloadActiveCatalogForEndpointChange();
    h.loads.at(-1)!.resolve(catalogNamed('catalog-cn-latest'));
    await reset;
  });

  it('ignores an automatic refresh response from a superseded realm', async () => {
    const staleRefreshIndex = h.refreshLoads.length;
    const staleRefresh = refreshActiveCatalogFromSource();
    await Promise.resolve();
    expect(h.refreshLoads[staleRefreshIndex]?.source).toMatchObject({
      baseUrl: 'https://model.cn.example',
    });

    h.endpoint = 'https://model.global.example';
    const globalReloadIndex = h.loads.length;
    const globalReload = reloadActiveCatalogForEndpointChange();
    h.loads[globalReloadIndex]!.resolve(
      catalogNamed('catalog-global-current', '2026-07-31T12:00:00.000Z'),
    );
    await globalReload;

    const currentRefreshIndex = h.refreshLoads.length;
    const currentRefresh = refreshActiveCatalogFromSource();
    await Promise.resolve();
    expect(h.refreshLoads[currentRefreshIndex]?.source).toMatchObject({
      baseUrl: 'https://model.global.example',
    });
    h.refreshLoads[currentRefreshIndex]!.resolve({
      catalog: catalogNamed('catalog-global-refreshed', '2026-07-31T12:30:00.000Z'),
      source: 'remote',
    });
    await currentRefresh;

    h.refreshLoads[staleRefreshIndex]!.resolve({
      catalog: catalogNamed('catalog-cn-stale', '2026-07-31T13:00:00.000Z'),
      source: 'remote',
    });
    await staleRefresh;

    expect(activeMarker()).toBe('catalog-global-refreshed');
    expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-07-31T12:30:00.000Z');
  });

  it('does not downgrade the active catalog when refresh falls back to an older cache', async () => {
    const activeXaiModels = getActiveCatalog().providers.find((provider) => provider.id === 'xai')
      ?.models.codex;
    const staleCatalog = structuredClone(
      catalogNamed('catalog-global-cached', '2026-07-31T11:00:00.000Z'),
    );
    const staleXai = staleCatalog.providers.find((provider) => provider.id === 'xai');
    if (!staleXai) throw new Error('expected bundled xai provider');
    staleXai.models.codex = [
      {
        id: 'xai/stale-cache-only',
        name: 'Stale cache only',
        contextWindow: 1,
        efforts: [],
        defaultEffort: null,
      },
    ];
    const refresh = refreshActiveCatalogFromSource();
    await Promise.resolve();
    const load = h.refreshLoads.at(-1)!;
    load.resolve({
      catalog: staleCatalog,
      source: 'cache',
    });
    await refresh;

    expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-07-31T12:30:00.000Z');
    expect(
      getActiveCatalog().providers.find((provider) => provider.id === 'xai')?.models.codex,
    ).toEqual(activeXaiModels);
  });

  it('installs a same-registry fallback snapshot and propagates evidence atomically', async () => {
    const current = structuredClone(
      catalogNamed('catalog-current-before-same-registry-fallback', '2026-07-31T12:30:00.000Z'),
    );
    setActiveCatalog(current, { capabilityEvidence: 'current' });

    const fallback = structuredClone(current);
    fallback.providers[0] = {
      ...fallback.providers[0]!,
      name: 'catalog-fallback-same-registry',
    };
    const fallbackXd = fallback.providers.find((provider) => provider.id === 'xd');
    const fallbackXai = fallback.providers.find((provider) => provider.id === 'xai');
    if (!fallbackXd || !fallbackXai) throw new Error('expected fallback providers');
    fallbackXd.imageModels = [{ id: 'fallback-image', name: 'Fallback Image' }];
    fallbackXd.videoModels = [{ id: 'fallback-video', name: 'Fallback Video' }];
    fallbackXd.embeddingModels = [{ id: 'fallback-embedding', name: 'Fallback Embedding' }];
    fallbackXai.videoModels = [
      { id: 'xai/grok-imagine-video-1.5', name: 'Grok Imagine Video 1.5' },
    ];

    const events: number[] = [];
    setActiveCatalogChangedListener((revision) => events.push(revision));
    try {
      const refresh = refreshActiveCatalogFromSource();
      await Promise.resolve();
      h.refreshLoads.at(-1)!.resolve({
        catalog: fallback,
        source: 'cache',
        capabilityEvidence: 'fallback',
      });
      await refresh;

      expect(activeMarker()).toBe('catalog-fallback-same-registry');
      const projected = getDesktopSelectableCatalog();
      expect(projected.providers.find((provider) => provider.id === 'xd')).toMatchObject({
        imageModels: [],
        videoModels: [],
        embeddingModels: [],
      });
      expect(projected.providers.find((provider) => provider.id === 'xai')?.videoModels).toEqual(
        fallbackXai.videoModels,
      );
      expect(events).toHaveLength(1);

      const exactFallbackRepeat = refreshActiveCatalogFromSource();
      await Promise.resolve();
      h.refreshLoads.at(-1)!.resolve({
        catalog: structuredClone(fallback),
        source: 'cache',
        capabilityEvidence: 'fallback',
      });
      await exactFallbackRepeat;

      expect(events).toHaveLength(1);

      const evidenceUpgrade = refreshActiveCatalogFromSource();
      await Promise.resolve();
      h.refreshLoads.at(-1)!.resolve({
        catalog: structuredClone(fallback),
        source: 'remote',
        capabilityEvidence: 'current',
        unverifiedXdMediaKinds: ['image'],
      });
      await evidenceUpgrade;

      expect(
        getDesktopSelectableCatalog().providers.find((provider) => provider.id === 'xd'),
      ).toMatchObject({
        imageModels: [],
        videoModels: [],
        embeddingModels: fallbackXd.embeddingModels,
      });
      expect(events).toHaveLength(2);

      const exactRepeat = refreshActiveCatalogFromSource();
      await Promise.resolve();
      h.refreshLoads.at(-1)!.resolve({
        catalog: structuredClone(fallback),
        source: 'remote',
        capabilityEvidence: 'current',
        unverifiedXdMediaKinds: ['image'],
      });
      await exactRepeat;

      expect(events).toHaveLength(2);
    } finally {
      setActiveCatalogChangedListener(null);
    }
  });

  it('projects a newer fallback refresh, then promotes identical current evidence', async () => {
    const current = structuredClone(
      catalogNamed('catalog-current-before-fallback-refresh', '2026-07-31T12:30:00.000Z'),
    );
    setActiveCatalog(current, { capabilityEvidence: 'current' });
    expect(
      getDesktopSelectableCatalog()
        .providers.find((provider) => provider.id === 'xd')
        ?.embeddingModels?.map((model) => model.id),
    ).toContain('voyage/voyage-4');

    const fallback = structuredClone(
      catalogNamed('catalog-fallback-refresh', '2026-07-31T13:00:00.000Z'),
    );
    const xai = fallback.providers.find((provider) => provider.id === 'xai');
    if (!xai) throw new Error('expected xAI provider');
    xai.imageModels = [{ id: 'xai/grok-imagine-image', name: 'Grok Imagine Image' }];
    xai.videoModels = [
      { id: 'xai/grok-imagine-video', name: 'Grok Imagine Video' },
      { id: 'xai/grok-imagine-video-1.5', name: 'Grok Imagine Video 1.5' },
    ];

    const refresh = refreshActiveCatalogFromSource();
    await Promise.resolve();
    h.refreshLoads.at(-1)!.resolve({
      catalog: fallback,
      source: 'cache',
      capabilityEvidence: 'fallback',
    });
    await refresh;

    const projected = getDesktopSelectableCatalog();
    const xd = projected.providers.find((provider) => provider.id === 'xd');
    expect(xd?.imageModels).toEqual([]);
    expect(xd?.embeddingModels).toEqual([]);
    expect(xd?.videoModels?.map((model) => model.id)).not.toContain('happyhorse');
    expect(projected.providers.find((provider) => provider.id === 'xai')?.videoModels).toEqual(
      xai.videoModels,
    );

    const recoveredCatalog = structuredClone(fallback);
    recoveredCatalog.providers[0] = {
      ...recoveredCatalog.providers[0]!,
      name: 'catalog-current-same-registry',
    };
    const recoveredXd = recoveredCatalog.providers.find((provider) => provider.id === 'xd');
    const recoveredXai = recoveredCatalog.providers.find((provider) => provider.id === 'xai');
    if (!recoveredXd || !recoveredXai) throw new Error('expected recovered providers');
    recoveredXd.imageModels = [];
    delete recoveredXd.imageDefaults;
    recoveredXd.embeddingModels = [];
    delete recoveredXd.embeddingDefaults;
    recoveredXd.videoModels = [{ id: 'seedance-fast', name: 'Seedance Fast' }];
    recoveredXd.videoDefaults = { standard: 'seedance-fast' };
    recoveredXai.videoModels = [
      { id: 'xai/grok-imagine-video-1.5', name: 'Grok Imagine Video 1.5' },
    ];

    const recovered = refreshActiveCatalogFromSource();
    await Promise.resolve();
    h.refreshLoads.at(-1)!.resolve({
      catalog: recoveredCatalog,
      source: 'remote',
      capabilityEvidence: 'current',
    });
    await recovered;

    const promoted = getDesktopSelectableCatalog();
    const promotedXd = promoted.providers.find((provider) => provider.id === 'xd');
    expect(activeMarker()).toBe('catalog-current-same-registry');
    expect(promotedXd?.imageModels).toEqual([]);
    expect(promotedXd?.embeddingModels).toEqual([]);
    expect(promotedXd?.videoModels).toEqual([]);
    expect(promoted.providers.find((provider) => provider.id === 'xai')?.videoModels).toEqual(
      recoveredXai.videoModels,
    );
  });

  it('按时间语义守卫 offset/Z 等价 revision,拒收真实旧值和坏值,接受真实新值', async () => {
    setActiveCatalog(catalogNamed('current-offset', '2026-08-02T10:00:00+08:00'));
    h.warn.mockClear();

    const refreshWith = async (name: string, updatedAt: string): Promise<void> => {
      const refresh = refreshActiveCatalogFromSource();
      await Promise.resolve();
      h.refreshLoads.at(-1)!.resolve({ catalog: catalogNamed(name, updatedAt), source: 'remote' });
      await refresh;
    };

    try {
      // 同一时刻仅 ISO 表示不同：Registry 关系仍为 same；完整 Catalog 快照不同则
      // 原子安装 incoming，但不应误报同 revision 冲突。
      await refreshWith('equivalent-z', '2026-08-02T02:00:00.000Z');
      expect(activeMarker()).toBe('equivalent-z');
      expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-08-02T02:00:00.000Z');
      expect(h.warn).not.toHaveBeenCalled();

      await refreshWith('actually-older', '2026-08-02T01:59:59.000Z');
      expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-08-02T02:00:00.000Z');

      await refreshWith('actually-newer', '2026-08-02T03:00:00.000Z');
      expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-08-02T03:00:00.000Z');

      await refreshWith('invalid-revision', 'not-a-timestamp');
      expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-08-02T03:00:00.000Z');
      expect(h.warn).toHaveBeenCalledWith('model registry updatedAt is invalid; rejecting', {
        incomingUpdatedAt: 'not-a-timestamp',
        currentUpdatedAt: '2026-08-02T03:00:00.000Z',
      });
    } finally {
      setActiveCatalog(catalogNamed('catalog-global-refreshed', '2026-07-31T12:30:00.000Z'));
    }
  });

  it('原子模型平面:成功刷新恰 1 revision;同 updatedAt 同 digest=no-op、异 digest=拒收,均 0 revision', async () => {
    const events: number[] = [];
    setActiveCatalogChangedListener((revision) => {
      events.push(revision);
    });
    try {
      // 更高 updatedAt:xai 清单 + registry 单次 swap → 恰 1 次 markChanged(旧实现是
      // 2 个 setter + wrapper 广播 = 3 次可观测通知,本用例是 3→1 收敛的回归门)。
      const next = structuredClone(catalogNamed('catalog-plane-v3', '2026-07-31T15:00:00.000Z'));
      const refresh = refreshActiveCatalogFromSource();
      await Promise.resolve();
      h.refreshLoads.at(-1)!.resolve({ catalog: next, source: 'remote' });
      await refresh;
      expect(events).toHaveLength(1);

      // 同 updatedAt 同 digest → 纯 no-op,零 revision 零广播。
      const noop = refreshActiveCatalogFromSource();
      await Promise.resolve();
      h.refreshLoads.at(-1)!.resolve({ catalog: structuredClone(next), source: 'remote' });
      await noop;
      expect(events).toHaveLength(1);

      // 同 updatedAt 异 digest = 非法重发 → 拒收保当前快照,零 revision。
      const mutated = structuredClone(next);
      mutated.modelRegistry!.models = mutated.modelRegistry!.models.slice(1);
      const rejected = refreshActiveCatalogFromSource();
      await Promise.resolve();
      h.refreshLoads.at(-1)!.resolve({ catalog: mutated, source: 'remote' });
      await rejected;
      expect(events).toHaveLength(1);
      expect(getActiveCatalog().modelRegistry?.models).toHaveLength(
        next.modelRegistry!.models.length,
      );
    } finally {
      setActiveCatalogChangedListener(null);
    }
  });

  it('owner 切换即使 endpoint 未变也会清掉上一账号的本地模型 override', async () => {
    const root = path.join(os.tmpdir(), 'provider-catalog-realm-reload');
    h.owner = 'owner-a';
    const ownerAFile = path.join(root, h.owner, 'model-catalog-overrides.json');
    await fsp.mkdir(path.dirname(ownerAFile), { recursive: true });
    await fsp.writeFile(
      ownerAFile,
      JSON.stringify({
        version: 1,
        additions: {
          'openai:owner-a-only': {
            agents: ['codex'],
            base: {
              name: 'Owner A only',
              contextWindow: 32_000,
              efforts: ['high'],
              defaultEffort: 'high',
            },
          },
        },
      }),
      'utf8',
    );

    try {
      syncLocalCatalogOverridesIntoActiveCatalog();
      expect(
        getActiveCatalog()
          .providers.find((provider) => provider.id === 'openai')
          ?.models.codex?.some((model) => model.id === 'owner-a-only'),
      ).toBe(true);

      h.owner = 'owner-b';
      await reloadActiveCatalogForEndpointChange();
      expect(
        getActiveCatalog()
          .providers.find((provider) => provider.id === 'openai')
          ?.models.codex?.some((model) => model.id === 'owner-a-only'),
      ).toBe(false);
    } finally {
      h.owner = 'owner-default';
      await fsp.rm(root, { recursive: true, force: true });
      syncLocalCatalogOverridesIntoActiveCatalog();
    }
  });

  it('XDT_DISABLE_MODELS_FETCH=1 时手动刷新不发请求,抛 MODEL_CATALOG_FETCH_DISABLED 而非伪装的网络失败', async () => {
    const savedUrl = process.env.XDT_MODELS_URL;
    const savedPath = process.env.XDT_MODELS_PATH;
    const savedForceOff = process.env.XDT_DISABLE_MODELS_FETCH;
    delete process.env.XDT_MODELS_URL;
    delete process.env.XDT_MODELS_PATH;
    process.env.XDT_DISABLE_MODELS_FETCH = '1';
    try {
      const loadsBefore = h.refreshLoads.length;
      await expect(refreshActiveCatalogFromSource()).rejects.toMatchObject({
        code: 'MODEL_CATALOG_FETCH_DISABLED',
      });
      expect(h.refreshLoads).toHaveLength(loadsBefore);
    } finally {
      if (savedUrl === undefined) delete process.env.XDT_MODELS_URL;
      else process.env.XDT_MODELS_URL = savedUrl;
      if (savedPath === undefined) delete process.env.XDT_MODELS_PATH;
      else process.env.XDT_MODELS_PATH = savedPath;
      if (savedForceOff === undefined) delete process.env.XDT_DISABLE_MODELS_FETCH;
      else process.env.XDT_DISABLE_MODELS_FETCH = savedForceOff;
    }
  });
});
