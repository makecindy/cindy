import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('remote catalog refresh scheduling', () => {
  it('lets another peer and a new link refresh while a retired link is still waiting', async () => {
    const old = deferred();
    let hold = true;
    const invoke = vi.fn(async (device: string, channel: string) => {
      if (device === 'old' && hold) await old.promise;
      return channel === 'maker:provider:list'
        ? { providers: [] }
        : {
            availableModels: [],
            hasFastMode: false,
            effortLevels: [],
            permissionModes: [],
          };
    });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const { refreshRemoteCatalogSnapshot: refresh } = await import('@/lib/remoteCatalogSnapshot');
    const providers = await import('@/hooks/useDeviceProviders');
    const first = refresh('old');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
    const obsolete = refresh('old');
    await refresh('healthy');
    expect(invoke).toHaveBeenCalledTimes(8);
    providers.evictDeviceProviders('old');
    hold = false;
    await refresh('old');
    expect(invoke).toHaveBeenCalledTimes(12);
    old.resolve();
    await Promise.all([first, obsolete]);
    expect(invoke).toHaveBeenCalledTimes(12);
  });

  it.each([false, true])(
    'coalesces a burst and rejects stale results (disconnect: %s)',
    async (disconnect) => {
      const first = deferred();
      let revision = 'old';
      const invoke = vi.fn(async (_device: string, channel: string) => {
        const value = revision;
        if (value === 'old') await first.promise;
        return channel === 'maker:provider:list'
          ? { providers: [] }
          : {
              availableModels: [
                {
                  id: value,
                  displayName: value,
                  contextWindow: 200000,
                  efforts: [],
                  defaultEffort: null,
                },
              ],
              hasFastMode: false,
              effortLevels: [],
              permissionModes: [],
            };
      });
      vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
      const { refreshRemoteCatalogSnapshot } = await import('@/lib/remoteCatalogSnapshot');
      const providers = await import('@/hooks/useDeviceProviders');
      const capabilities = await import('@/hooks/useAgentCapabilities');
      const events = vi.fn();
      capabilities.subscribeDeviceCapabilities('test', 'codex', events);
      const initial = refreshRemoteCatalogSnapshot('test');
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
      revision = 'new';
      const burst = Array.from({ length: 20 }, () => refreshRemoteCatalogSnapshot('test'));
      expect(invoke).toHaveBeenCalledTimes(4);
      if (disconnect) {
        providers.evictDeviceProviders('test');
        capabilities.evictDeviceCapabilities('test');
      }
      first.resolve();
      await Promise.all([initial, ...burst]);
      expect(invoke).toHaveBeenCalledTimes(disconnect ? 4 : 8);
      const ready = events.mock.calls
        .map(([event]) => event)
        .filter((event) => event.status === 'ready');
      expect(ready).toHaveLength(disconnect ? 0 : 1);
      if (!disconnect) expect(ready[0].capabilities.availableModels[0].id).toBe('new');
      // The completed coordinator does not cache results or suppress a later refresh.
      await refreshRemoteCatalogSnapshot('test');
      expect(invoke).toHaveBeenCalledTimes(disconnect ? 8 : 12);
    },
  );
});
