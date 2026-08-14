import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  endpoint: 'https://model.cn.example',
  buildEndpoint: 'https://model.cn.example',
  owner: 'owner-default',
  loads: [] as Array<{
    source: Record<string, unknown>;
    resolve: (catalog: unknown) => void;
  }>,
  refreshLoads: [] as Array<{
    source: Record<string, unknown>;
    resolve: (result: unknown) => void;
  }>,
  customProviderRead: vi.fn(),
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
      (source: Record<string, unknown>) =>
        new Promise((resolve) => {
          h.loads.push({ source, resolve });
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
  ownerScopedUserDataPath: (...segments: string[]) =>
    path.join(os.tmpdir(), 'provider-catalog-realm-reload', h.owner, ...segments),
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

import {
  BUNDLED_CATALOG,
  buildUserProvider,
  type Catalog,
  type CustomProviderConfig,
} from '@cindy/model-providers';
import {
  getActiveCatalog,
  setActiveCatalog,
  setActiveCatalogChangedListener,
  setCustomProviders,
} from '../active-catalog.js';
import {
  __testing,
  ensureActiveCatalogLoaded,
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

  it('ignores an automatic refresh response from a superseded realm', async () => {
    const staleRefresh = refreshActiveCatalogFromSource();
    await Promise.resolve();
    expect(h.refreshLoads[0]?.source).toMatchObject({
      baseUrl: 'https://model.cn.example',
    });

    h.endpoint = 'https://model.global.example';
    const globalReloadIndex = h.loads.length;
    const globalReload = reloadActiveCatalogForEndpointChange();
    h.loads[globalReloadIndex]!.resolve(
      catalogNamed('catalog-global-current', '2026-07-31T12:00:00.000Z'),
    );
    await globalReload;

    const currentRefresh = refreshActiveCatalogFromSource();
    await Promise.resolve();
    expect(h.refreshLoads[1]?.source).toMatchObject({
      baseUrl: 'https://model.global.example',
    });
    h.refreshLoads[1]!.resolve({
      catalog: catalogNamed('catalog-global-refreshed', '2026-07-31T12:30:00.000Z'),
      source: 'remote',
    });
    await currentRefresh;

    h.refreshLoads[0]!.resolve({
      catalog: catalogNamed('catalog-cn-stale', '2026-07-31T13:00:00.000Z'),
      source: 'remote',
    });
    await staleRefresh;

    expect(activeMarker()).toBe('catalog-global-current');
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
      // 同一时刻仅 ISO 表示不同：Registry 内容相同，应 no-op 且不误报警。
      await refreshWith('equivalent-z', '2026-08-02T02:00:00.000Z');
      expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-08-02T10:00:00+08:00');
      expect(h.warn).not.toHaveBeenCalled();

      await refreshWith('actually-older', '2026-08-02T01:59:59.000Z');
      expect(getActiveCatalog().modelRegistry?.updatedAt).toBe('2026-08-02T10:00:00+08:00');

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
