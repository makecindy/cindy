import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  beginCapabilities: vi.fn(),
  commitCapabilities: vi.fn(),
  capabilitiesCurrent: vi.fn(),
  loadCapabilities: vi.fn(),
  beginProviders: vi.fn(),
  commitProviders: vi.fn(),
  providersCurrent: vi.fn(),
  loadProviders: vi.fn(),
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

import { refreshLocalCatalogSnapshot } from '@/lib/localCatalogSnapshot';

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
  });

  it('keeps the last valid snapshot when any member of the refresh fails', async () => {
    mocks.loadProviders.mockRejectedValueOnce(new Error('provider IPC failed'));
    mocks.loadCapabilities.mockResolvedValueOnce([]);

    await expect(refreshLocalCatalogSnapshot()).resolves.toBe(false);
    expect(mocks.commitProviders).not.toHaveBeenCalled();
    expect(mocks.commitCapabilities).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('drops an older refresh that finishes after a newer generation', async () => {
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
    const newRefresh = refreshLocalCatalogSnapshot();
    newProviders.resolve([{ id: 'new-provider' }]);
    newCapabilities.resolve([['codex', { availableModels: [{ id: 'new-model' }] }]]);
    await expect(newRefresh).resolves.toBe(true);

    oldProviders.resolve([{ id: 'old-provider' }]);
    oldCapabilities.resolve([['codex', { availableModels: [{ id: 'old-model' }] }]]);
    await expect(oldRefresh).resolves.toBe(false);

    expect(mocks.commitProviders).toHaveBeenCalledTimes(1);
    expect(mocks.commitProviders.mock.calls[0]?.[1]).toEqual([{ id: 'new-provider' }]);
    expect(mocks.commitCapabilities).toHaveBeenCalledTimes(1);
  });
});
