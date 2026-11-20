import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as providers from '@/hooks/useDeviceProviders';
import * as capabilities from '@/hooks/useAgentCapabilities';
import { invalidateRemoteCatalogSnapshots, refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';
import { CONTROLLED_MODEL_CATALOG_CHANNEL, modelCatalogKey } from '../../shared/controlledModelCatalog';

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
  // A capability-only route has no provider-cache generation/history to retire.
  it('keeps a newly mounted capability-only route retired while its source refresh is queued', async () => {
    const source = deferred();
    let holdSource = true;
    const invoke = vi.fn(async (_device: string, channel: string, args: unknown[]) => {
      if (holdSource && channel !== CONTROLLED_MODEL_CATALOG_CHANNEL) await source.promise;
      const targetChannel = channel === CONTROLLED_MODEL_CATALOG_CHANNEL
        ? (args[0] as { channel: string }).channel : channel;
      return targetChannel === 'maker:provider:list' ? { providers: [] }
        : { availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [] };
    });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const first = refreshRemoteCatalogSnapshot('share:capability-only');
    await Promise.resolve();
    const target = modelCatalogKey('share:capability-only', 'task-host')!;
    const off = capabilities.subscribeDeviceCapabilities(target, 'codex', () => undefined);
    try {
      await capabilities.prefetchDeviceCapabilities(target);
      expect(providers.getCachedDeviceProviders(target)).toBeNull();
      const queued = refreshRemoteCatalogSnapshot('share:capability-only');
      providers.evictDeviceProviders('task-host');
      capabilities.evictDeviceCapabilities('task-host');
      const reads = invoke.mock.calls.length;
      holdSource = false;
      source.resolve();
      await Promise.all([first, queued]);
      expect(invoke.mock.calls.length).toBe(reads + 4); // Only the live source's trailing read.
      expect(capabilities.getCachedCapabilities('codex', target)).toBeNull();
      expect(providers.getCachedDeviceProviders(target)).toBeNull();
    } finally { off(); }
  });

  // #10711 routed-refresh repair / unit: a queued share refresh must not reopen
  // a task-host alias independently retired by control-disable/disconnect.
  it('does not reopen an independently retired routed target from a queued source refresh', async () => {
    const source = deferred();
    let holdSource = false;
    const invoke = vi.fn(async (_device: string, channel: string, args: unknown[]) => {
      if (holdSource && channel !== CONTROLLED_MODEL_CATALOG_CHANNEL) await source.promise;
      const targetChannel = channel === CONTROLLED_MODEL_CATALOG_CHANNEL
        ? (args[0] as { channel: string }).channel : channel;
      return targetChannel === 'maker:provider:list' ? { providers: [] }
        : { availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [] };
    });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    const target = modelCatalogKey('share:a', 'task-host')!;
    const off = providers.subscribeDeviceProviders(target, () => undefined);
    try {
      await refreshRemoteCatalogSnapshot(target);
      holdSource = true;
      const first = refreshRemoteCatalogSnapshot('share:a');
      await Promise.resolve(); // Start the blocked source read before queuing its trailing refresh.
      expect(invoke.mock.calls.filter(([, channel]) => channel !== CONTROLLED_MODEL_CATALOG_CHANNEL)).toHaveLength(4);
      const queued = refreshRemoteCatalogSnapshot('share:a');
      providers.evictDeviceProviders('task-host');
      capabilities.evictDeviceCapabilities('task-host');
      const routedReads = () => invoke.mock.calls.filter(([, channel]) => channel === CONTROLLED_MODEL_CATALOG_CHANNEL).length;
      const reads = routedReads();
      holdSource = false;
      source.resolve();
      await Promise.all([first, queued]);
      expect(routedReads()).toBe(reads);
      expect(providers.getCachedDeviceProviders(target)).toBeNull();
      expect(capabilities.getCachedCapabilities('codex', target)).toBeNull();
    } finally { off(); }
  });

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

    await Promise.all(['share:common', 'share:pending'].map((device) => refreshRemoteCatalogSnapshot(device)));
    for (const device of ['share:common', 'share:pending']) {
      expect(providers.getCachedDeviceProviders(device)?.providers[0].models.codex?.[0]?.id).toBe('member-b');
      expect(capabilities.getCachedCapabilities('codex', device)?.availableModels[0].id).toBe('member-b');
    }
    unsubscribe();
  });

  it('retires only the expired target providers and capabilities without opening either', async () => {
    const invoke = vi.fn(async (_device: string, channel: string) => channel === 'maker:provider:list'
      ? { providers: [] }
      : { availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [] });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
    await refreshRemoteCatalogSnapshot('share:expired');
    await refreshRemoteCatalogSnapshot('share:neighbor');
    expect(providers.getCachedDeviceProviders('share:expired')).not.toBeNull();
    expect(capabilities.getCachedCapabilities('codex', 'share:expired')).not.toBeNull();
    const reads = invoke.mock.calls.length;
    await refreshRemoteCatalogSnapshot('share:expired',
      { providerContinuity: { stale: true, remainingMs: 0 } }, { retireOnly: true });
    expect(providers.getCachedDeviceProviders('share:expired')).toBeNull();
    expect(capabilities.getCachedCapabilities('codex', 'share:expired')).toBeNull();
    expect(providers.getCachedDeviceProviders('share:neighbor')).not.toBeNull();
    expect(capabilities.getCachedCapabilities('codex', 'share:neighbor')).not.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(reads);
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

  // Unit: source-change recovery must discard the old read's rejection as well as
  // its success. Existing coverage only resolved old reads; a delayed scope error
  // must not replace the latest catalog or multiply the coalesced trailing read.
  it.each(['success', 'scope-change', 'disconnect'])(
    'coalesces a burst and rejects stale results (%s)',
    async (outcome) => {
      const disconnect = outcome === 'disconnect';
      const first = deferred();
      let revision = 'old';
      const invoke = vi.fn(async (_device: string, channel: string) => {
        const value = revision;
        if (value === 'old') {
          await first.promise;
          // Main invalidates a read already in flight when a source-change push arrives.
          if (outcome === 'scope-change') throw new Error('Metadata scope changed');
        }
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
      const offCapabilities = capabilities.subscribeDeviceCapabilities('test', 'codex', events);
      const providerEvents = vi.fn();
      const offProviders = providers.subscribeDeviceProviders('test', providerEvents);
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
      expect(events.mock.calls.some(([event]) => event.status === 'error')).toBe(false);
      expect(providerEvents.mock.calls.some(([event]) => event.status === 'error')).toBe(false);
      const ready = events.mock.calls
        .map(([event]) => event)
        .filter((event) => event.status === 'ready');
      expect(ready).toHaveLength(disconnect ? 0 : 1);
      if (!disconnect) expect(ready[0].capabilities.availableModels[0].id).toBe('new');
      // The completed coordinator does not cache results or suppress a later refresh.
      await refreshRemoteCatalogSnapshot('test');
      expect(invoke).toHaveBeenCalledTimes(disconnect ? 8 : 12);
      expect(providers.getCachedDeviceProviders('test')?.providers).toEqual([]);
      offCapabilities();
      offProviders();
    },
  );
});
