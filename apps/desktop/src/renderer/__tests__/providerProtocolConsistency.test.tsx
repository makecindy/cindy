// @vitest-environment jsdom
// Regression coverage: real form, serialization, provider projection and drawer.
// IPC is replaced with an in-memory store; no real credentials or network calls.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, modelProtocolComparison } from '@cindy/model-providers';
import type { AgentKind, CustomProviderConfig, ProviderRuntimeModelConfig, ProviderView } from '@cindy/model-providers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' },
}) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/useModelContextLimit', () => ({ useModelContextLimit: () => ({
  limit: null, isCustomized: false, loading: false, error: false, setLimit: vi.fn(), reset: vi.fn(),
}) }));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  useModelVisibilityVersion: () => 0, isModelEnabled: () => true,
  isModelVisibilityCustomized: () => false, setModelVisibility: vi.fn(), resetModelVisibilities: vi.fn(),
}));
vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0, getProviderModelEffort: () => undefined,
  setProviderModelEffort: vi.fn(), clearProviderModelEffort: vi.fn(),
}));
vi.mock('@/components/settings/ModelPriceOverrideDialog', () => ({ ModelPriceOverrideDialog: () => null }));

import { ProviderConnectionDialog } from '@/components/settings/ProviderConnectionDialog';
import { ModelAdvancedDrawer } from '@/components/settings/ModelAdvancedDrawer';
import { providerViewToCustomProviderConfig } from '@/lib/customProviders';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('issue #6015: saved connection protocol versus model protocol', () => {
  it('also distinguishes a mixed-protocol catalog default from a stored user override', () => {
    const config: CustomProviderConfig = {
      id: 'issue-6015-catalog', name: 'Catalog-only diagnostic fixture',
      runtimes: { codex: {
        baseUrl: 'https://api.individual.githubcopilot.com', wireProtocol: 'openai-chat',
        models: [{ id: 'gpt-5-mini', name: 'GPT-5 mini' }],
      } },
    };
    const projected = buildUserProvider(config);
    const model = projected.models.codex![0]!;
    expect(model.userModelConfig?.api).toBeUndefined();
    expect(model.userModelConfig?.route).toBeUndefined();
    expect(modelProtocolComparison(projected, { codex: model }).forAgent('codex')?.outbound)
      .toBe('openai-responses');
    expect(model.route?.wireProtocol).toBe('openai-responses');
  });

  it.each([
    { name: 'no model override', extra: {}, expectedApi: 'openai-completions', label: 'Chat Completions' },
    { name: 'model API override', extra: { api: 'openai-responses' }, expectedApi: 'openai-responses', label: 'Responses' },
    { name: 'model route override', extra: { route: { baseUrl: 'http://127.0.0.1:4000/v1', wireProtocol: 'openai-responses' } }, expectedApi: 'openai-responses', label: 'Responses' },
  ] as const)('$name', async ({ name, extra, expectedApi, label }) => {
    let saved: CustomProviderConfig = {
      id: 'issue-6015', name: 'Issue 6015 diagnostic fixture', auth: { method: 'none' },
      runtimes: { codex: {
        baseUrl: 'http://127.0.0.1:4000/v1', wireProtocol: 'openai-responses',
        models: [{ id: 'fixture-model', name: 'Fixture model', contextWindow: 32768, ...extra } as ProviderRuntimeModelConfig],
      } },
    };
    const originalModel = structuredClone(saved.runtimes.codex!.models[0]);
    const previousAPI = window.electronAPI;
    const update = vi.fn(async (config: CustomProviderConfig) => {
      saved = structuredClone(config);
      return { ok: true };
    });
    const probe = vi.fn();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      safeStorageRead: vi.fn(async () => null),
      maker: { updateCustomProvider: update, listProviderPresets: vi.fn(async () => ({ presets: [] })),
        fetchProviderModels: probe, testCustomProvider: probe },
    } });
    try {
      const source = { ...buildUserProvider(saved), connected: true } as ProviderView;
      const dialog = render(<ProviderConnectionDialog
        initial={providerViewToCustomProviderConfig(source)} focusAgent="codex"
        onSaved={vi.fn()} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.advanced.label' }));
      const chat = screen.getByRole('button', { name: 'settings.providers.custom.wireProtocol.chat' });
      expect(screen.getByText('settings.providers.custom.wireProtocol.defaultLabel')).toBeTruthy();
      expect(screen.getByText('settings.providers.custom.wireProtocol.precedenceHelp')).toBeTruthy();
      fireEvent.click(chat);
      expect(chat.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      expect(saved.runtimes.codex!.wireProtocol).toBe('openai-chat');
      expect(saved.runtimes.codex!.models[0]).toMatchObject(originalModel!);
      // Simulate the main process rebuilding the provider snapshot after Save.
      const refreshed = { ...buildUserProvider(saved), connected: true } as ProviderView;
      const model = refreshed.models.codex![0]!;
      const protocol = modelProtocolComparison(refreshed, { codex: model }).forAgent('codex');
      expect(protocol?.outbound).toBe(expectedApi);
      expect(protocol?.harness).toBe('openai-responses');
      dialog.unmount();
      const reopened = render(<ProviderConnectionDialog
        initial={providerViewToCustomProviderConfig(refreshed)} focusAgent="codex"
        onSaved={vi.fn()} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.advanced.label' }));
      expect(screen.getByRole('button', { name: 'settings.providers.custom.wireProtocol.chat' })
        .getAttribute('aria-pressed')).toBe('true');
      reopened.unmount();
      render(<ModelAdvancedDrawer provider={refreshed}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open onOpenChange={vi.fn()} pricePresentationOf={() => null}
        onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
      expect(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }).textContent)
        .toContain(label);
      expect(screen.getByText(`settings.providers.models.advanced.protocol.source${name === 'no model override' ? 'Connection' : 'Model'}`)).toBeTruthy();
      if (name !== 'no model override') {
        fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.providers.models.advanced.protocol.restoreRoute' }));
        await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
        const restored = saved.runtimes.codex!.models[0]!;
        expect(restored.api).toBeUndefined();
        expect(restored.route).toBeUndefined();
        expect(restored.id).toBe(originalModel!.id);
        expect(restored.contextWindow).toBe(32768);
        const afterReset = buildUserProvider(saved);
        expect(modelProtocolComparison(afterReset, { codex: afterReset.models.codex![0]! }).forAgent('codex'))
          .toMatchObject({ outbound: 'openai-completions', source: 'connection' });
      }
      expect(probe).not.toHaveBeenCalled();
    } finally {
      cleanup();
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: previousAPI });
    }
  });
});


it.each([false, true])('shows catalog provenance for a read-only preset (legacy Chat snapshot: %s)', legacy => {
  const preset = BUNDLED_CATALOG.presets!.find(item => item.id === 'opencode-go')!;
  const provider = { ...buildUserProvider({ id: 'preset-fixture', name: 'Preset fixture', runtimes: { pi: {
    ...structuredClone(preset.runtimes.pi!), catalogPresetId: preset.id,
    ...(legacy ? { baseUrl: 'https://opencode.ai/zen/go/v1', wireProtocol: 'openai-chat' as const,
      models: [{ id: 'qwen3.7-plus', name: 'Qwen', api: 'openai-completions' as const }] } : {}),
  } } }, { presets: BUNDLED_CATALOG.presets }), connected: true } as ProviderView;
  const model = provider.models.pi!.find(item => item.userModelConfig?.api || item.userModelConfig?.piApi)!;
  render(<ModelAdvancedDrawer provider={provider}
    row={{ id: model.id, name: model.name, avail: ['pi'], byAgent: { pi: model } }}
    open onOpenChange={vi.fn()} pricePresentationOf={() => null}
    onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
  expect(screen.getByText('settings.providers.models.advanced.protocol.sourceCatalog')).toBeTruthy();
  expect(screen.queryByText('settings.providers.models.advanced.protocol.sourceModel')).toBeNull();
});

it.each([
  { name: 'Pi piApi and custom route', agent: 'pi', baseUrl: 'https://supplier.example.test/v1', modelId: 'fixture-model', expected: 'openai-completions', source: 'connection' },
  { name: 'Codex custom request path', agent: 'codex', baseUrl: 'https://supplier.example.test/v1', modelId: 'fixture-model', expected: 'openai-completions', source: 'connection' },
  { name: 'Codex mixed-protocol catalog', agent: 'codex', baseUrl: 'https://api.individual.githubcopilot.com', modelId: 'gpt-5-mini', expected: 'openai-responses', source: 'catalog' },
] as const)('restores protocol and complete route: $name', async ({ agent, baseUrl, modelId, expected, source }) => {
  const engine: AgentKind = agent;
  let saved: CustomProviderConfig = { id: 'restore-fixture', name: 'Restore fixture', runtimes: { [engine]: {
    baseUrl, wireProtocol: 'openai-chat', models: [{ id: modelId, name: 'Fixture', contextWindow: 32768,
      api: 'anthropic-messages', piApi: 'anthropic-messages',
      route: { baseUrl: 'https://custom.example.test', wireProtocol: 'anthropic-messages', requestPath: '/custom/messages' },
    }],
  } } };
  const original = structuredClone(saved.runtimes[engine]!.models[0]!);
  const previousAPI = window.electronAPI;
  const update = vi.fn(async (value: CustomProviderConfig) => { saved = structuredClone(value); return { ok: true }; });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
  function renderDrawer() {
    const provider = { ...buildUserProvider(saved), connected: true } as ProviderView;
    const model = provider.models[engine]![0]!;
    return render(<ModelAdvancedDrawer provider={provider}
      row={{ id: model.id, name: model.name, avail: [engine], byAgent: { [engine]: model } }}
      open onOpenChange={vi.fn()} pricePresentationOf={() => null}
      onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
  }
  try {
    const view = renderDrawer();
    const button = screen.getByRole('button', { name: `${engine === 'pi' ? 'Pi' : 'Codex'} · settings.providers.custom.fields.wireProtocol` });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.providers.models.advanced.protocol.restoreRoute' }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    const unchanged = { ...original };
    delete unchanged.api;
    delete unchanged.piApi;
    delete unchanged.route;
    expect(saved.runtimes[engine]!.models[0]).toEqual(unchanged);
    const restored = buildUserProvider(saved);
    expect(modelProtocolComparison(restored, { [engine]: restored.models[engine]![0]! }).forAgent(engine))
      .toMatchObject({ outbound: expected, source, customized: false });
    view.unmount();
    renderDrawer();
    expect(screen.getByText(`settings.providers.models.advanced.protocol.source${source === 'catalog' ? 'Catalog' : 'Connection'}`)).toBeTruthy();
  } finally {
    cleanup();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: previousAPI });
  }
});


// Main's V6 interface picker and #6015's reset/source labels must agree after merging.
it.each([
  { interfaceId: 'auto', source: 'catalog', api: 'openai-responses' },
  { interfaceId: 'moonshot-kimi-code-openai-completions', source: 'model', api: 'openai-completions' },
  { interfaceId: 'moonshot-kimi-code-openai-responses', source: 'model', api: 'openai-responses' },
] as const)('keeps V6 interface intent and reset provenance: $interfaceId', async ({ interfaceId, source, api }) => {
  let saved: CustomProviderConfig = { id: 'interface-fixture', name: 'Interface fixture', runtimes: {
    codex: { catalogPresetId: 'moonshot-kimi-code', baseUrl: 'https://api.kimi.com/coding/v1', wireProtocol: 'openai-chat',
      models: [{ id: 'k3.1-pro', name: 'K3.1', interfaceId, contextWindow: 32768 }, { id: 'other', name: 'Other' }] },
    pi: { baseUrl: 'https://other.example.test/v1', wireProtocol: 'openai-chat', models: [{ id: 'other', name: 'Other' }] },
  } };
  const before = structuredClone(saved);
  const previousAPI = window.electronAPI;
  const update = vi.fn(async (value: CustomProviderConfig) => { saved = structuredClone(value); return { ok: true }; });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
  try {
    const provider = { ...buildUserProvider(saved), connected: true } as ProviderView;
    const model = provider.models.codex![0]!;
    expect(modelProtocolComparison(provider, { codex: model }).forAgent('codex'))
      .toMatchObject({ outbound: api, source, customized: source === 'model' });
    render(<ModelAdvancedDrawer provider={provider}
      row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
      open onOpenChange={vi.fn()} pricePresentationOf={() => null}
      onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
    const restore = await screen.findByRole('menuitem', { name: 'settings.providers.models.advanced.protocol.restoreRoute' });
    if (source === 'catalog') {
      expect(restore.getAttribute('aria-disabled')).toBe('true');
      expect(update).not.toHaveBeenCalled();
      return;
    }
    fireEvent.click(restore);
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    const expected = structuredClone(before);
    delete expected.runtimes.codex!.models[0]!.interfaceId;
    expect(saved).toEqual(expected);
    const restored = buildUserProvider(saved);
    expect(modelProtocolComparison(restored, { codex: restored.models.codex![0]! }).forAgent('codex'))
      .toMatchObject({ outbound: 'openai-responses', source: 'catalog', customized: false });
  } finally {
    cleanup();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: previousAPI });
  }
});
