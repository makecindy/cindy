import type { BotModelRoute } from '../../../shared/botModelChain';
import type { ProviderView } from '@cindy/model-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeAppDefaultModel, configureAppDefaultModelSelection, inspectAppDefaultModel } from '../appDefaultModelControl';
import { setNewMakerDraftCache, syncNewMakerDraftCache } from '../../maker-host/newMakerDefaultsCache';

const host = vi.hoisted(() => ({ owner: 'owner:1', enabled: true, connected: true, agents: ['codex'],
  enableSecond: false, providers: vi.fn() }));
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: () => ({ listAvailableAgents: () => host.agents }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: host.providers }),
}));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({
  waitForModelVisibilityMirror: async () => {}, getModelVisibilityOverride: (_a: string, _p: string, model: string) => host.enabled && (model === 'luna' || (model === 'sol' && host.enableSecond)),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => host.owner, isAppSessionBoundaryPending: () => false,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
}));
const route = { harness: 'codex' as const, providerId: 'openai', model: 'luna', effort: 'medium', fastMode: false };
const mirror = (selectedRoute: BotModelRoute = route, requestId?: string) => setNewMakerDraftCache({ selectedRoute,
  lastByVendor: {}, fastModeByModel: {}, effortByModel: {} }, host.owner, requestId);
const id = JSON.stringify(['codex', 'openai', 'luna']);

beforeEach(() => {
  host.enableSecond = false;
  host.owner = 'owner:1'; host.enabled = true; host.connected = true; host.agents = ['codex'];
  host.providers.mockImplementation(async () => [{ id: 'openai', source: 'builtin', connected: host.connected, agents: ['codex'], routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
    models: { codex: ['luna', 'sol'].map(model => ({ id: model, status: 'active', mode: 'chat', defaultEnabled: true,
      efforts: ['low', 'medium'], defaultEffort: 'medium', supportsFastMode: true })) } }] as ProviderView[]);
  mirror();
});
afterEach(() => { configureAppDefaultModelSelection(null); vi.useRealTimers(); });

describe('Bot control of the real Cindy default', () => {
  it('only lists the enabled connected model, even if another model is in the catalog', async () => {
    expect(await inspectAppDefaultModel()).toMatchObject({ current: route, available: [{ id, route }] });
    expect((await inspectAppDefaultModel()).available).toHaveLength(1);
  });
  it.each(['disabled', 'disconnected', 'missing harness'] as const)('rejects a stale selection that is now %s', async failure => {
    await inspectAppDefaultModel();
    if (failure === 'disabled') host.enabled = false;
    if (failure === 'disconnected') host.connected = false;
    if (failure === 'missing harness') host.agents = [];
    const dispatch = vi.fn(); configureAppDefaultModelSelection(dispatch);
    await expect(changeAppDefaultModel(id)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('waits for the real owner-fenced mirror instead of mutating the cache itself', async () => {
    const dispatch = vi.fn(selection => mirror(selection.route, selection.requestId));
    configureAppDefaultModelSelection(dispatch);
    expect(await changeAppDefaultModel(id, 'low')).toEqual({ current: { ...route, effort: 'low' } });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ expectedRoute: route,
      ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 } }));
  });
  it.each(['openai', null])('preserves Fast for an effort-only change with source %s', async providerId => {
    const current = { ...route, providerId, fastMode: true };
    mirror(current);
    const dispatch = vi.fn(selection => mirror(selection.route, selection.requestId));
    configureAppDefaultModelSelection(dispatch);
    expect(await changeAppDefaultModel(id, 'low')).toEqual({ current: { ...route, effort: 'low', fastMode: true } });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ expectedRoute: current }));
  });
  it('keeps both current effort and Fast when reselecting without extra fields', async () => {
    mirror({ ...route, effort: 'low', fastMode: true });
    configureAppDefaultModelSelection(selection => mirror(selection.route, selection.requestId));
    expect(await changeAppDefaultModel(id)).toEqual({ current: { ...route, effort: 'low', fastMode: true } });
  });
  it('does not carry Fast to a route which no longer supports it', async () => {
    mirror({ ...route, fastMode: true });
    const providers = await host.providers();
    providers[0].models.codex[0].supportsFastMode = false;
    host.providers.mockResolvedValue(providers);
    configureAppDefaultModelSelection(selection => mirror(selection.route, selection.requestId));
    expect((await changeAppDefaultModel(id, 'low')).current.fastMode).toBe(false);
  });
  it.each([
    { requestedEffort: undefined, rememberedFast: true },
    { requestedEffort: 'medium', rememberedFast: true },
    { requestedEffort: undefined, rememberedFast: false },
  ])('restores another model from picker memory and persists its tuning: %j', async ({ requestedEffort, rememberedFast }) => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } };
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('localStorage', storage);
    try {
      const draft = await import('../../../renderer/state/newMakerDraft');
      const memory = await import('../../../renderer/state/providerModelMemory');
      const { setDataOwnerGeneration } = await import('../../../renderer/contexts/dataOwnerGeneration');
      setDataOwnerGeneration('owner', 1);
      draft.setNewMakerDraftOwner('owner');
      memory.setProviderModelMemoryOwner('owner');
      draft.patchVendorPrefs('codex', { model: 'luna', providerId: 'openai', effort: 'medium' });
      draft.switchVendor('codex');
      // Non-selected picker edits live in provider memory, not the draft's old per-model tables.
      memory.setProviderModelEffort('codex', 'openai', 'sol', 'low');
      memory.setProviderModelFast('codex', 'openai', 'sol', rememberedFast);
      const sync = (requestId?: string) => {
        const data = draft.getDraft();
        const selected = data.lastByVendor.codex;
        expect(syncNewMakerDraftCache({ ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
          appDefaultModelRequestId: requestId, selectedRoute: { harness: 'codex', model: selected.model,
          providerId: selected.providerId ?? null, effort: selected.effort,
          fastMode: data.fastModeByModel[selected.model] === true },
          lastByVendor: data.lastByVendor, effortByModel: data.effortByModel,
          fastModeByModel: data.fastModeByModel, providerModelMemory: memory.snapshotForSeed('owner') },
          { dataOwnerId: 'owner', ownerGeneration: 1 }, host.owner, false)).toBe(true);
      };
      sync();
      host.enableSecond = true;
      const targetId = JSON.stringify(['codex', 'openai', 'sol']);
      expect((await inspectAppDefaultModel()).available.find(item => item.id === targetId)?.route)
        .toMatchObject({ effort: 'low', fastMode: rememberedFast });
      configureAppDefaultModelSelection(selection => {
        expect(draft.applyAppDefaultModelSelection(selection)).toBe(true);
        sync(selection.requestId);
      });
      const expected = { ...route, model: 'sol', effort: requestedEffort ?? 'low', fastMode: rememberedFast };
      expect(await changeAppDefaultModel(targetId, requestedEffort)).toEqual({ current: expected });
      const persisted = JSON.parse(storage.getItem('xdt:newMakerDraft:v1:owner')!);
      expect(persisted.lastByVendor.codex).toMatchObject({ model: 'sol', effort: expected.effort });
      expect(persisted.effortByModel.sol).toBe(expected.effort);
      expect(persisted.fastModeByModel.sol).toBe(rememberedFast);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('clamps remembered tuning to the target capabilities', async () => {
    host.enableSecond = true;
    setNewMakerDraftCache({ selectedRoute: route, lastByVendor: {}, effortByModel: {}, fastModeByModel: {},
      providerModelMemory: { 'codex:openai': { effortByModel: { sol: 'removed-effort' }, fastByModel: { sol: true } } } }, host.owner);
    const providers = await host.providers();
    providers[0].models.codex[1].supportsFastMode = false;
    host.providers.mockResolvedValue(providers);
    const target = (await inspectAppDefaultModel()).available.find(item => item.route.model === 'sol');
    expect(target?.route).toMatchObject({ effort: 'medium', fastMode: false });
  });
  it('does not claim success when an unrelated mirror matches but the renderer never confirms this write', async () => {
    vi.useFakeTimers(); configureAppDefaultModelSelection(() => mirror());
    const result = expect(changeAppDefaultModel(id)).rejects.toThrow('未确认');
    await vi.advanceTimersByTimeAsync(5001); await result;
  });
  it('rejects an owner switch during catalog reading before dispatch', async () => {
    const providers = await host.providers();
    host.providers.mockImplementation(async () => { host.owner = 'owner:2'; return providers; });
    const dispatch = vi.fn(); configureAppDefaultModelSelection(dispatch);
    await expect(changeAppDefaultModel(id)).rejects.toThrow('账号');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects an unsupported effort without changing anything', async () => {
    const dispatch = vi.fn(); configureAppDefaultModelSelection(dispatch);
    await expect(changeAppDefaultModel(id, 'ultra')).rejects.toThrow('不可用');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
