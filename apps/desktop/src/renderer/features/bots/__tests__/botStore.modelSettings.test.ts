// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({ lastByVendor: { cc: {}, codex: {}, pi: {} } }),
  getDraftForPreferenceSync: () => ({ vendor: 'cc', lastByVendor: { cc: { model: '' } }, fastModeByModel: {} }),
  getPersistedVendorModel: () => '',
}));
vi.mock('@/lib/modelDefinitions', () => ({
  getDefaultModelForVendor: () => ({ id: 'default', defaultEffort: 'medium' }),
}));
vi.mock('../botReadState', () => ({
  getBotLastReadAtMap: () => ({}), pruneBotReadState: vi.fn(), seedMissingBotReadState: vi.fn(),
}));

const route = (model: string) => ({ harness: 'pi' as const, model, providerId: 'xd', effort: '', fastMode: false });
const saved = { modelChain: [route('saved')], isCustomized: true };
const defaults = { modelChain: [route('current-default')], isCustomized: false };
const legacyKey = 'cindy.bots.global-model-chain.v2';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function apiFixture() {
  let disk = saved;
  const api = {
    list: vi.fn(async () => [] as unknown[]),
    getModelChainSettings: vi.fn(async () => disk),
    setModelChainSettings: vi.fn(async ({ modelChain }: { modelChain: typeof saved.modelChain }) => {
      disk = { modelChain, isCustomized: true };
      return disk;
    }),
    resetModelChainSettings: vi.fn(async () => { disk = defaults; return disk; }),
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: api } } });
  return api;
}
async function hydratedStore(api: ReturnType<typeof apiFixture>) {
  const store = await import('../botStore');
  await vi.waitFor(() => expect(api.list).toHaveBeenCalledOnce());
  return store;
}

beforeEach(() => { vi.resetModules(); window.localStorage.clear(); });

describe('global teammate model restore', () => {
  it('refreshes followers, preserves explicit per-Bot models, and drops the legacy cache', async () => {
    const api = apiFixture();
    const bot = { id: 'following', name: 'Follower', capabilities: { ...route('saved'), modelChain: saved.modelChain, modelChainOverride: null, modelOverride: null } };
    api.list.mockResolvedValueOnce([bot, { ...bot, id: 'custom', capabilities: { ...bot.capabilities, modelChainOverride: [route('per-bot')] } }]);
    const store = await hydratedStore(api);
    window.localStorage.setItem(legacyKey, JSON.stringify(saved.modelChain));
    const listener = vi.fn();
    store.subscribeBotGlobalModel(listener);
    await store.resetBotGlobalModelChain();
    expect(store.getEffectiveBotModelChain()).toEqual(defaults.modelChain);
    expect(store.isBotGlobalModelChainCustomized()).toBe(false);
    expect(store.getBotProfiles().find((b) => b.id === 'following')?.capabilities.modelChain).toEqual(defaults.modelChain);
    expect(store.getBotProfiles().find((b) => b.id === 'custom')?.capabilities.modelChainOverride).toEqual([route('per-bot')]);
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(store.isBotGlobalModelChainCustomized()).toBe(false);
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
  });

  it('preserves state after reset failure and allows the next save to succeed', async () => {
    const api = apiFixture();
    const store = await hydratedStore(api);
    api.resetModelChainSettings.mockRejectedValueOnce(new Error('reset failed'));
    await expect(store.resetBotGlobalModelChain()).rejects.toThrow('reset failed');
    expect(store.getEffectiveBotModelChain()).toEqual(saved.modelChain);
    expect(store.isBotGlobalModelChainCustomized()).toBe(true);
    await store.setBotGlobalModelChain([route('next')]);
    expect(store.getEffectiveBotModelChain()).toEqual([route('next')]);
  });

  it('serializes save, restore and save in user order', async () => {
    const api = apiFixture();
    const store = await hydratedStore(api);
    const pending = deferred<typeof saved>();
    api.setModelChainSettings.mockReturnValueOnce(pending.promise);
    const first = store.setBotGlobalModelChain([route('first')]);
    const reset = store.resetBotGlobalModelChain();
    const last = store.setBotGlobalModelChain([route('last')]);
    await vi.waitFor(() => expect(api.setModelChainSettings).toHaveBeenCalledOnce());
    expect(api.resetModelChainSettings).not.toHaveBeenCalled();
    pending.resolve({ ...saved, modelChain: [route('first')] });
    await Promise.all([first, reset, last]);
    expect(store.getEffectiveBotModelChain()).toEqual([route('last')]);
    expect(store.isBotGlobalModelChainCustomized()).toBe(true);
    expect(api.resetModelChainSettings.mock.invocationCallOrder[0]).toBeLessThan(api.setModelChainSettings.mock.invocationCallOrder[1]!);
  });

  it('finishes a late legacy migration before restore, so it cannot resurrect the override', async () => {
    const api = apiFixture();
    const read = deferred<typeof defaults>();
    api.getModelChainSettings.mockReturnValueOnce(read.promise);
    window.localStorage.setItem(legacyKey, JSON.stringify([route('legacy')]));
    const store = await import('../botStore');
    await vi.waitFor(() => expect(api.getModelChainSettings).toHaveBeenCalledOnce());
    const reset = store.resetBotGlobalModelChain();
    read.resolve(defaults);
    await reset;
    expect(api.setModelChainSettings).toHaveBeenCalledWith({ modelChain: [route('legacy')] });
    expect(api.setModelChainSettings.mock.invocationCallOrder[0]).toBeLessThan(api.resetModelChainSettings.mock.invocationCallOrder[0]!);
    expect(store.getEffectiveBotModelChain()).toEqual(defaults.modelChain);
    expect(store.isBotGlobalModelChainCustomized()).toBe(false);
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });

  it('rejects old-owner responses and queued writes before they reach the new account', async () => {
    const api = apiFixture();
    const store = await hydratedStore(api);
    const owner = await import('@/contexts/dataOwnerGeneration');
    const pending = deferred<typeof defaults>();
    api.resetModelChainSettings.mockReturnValueOnce(pending.promise);
    const reset = store.resetBotGlobalModelChain();
    const queued = store.setBotGlobalModelChain([route('old-owner')]);
    const resetRejected = expect(reset).rejects.toThrow('owner changed');
    const queuedRejected = expect(queued).rejects.toThrow('owner changed');
    await vi.waitFor(() => expect(api.resetModelChainSettings).toHaveBeenCalledOnce());
    owner.setDataOwnerGeneration('next-owner');
    const nextChain = [route('new-owner')];
    await store.setBotGlobalModelChain(nextChain);
    pending.resolve(defaults);
    await Promise.all([resetRejected, queuedRejected]);
    expect(store.getEffectiveBotModelChain()).toEqual(nextChain);
    expect(api.setModelChainSettings).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty derived default and later refreshed defaults without persisting them', async () => {
    const api = apiFixture();
    const store = await hydratedStore(api);
    api.resetModelChainSettings.mockResolvedValueOnce({ modelChain: [], isCustomized: false });
    await store.resetBotGlobalModelChain();
    expect(store.getEffectiveBotModelChain()).toEqual([]);
    api.getModelChainSettings.mockResolvedValueOnce({ modelChain: [route('new-source-default')], isCustomized: false });
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getEffectiveBotModelChain()).toEqual([route('new-source-default')]));
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
    expect(store.isBotGlobalModelChainCustomized()).toBe(false);
  });
  it('keeps initial read failure unknown and allows direct recovery without visiting the roster', async () => {
    const api = apiFixture();
    api.getModelChainSettings.mockRejectedValueOnce(new Error('temporarily unavailable'));
    const store = await hydratedStore(api);
    expect(store.isBotGlobalModelChainCustomized()).toBeNull();
    await store.resetBotGlobalModelChain();
    expect(api.getModelChainSettings).toHaveBeenCalledOnce();
    expect(api.resetModelChainSettings).toHaveBeenCalledOnce();
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
    expect(store.isBotGlobalModelChainCustomized()).toBe(false);
    expect(store.getEffectiveBotModelChain()).toEqual(defaults.modelChain);
  });

});
