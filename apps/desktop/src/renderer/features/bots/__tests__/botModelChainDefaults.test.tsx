// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { BotModelRoute } from '../../../../shared/botModelChain';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/localCatalogSnapshot', () => ({ refreshLocalCatalogSnapshot: vi.fn() }));
vi.mock('@/hooks/useAgentCapabilities', () => ({
  refreshLocalCapabilities: vi.fn(async () => {}),
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({ migrateModelVisibilityDefaults: vi.fn() }));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({ lastByVendor: { pi: {}, cc: {}, codex: {} } }),
  getPersistedVendorModel: () => '',
}));
vi.mock('@/lib/modelDefinitions', () => ({
  getDefaultModelForVendor: () => ({ id: '', defaultEffort: 'medium' }),
}));
vi.mock('../BotModelChainEditor', () => ({
  BotModelChainEditor: ({ value, onChange }: {
    value: BotModelRoute[];
    onChange: (value: BotModelRoute[]) => void;
  }) => (
    <div>
      <output data-testid="chain">{JSON.stringify(value)}</output>
      <button onClick={() => onChange(value.map((route) => ({ ...route, effort: 'high' })))}>
        Change effort
      </button>
    </div>
  ),
}));

const gateway: BotModelRoute = {
  harness: 'pi', providerId: 'xd', model: 'z-ai/glm-5.3-flash', effort: 'medium', fastMode: false,
};
const openai: BotModelRoute = {
  harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: false,
};

function providers(gatewayConnected: boolean, openaiConnected: boolean): ProviderView[] {
  return [gateway, openai].map((route, index) => ({
    id: route.providerId,
    name: route.providerId,
    source: 'builtin',
    connected: index === 0 ? gatewayConnected : openaiConnected,
    agents: [route.harness],
    access: index === 0 ? { kind: 'managed' } : { kind: 'subscription', product: 'openai' },
    models: { [route.harness]: [{
      id: route.model, name: route.model, status: 'active', sortOrder: 0,
      contextWindow: 200_000, efforts: ['medium', 'high'], defaultEffort: 'medium',
      supportsFastMode: false, newSessionDefault: [route.harness], supportsImageInput: true,
    }] },
  })) as unknown as ProviderView[];
}

function shownChain(): BotModelRoute[] {
  return JSON.parse(screen.getByTestId('chain').textContent ?? '[]');
}

async function setup(options: { customized?: boolean; empty?: boolean; pending?: boolean } = {}) {
  const listeners = new Set<() => void>();
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
      dataOwnerId: null, ownerGeneration: 0, providers: next, providerOrder: next.map((item) => item.id),
    });
  });
  publish(providers(!options.empty, false));
  const store = await import('../botStore');
  await waitFor(() => expect(getModelChainSettings).toHaveBeenCalledOnce());
  if (!options.pending) await waitFor(() => expect(list).toHaveBeenCalledOnce());
  const { BotsGlobalSettingsSection } = await import('../BotsGlobalSettingsSection');
  render(<BotsGlobalSettingsSection />);
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

beforeEach(() => { vi.resetModules(); window.localStorage.clear(); });
afterEach(() => cleanup());

describe('live derived Bot defaults', () => {
  it('updates the mounted global editor after a connection change and saves effort on the new route', async () => {
    const api = await setup();
    expect(shownChain()).toEqual([gateway]);
    api.publish(providers(false, true));
    expect(shownChain()).toEqual([openai]);
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]); // Restore-default consumer.
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Change effort'));
    await waitFor(() => expect(api.setModelChainSettings).toHaveBeenCalledWith({
      modelChain: [{ ...openai, effort: 'high' }],
    }));
    api.publish(providers(true, false));
    expect(shownChain()).toEqual([{ ...openai, effort: 'high' }]);
  });

  it('recovers a hydrated empty chain after connecting and returns to empty after disconnecting', async () => {
    const api = await setup({ empty: true });
    expect(shownChain()).toEqual([]);
    api.publish(providers(false, true));
    expect(shownChain()).toEqual([openai]);
    api.publish(providers(false, false));
    expect(shownChain()).toEqual([]);
  });

  it('recomputes defaults when engines are removed or installed without a provider update', async () => {
    const api = await setup();
    api.publish(providers(true, true));
    expect(shownChain()).toEqual([gateway, openai]);
    await api.changeAgents(['codex']);
    expect(shownChain()).toEqual([openai]);
    await api.changeAgents([]);
    expect(shownChain()).toEqual([]);
    await api.changeAgents(['pi', 'codex']);
    expect(shownChain()).toEqual([gateway, openai]);
  });

  it('preserves a hydrated explicit global override across provider and engine changes', async () => {
    const api = await setup({ customized: true });
    api.publish(providers(false, true));
    await api.changeAgents(['codex']);
    expect(shownChain()).toEqual([gateway]);
    expect(api.store.getEffectiveBotModelChain()).toEqual([gateway]);
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
  });

  it('does not revive an obsolete default when its hydration response arrives after a source change', async () => {
    const api = await setup({ pending: true });
    api.publish(providers(false, true));
    await act(async () => api.resolveSettings({ modelChain: [gateway], isCustomized: false }));
    expect(shownChain()).toEqual([openai]);
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
    expect(shownChain()).toEqual([openai]);
    expect(api.store.isBotGlobalModelChainCustomized()).toBe(false);
    api.publish(providers(false, false));
    expect(shownChain()).toEqual([]);
    expect(api.setModelChainSettings).not.toHaveBeenCalled();
  });

  it('also expires the derived settings cached by profile creation', async () => {
    const api = await setup();
    await act(async () => { await api.store.addBotProfileAndWait({ name: 'Helper', description: '' }); });
    expect(api.getModelChainSettings).toHaveBeenCalledTimes(2);
    api.publish(providers(false, true));
    expect(api.store.getEffectiveBotModelChain()).toEqual([openai]);
    expect(shownChain()).toEqual([openai]);
  });
});
