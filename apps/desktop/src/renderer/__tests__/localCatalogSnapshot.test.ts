import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  beginCapabilities: vi.fn(),
  commitCapabilities: vi.fn(),
  capabilitiesCurrent: vi.fn(),
  loadCapabilities: vi.fn(),
  beginProviders: vi.fn(),
  commitProviders: vi.fn(),
  providersCurrent: vi.fn(),
  loadProviders: vi.fn(),
  initializeVisibility: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  beginLocalCapabilitiesRefresh: mocks.beginCapabilities,
  commitLocalCapabilitiesSnapshot: mocks.commitCapabilities,
  isLocalCapabilitiesRefreshCurrent: mocks.capabilitiesCurrent,
  loadLocalCapabilitiesSnapshot: mocks.loadCapabilities,
}));

vi.mock('@/lib/providersSnapshotStore', () => ({
  beginProvidersRefresh: mocks.beginProviders,
  commitProvidersSnapshot: mocks.commitProviders,
  isProvidersRefreshCurrent: mocks.providersCurrent,
  loadProvidersSnapshot: mocks.loadProviders,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: mocks.warn }),
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  migrateModelVisibilityDefaults: mocks.initializeVisibility,
}));

import { preloadLocalCatalogSnapshot, refreshLocalCatalogSnapshot } from '@/lib/localCatalogSnapshot';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('refreshLocalCatalogSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let providerGeneration = 0;
    let capabilitiesGeneration = 0;
    mocks.beginProviders.mockImplementation(() => ++providerGeneration);
    mocks.beginCapabilities.mockImplementation(() => ++capabilitiesGeneration);
    mocks.providersCurrent.mockReturnValue(true);
    mocks.capabilitiesCurrent.mockReturnValue(true);
    mocks.commitProviders.mockReturnValue(true);
    mocks.commitCapabilities.mockReturnValue(true);
    mocks.initializeVisibility.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the last valid snapshot when any member of the refresh fails', async () => {
    mocks.loadProviders.mockRejectedValueOnce(new Error('provider IPC failed'));
    mocks.loadCapabilities.mockResolvedValueOnce([]);

    await expect(refreshLocalCatalogSnapshot()).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('keeps the last valid snapshot when capabilities loading fails', async () => {
    mocks.loadProviders.mockResolvedValueOnce({ providers: [{ id: 'provider-old' }] });
    mocks.loadCapabilities.mockRejectedValueOnce(new Error('Pi capability IPC failed'));

    await expect(refreshLocalCatalogSnapshot()).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('waits for sibling reads after a failure before starting the trailing round', async () => {
    const slow = deferred<unknown[]>();
    mocks.loadProviders.mockRejectedValueOnce(new Error('failed')).mockResolvedValue({ providers: [] });
    mocks.loadCapabilities.mockReturnValueOnce(slow.promise).mockResolvedValue([]);
    const first = refreshLocalCatalogSnapshot();
    await vi.waitFor(() => expect(mocks.loadProviders).toHaveBeenCalledOnce());
    const latest = refreshLocalCatalogSnapshot();
    await Promise.resolve();
    expect(mocks.loadProviders).toHaveBeenCalledOnce();
    slow.resolve([]);
    await Promise.all([first, latest]);
    expect(mocks.loadProviders).toHaveBeenCalledTimes(2);
    expect(mocks.commitProviders).toHaveBeenCalledOnce();
  });

  it('does not commit capabilities when the provider snapshot owner is stale', async () => {
    const providers = {
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      providers: [{ id: 'owner-b-provider' }],
      providerOrder: ['owner-b-provider'],
    };
    mocks.loadProviders.mockResolvedValueOnce(providers);
    mocks.loadCapabilities.mockResolvedValueOnce([]);
    mocks.providersCurrent.mockImplementation((_token, snapshot) => snapshot !== providers);

    await expect(refreshLocalCatalogSnapshot()).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
  });

  it('coalesces repeated invalidations into one trailing read and never commits the stale round', async () => {
    const oldProviders = deferred<unknown[]>();
    const oldCapabilities = deferred<unknown[]>();
    const newProviders = deferred<unknown[]>();
    const newCapabilities = deferred<unknown[]>();
    mocks.loadProviders
      .mockReturnValueOnce(oldProviders.promise)
      .mockReturnValueOnce(newProviders.promise);
    mocks.loadCapabilities
      .mockReturnValueOnce(oldCapabilities.promise)
      .mockReturnValueOnce(newCapabilities.promise);

    const oldRefresh = refreshLocalCatalogSnapshot();
    await vi.waitFor(() => expect(mocks.loadProviders).toHaveBeenCalledTimes(1));
    const duplicates = Array.from({ length: 20 }, () => refreshLocalCatalogSnapshot());
    const newRefresh = refreshLocalCatalogSnapshot();
    expect(mocks.loadProviders).toHaveBeenCalledTimes(1);
    oldProviders.resolve([{ id: 'old-provider' }]);
    oldCapabilities.resolve([['codex', { availableModels: [{ id: 'old-model' }] }]]);
    await vi.waitFor(() => expect(mocks.loadProviders).toHaveBeenCalledTimes(2));
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    newProviders.resolve([{ id: 'new-provider' }]);
    newCapabilities.resolve([['codex', { availableModels: [{ id: 'new-model' }] }]]);
    await expect(newRefresh).resolves.toBe(true);

    await expect(oldRefresh).resolves.toBe(true);
    await Promise.all(duplicates);
    expect(mocks.loadCapabilities).toHaveBeenCalledTimes(2);

    expect(mocks.commitProviders).toHaveBeenCalledTimes(1);
    expect(mocks.commitProviders.mock.calls[0]?.[1]).toEqual([{ id: 'new-provider' }]);
    expect(mocks.commitCapabilities).toHaveBeenCalledTimes(1);
  });

  it('does not make a new owner wait for the old owner and drops the old queued refresh', async () => {
    const old = deferred<unknown[]>();
    mocks.loadProviders.mockReturnValueOnce(old.promise).mockResolvedValue({ providers: [] });
    mocks.loadCapabilities.mockResolvedValue([]);
    const first = refreshLocalCatalogSnapshot();
    await vi.waitFor(() => expect(mocks.loadProviders).toHaveBeenCalledOnce());
    const obsolete = refreshLocalCatalogSnapshot();
    setDataOwnerGeneration('new-owner');
    await expect(refreshLocalCatalogSnapshot()).resolves.toBe(true);
    old.resolve([]);
    await Promise.all([first, obsolete]);
    expect(mocks.loadProviders).toHaveBeenCalledTimes(2);
    expect(mocks.commitProviders).toHaveBeenCalledOnce();
    setDataOwnerGeneration(null);
  });

  it('waits for visibility initialization and rechecks ownership before publishing either snapshot', async () => {
    const initialization = deferred<boolean>();
    const providers = { dataOwnerId: 'owner-a', ownerGeneration: 1, providers: [], providerOrder: [] };
    mocks.loadProviders.mockResolvedValueOnce(providers);
    mocks.loadCapabilities.mockResolvedValueOnce([]);
    mocks.initializeVisibility.mockReturnValueOnce(initialization.promise);
    const refresh = refreshLocalCatalogSnapshot();
    await vi.waitFor(() => expect(mocks.initializeVisibility).toHaveBeenCalledOnce());
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
    mocks.providersCurrent.mockReturnValue(false);
    expect(mocks.initializeVisibility.mock.calls[0]?.[3]()).toBe(false);
    initialization.resolve(true);
    await expect(refresh).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
  });

  it.each(['new', 'existing'] as const)('publishes a shared %s profile with no legacy preferences and preserves scoped choices', async (profileOrigin) => {
    const legacyKey = 'xdt:modelVisibilityPrefs:v1';
    const mapKey = `${legacyKey}.owner.owner-a`;
    const saved = new Map<string, string>([[mapKey, JSON.stringify({ 'pi:xd:hidden': false })]]);
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
      removeItem: (key: string) => { saved.delete(key); },
    };
    const sync = vi.fn(async () => undefined);
    const listeners = new Set<(event: StorageEvent) => void>();
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, run: () => boolean) => run() } });
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      localStorage: storage,
      addEventListener: (_type: string, listener: (event: StorageEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: StorageEvent) => void) => listeners.delete(listener),
      electronAPI: { maker: {
        syncModelVisibility: sync,
        claimLegacyModelVisibilityOwner: () => ({
          dataOwnerId: 'owner-a', ownerGeneration: 1, canWriteOwnerScoped: true,
          claimed: true, claimedByOtherOwner: false, canInitialize: false, profileOrigin,
        }),
      } },
    });
    vi.resetModules();
    const prefs = await vi.importActual<typeof import('@/state/modelVisibilityPrefs')>('@/state/modelVisibilityPrefs');
    prefs.__resetForTest();
    // The reset clears preference keys; restore the existing scoped choice.
    storage.setItem(mapKey, JSON.stringify({ 'pi:xd:hidden': false }));
    try {
      await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
      const provider = { id: 'xd', agents: ['pi'], routing: {}, models: { pi: [
        { id: 'recommended', defaultEnabled: true }, { id: 'hidden', defaultEnabled: true },
      ] } } as unknown as ProviderView;
      const snapshot = { dataOwnerId: 'owner-a', ownerGeneration: 1, providers: [provider], providerOrder: ['xd'] };
      mocks.loadProviders.mockResolvedValue(snapshot);
      mocks.loadCapabilities.mockResolvedValue([]);
      mocks.initializeVisibility.mockImplementation(prefs.migrateModelVisibilityDefaults);
      await expect(refreshLocalCatalogSnapshot()).resolves.toBe(true);
      expect(mocks.commitProviders).toHaveBeenCalledWith(expect.anything(), snapshot);
      expect(prefs.isModelEnabled('pi', 'xd', { id: 'recommended', defaultEnabled: true })).toBe(true);
      expect(prefs.isModelEnabled('pi', 'xd', { id: 'hidden', defaultEnabled: true })).toBe(false);
      expect(saved.get(`${legacyKey}.migration-complete.owner.owner-a`)).toBeUndefined();
      expect(sync).toHaveBeenLastCalledWith('owner-a', 1, { 'pi:xd:hidden': false },
        expect.not.objectContaining({ pending: true }));

      // A concurrent old window can create legacy data later: do not lose its
      // choices or continue presenting uninitialized defaults as ready.
      storage.setItem(legacyKey, JSON.stringify({ 'pi:xd:recommended': false }));
      for (const listener of listeners) listener({ key: legacyKey, storageArea: storage } as unknown as StorageEvent);
      await vi.waitFor(() => expect(sync).toHaveBeenLastCalledWith('owner-a', 1,
        { 'pi:xd:hidden': false }, expect.objectContaining({ pending: true })));
      expect(prefs.isModelEnabled('pi', 'xd', { id: 'recommended', defaultEnabled: true })).toBe(false);
      await expect(refreshLocalCatalogSnapshot()).resolves.toBe(false);
      expect(storage.getItem(legacyKey)).toBe(JSON.stringify({ 'pi:xd:recommended': false }));
    } finally {
      prefs.__resetForTest();
    }
  });

  it.each([
    ['storage', true], ['lock', true], ['storage', false], ['lock', false],
  ] as const)('propagates real %s initialization failures through preload (recovers: %s)', async (failure, recovers) => {
    vi.useFakeTimers();
    const saved = new Map<string, string>();
    let rejectWrite = false;
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      removeItem: (key: string) => { saved.delete(key); },
      setItem: (key: string, value: string) => {
        if (rejectWrite) throw new Error('storage full');
        saved.set(key, value);
      },
    };
    const sync = vi.fn(async () => undefined);
    let rejectLock = false;
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, run: () => boolean) => {
      if (rejectLock) throw new Error('lock unavailable');
      return run();
    } } });
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage, electronAPI: { maker: {
      syncModelVisibility: sync,
      claimLegacyModelVisibilityOwner: () => ({
        dataOwnerId: 'owner-a', ownerGeneration: 1, canWriteOwnerScoped: true,
        claimed: true, claimedByOtherOwner: false, canInitialize: true, profileOrigin: 'new',
      }),
    } } });
    const prefs = await vi.importActual<typeof import('@/state/modelVisibilityPrefs')>('@/state/modelVisibilityPrefs');
    prefs.__resetForTest();
    try {
      await prefs.setModelVisibilityOwner('owner-a', 1, 'cloud');
      const provider: ProviderView = {
        id: 'xd', name: 'Cindy AI', source: 'builtin', connected: true, agents: ['pi'],
        auth: { method: 'apiKey' }, routing: {}, models: { pi: [{
          id: 'recommended', name: 'Recommended', defaultEnabled: true,
          contextWindow: 200000, efforts: [], defaultEffort: null,
        }] },
      };
      const providers = { dataOwnerId: 'owner-a', ownerGeneration: 1, providers: [provider], providerOrder: ['xd'] };
      mocks.loadProviders.mockResolvedValue(providers);
      mocks.loadCapabilities.mockResolvedValue([['pi', { availableModels: provider.models.pi }]]);
      mocks.initializeVisibility.mockImplementation(prefs.migrateModelVisibilityDefaults);
      rejectWrite = failure === 'storage';
      rejectLock = failure === 'lock';
      const preload = preloadLocalCatalogSnapshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.loadProviders).toHaveBeenCalledTimes(1);
      expect(mocks.commitProviders).not.toHaveBeenCalled();
      expect(mocks.commitCapabilities).not.toHaveBeenCalled();
      expect(sync).toHaveBeenLastCalledWith('owner-a', 1, {}, expect.objectContaining({ pending: true }));

      if (recovers) { rejectWrite = false; rejectLock = false; }
      await vi.advanceTimersByTimeAsync(1000);
      await preload;
      expect(mocks.loadProviders).toHaveBeenCalledTimes(recovers ? 2 : 3);
      expect(mocks.commitProviders).toHaveBeenCalledTimes(recovers ? 1 : 0);
      expect(mocks.commitCapabilities).toHaveBeenCalledTimes(recovers ? 1 : 0);
      if (recovers) {
        expect(mocks.commitProviders).toHaveBeenLastCalledWith(2, providers);
        expect(sync).toHaveBeenLastCalledWith('owner-a', 1, {},
          expect.not.objectContaining({ pending: true }));
        expect(prefs.isModelEnabled('pi', 'xd', { id: 'recommended' })).toBe(true);
      } else {
        expect(mocks.warn).toHaveBeenCalledWith('local catalog snapshot preload failed after 3 attempts');
        expect(sync).toHaveBeenLastCalledWith('owner-a', 1, {}, expect.objectContaining({ pending: true }));
      }
    } finally {
      prefs.__resetForTest();
    }
  });
});
