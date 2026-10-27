import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as providers from '@/hooks/useDeviceProviders';
import * as capabilities from '@/hooks/useAgentCapabilities';
import { invalidateRemoteCatalogSnapshots, refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';

beforeEach(() => {
  invalidateRemoteCatalogSnapshots();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('remote catalog refresh scheduling', () => {
  // 2026-10-20 黑盒验收：成员 A/B 使用同一个 shareId，B 的选择器显示 A 的模型。
  // 现有覆盖只驱逐单设备；最小输入为账号边界前的缓存和在途读取，tier: unit。
  it('clears all remote catalogs at an account boundary and rejects late old-owner results', async () => {
    const oldRequest = deferred();
    let owner = 'member-a';
    const invoke = vi.fn(async (device: string, channel: string) => {
      const model = owner;
      if (device === 'share:pending' && model === 'member-a') await oldRequest.promise;
      return channel === 'maker:provider:list'
        ? { providers: [{
            id: 'openai', name: 'OpenAI', connected: true, agents: ['codex'],
            models: { codex: [{ id: model, name: model, contextWindow: 200000, efforts: [] }] },
          }] }
        : { availableModels: [{ id: model, displayName: model, contextWindow: 200000,
            efforts: [], defaultEffort: null }], hasFastMode: false, effortLevels: [], permissionModes: [] };
    });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    await refreshRemoteCatalogSnapshot('share:common');
    expect(providers.getCachedDeviceProviders('share:common')?.providers[0].models.codex?.[0]?.id).toBe('member-a');
    const pending = refreshRemoteCatalogSnapshot('share:pending');
    const queued = refreshRemoteCatalogSnapshot('share:pending');

    invalidateRemoteCatalogSnapshots();
    owner = 'member-b';
    expect(providers.getCachedDeviceProviders('share:common')).toBeNull();
    expect(capabilities.getCachedCapabilities('codex', 'share:common')).toBeNull();
    const events = vi.fn();
    const unsubscribe = providers.subscribeDeviceProviders('share:pending', events);
    oldRequest.resolve();
    await Promise.all([pending, queued]);
    expect(events).not.toHaveBeenCalled();
    expect(providers.getCachedDeviceProviders('share:pending')).toBeNull();
    expect(capabilities.getCachedCapabilities('codex', 'share:pending')).toBeNull();

    await Promise.all(['share:common', 'share:pending'].map(refreshRemoteCatalogSnapshot));
    for (const device of ['share:common', 'share:pending']) {
      expect(providers.getCachedDeviceProviders(device)?.providers[0].models.codex?.[0]?.id).toBe('member-b');
      expect(capabilities.getCachedCapabilities('codex', device)?.availableModels[0].id).toBe('member-b');
    }
    unsubscribe();
  });

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
    const refresh = refreshRemoteCatalogSnapshot;
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
