// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { BotModelRoute } from '../../../../shared/botModelChain';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { __resetAvailableAgentsCacheForTest, useAvailableAgents } from '@/hooks/useAvailableAgents';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/localCatalogSnapshot', () => ({ refreshLocalCatalogSnapshot: vi.fn() }));
vi.mock('@/hooks/useAgentCapabilities', () => ({
  refreshLocalCapabilities: vi.fn(async () => {}),
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
}));
const selection = vi.hoisted(() => ({ harness: 'pi', providerId: 'xd', model: 'z-ai/glm-5.3-flash', effort: 'medium', fastMode: false }));
const visibility = vi.hoisted(() => ({ enabled: true, version: 0 }));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  migrateModelVisibilityDefaults: vi.fn(),
  isModelEnabled: () => visibility.enabled,
  getModelVisibilityVersion: () => visibility.version,
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({ lastByVendor: { pi: {}, cc: {}, codex: {} } }),
  getDraftForPreferenceSync: () => ({ vendor: selection.harness, lastByVendor: { [selection.harness]: selection }, fastModeByModel: {} }),
  getPersistedVendorModel: () => '',
}));
vi.mock('@/lib/modelDefinitions', () => ({
  getDefaultModelForVendor: () => ({ id: '', defaultEffort: 'medium' }),
}));

const gateway: BotModelRoute = {
  harness: 'pi', providerId: 'xd', model: 'auto', effort: 'medium', fastMode: false,
};
const openai: BotModelRoute = {
  harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: false,
};

function providers(gatewayConnected: boolean, openaiConnected: boolean): ProviderView[] {
  return [gateway, openai].map((route, index) => ({
    id: route.providerId,
    name: route.providerId,
    source: 'builtin',
    auth: { method: index === 0 ? 'managed' : 'oauth' },
    connected: index === 0 ? gatewayConnected : openaiConnected,
    agents: [route.harness],
    routing: { [route.harness]: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
    access: index === 0 ? { kind: 'managed' } : { kind: 'subscription', product: 'openai' },
    models: { [route.harness]: [{
      id: route.model, name: route.model, status: 'active', sortOrder: 0,
      contextWindow: 200_000, efforts: ['medium', 'high'], defaultEffort: 'medium',
      supportsFastMode: false, newSessionDefault: [route.harness], supportsImageInput: true,
    }] },
  })) as unknown as ProviderView[];
}

const listeners = new Set<() => void>();
async function setup(options: { customized?: boolean; empty?: boolean; pending?: boolean } = {}) {
  const initial = options.empty ? [] : [gateway];
  let resolveSettings!: (state: { modelChain: BotModelRoute[]; isCustomized: boolean }) => void;
  const getModelChainSettings = vi.fn(() => options.pending
    ? new Promise<{ modelChain: BotModelRoute[]; isCustomized: boolean }>((resolve) => {
      resolveSettings = resolve;
    })
    : Promise.resolve({ modelChain: initial, isCustomized: options.customized === true }));
  const setModelChainSettings = vi.fn(async ({ modelChain }: { modelChain: BotModelRoute[] }) => ({
    modelChain, isCustomized: true,
  }));
  const resetModelChainSettings = vi.fn(async () => ({ modelChain: [gateway], isCustomized: false }));
  const list = vi.fn(async () => []);
  const create = vi.fn(async (input: Record<string, unknown>) => ({
    ...input, enabled: true, createdAt: 1, sessions: [],
  }));
  const listAvailableAgents = vi.fn(async (): Promise<('pi' | 'codex')[]> => ['pi', 'codex']);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { bots: { getModelChainSettings, setModelChainSettings, resetModelChainSettings, list, create } },
    maker: {
      listAvailableAgents,
      onAgentsChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  } });
  const snapshots = await import('@/lib/providersSnapshotStore');
  const publish = (next: ProviderView[]) => act(() => {
    snapshots.commitProvidersSnapshot(snapshots.beginProvidersRefresh(), {
      dataOwnerId: null, ownerGeneration: getDataOwnerGeneration().generation, providers: next, providerOrder: next.map((item) => item.id),
    });
  });
  publish(providers(!options.empty, false));
  const store = await import('../botStore');
  void store.ensureBotProfilesLoaded();
  await waitFor(() => expect(getModelChainSettings).toHaveBeenCalledOnce());
  if (!options.pending) await waitFor(() => expect(list).toHaveBeenCalledOnce());
  // The global editor is retired. Keep exercising the real roster hook used
  // by teammate creation/settings and the retained default/override store.
  renderHook(() => useAvailableAgents());
  await waitFor(() => expect(listAvailableAgents).toHaveBeenCalledOnce());
  const agents = await import('@/hooks/useAvailableAgents');
  await waitFor(() => expect(agents.getCachedAvailableVendors()).toEqual(new Set(['pi', 'codex'])));
  return {
    store, publish, getModelChainSettings, setModelChainSettings, resetModelChainSettings, resolveSettings,
    changeAgents: async (next: ('pi' | 'codex')[]) => {
      listAvailableAgents.mockResolvedValue(next);
      await act(async () => { for (const listener of listeners) listener(); });
      await waitFor(() => expect(agents.getCachedAvailableVendors()).toEqual(new Set(next)));
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setDataOwnerGeneration(null);
  __resetAvailableAgentsCacheForTest();
});
afterEach(() => cleanup());

describe('live derived Bot defaults', () => {
  beforeEach(() => { visibility.enabled = true; visibility.version = 0; Object.assign(selection, gateway); });
  // Unit regression: removing the global editor must not drop coverage of
  // defaults, saved overrides, or stale hydration after provider/roster changes.
  // A provider connection change is the minimal input; assert the chain used
  // by teammate creation/restoration through the production store.
  it('ignores new-task selections in derived defaults and new teammate creation', async () => {
    const api = await setup();
    Object.assign(selection, { ...openai, effort: 'high', fastMode: true });
    api.publish(providers(true, false));
    expect(api.store.getEffectiveBotModelChain()).toEqual([gateway]);
    let bot!: Awaited<ReturnType<typeof api.store.addBotProfileAndWait>>;
    await act(async () => { bot = await api.store.addBotProfileAndWait({ name: 'Independent', description: '' }); });
    expect(bot.capabilities.modelChain).toEqual([gateway]);
    expect(bot.capabilities).toMatchObject({ effort: 'medium', fastMode: false, providerId: 'xd' });
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
  });

  it('expires a hydrated default after model toggles change without a catalog change', async () => {
    const api = await setup();
    visibility.enabled = false;
    visibility.version += 1;
    expect(api.store.getEffectiveBotModelChain()).toEqual([]);
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
  });

  it('updates derived defaults after a connection change and preserves a saved override', async () => {
    const api = await setup();
    expect(api.store.getEffectiveBotModelChain()).toEqual([gateway]);
    api.publish(providers(false, true));
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
    await act(async () => {
      await api.store.setBotGlobalModelChain(api.store.getEffectiveBotModelChain()
        .map((route) => ({ ...route, effort: 'high' })));
    });
    await waitFor(() => expect(api.setModelChainSettings).toHaveBeenCalledWith({
      modelChain: [{ ...openai, effort: 'high' }],
    }));
    api.publish(providers(true, false));
    expect(api.store.getEffectiveBotModelChain()).toEqual([{ ...openai, effort: 'high' }]);
  });

  it('recovers a hydrated empty chain after connecting and returns to empty after disconnecting', async () => {
    const api = await setup({ empty: true });
    expect(api.store.getEffectiveBotModelChain()).toEqual([]);
    api.publish(providers(false, true));
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
    api.publish(providers(false, false));
    expect(api.store.getEffectiveBotModelChain()).toEqual([]);
  });

  it('recomputes defaults when engines are removed or installed without a provider update', async () => {
    const api = await setup();
    api.publish(providers(true, true));
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
    await api.changeAgents(['codex']);
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
    await api.changeAgents([]);
    expect(api.store.getEffectiveBotModelChain()).toEqual([]);
    await api.changeAgents(['pi', 'codex']);
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
  });

  it('preserves a hydrated explicit global override across provider and engine changes', async () => {
    const api = await setup({ customized: true });
    Object.assign(selection, openai);
    api.publish(providers(false, true));
    await api.changeAgents(['codex']);
    expect(api.store.getEffectiveBotModelChain()).toEqual([gateway]);
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
  });

  it('does not revive an obsolete default when its hydration response arrives after a source change', async () => {
    const api = await setup({ pending: true });
    api.publish(providers(false, true));
    await act(async () => api.resolveSettings({ modelChain: [gateway], isCustomized: false }));
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
  });

  it('keeps restored defaults live when sources change while reset is pending', async () => {
    const api = await setup({ customized: true });
    let finishReset!: (state: { modelChain: BotModelRoute[]; isCustomized: boolean }) => void;
    api.resetModelChainSettings.mockImplementationOnce(() => new Promise((resolve) => { finishReset = resolve; }));
    let reset!: Promise<void>;
    await act(async () => { reset = api.store.resetBotGlobalModelChain(); });
    expect(api.resetModelChainSettings).toHaveBeenCalledOnce();
    api.publish(providers(false, true));
    await act(async () => {
      finishReset({ modelChain: [gateway], isCustomized: false });
      await reset;
    });
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
    expect(api.store.isBotGlobalModelChainCustomized()).toBe(false);
    api.publish(providers(false, false));
    expect(api.store.getEffectiveBotModelChain()).toEqual([]);
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
  });

  it('also expires the derived settings cached by profile creation', async () => {
    const api = await setup();
    await act(async () => { await api.store.addBotProfileAndWait({ name: 'Helper', description: '' }); });
    expect(api.getModelChainSettings).toHaveBeenCalledTimes(2);
    api.publish(providers(false, true));
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
  });
});
