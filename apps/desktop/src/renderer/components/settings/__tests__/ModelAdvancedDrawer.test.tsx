// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, resolveModelMetadata } from '@cindy/model-providers';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

const mocks = vi.hoisted(() => ({
  setLimit: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  target: vi.fn(),
  imageTarget: vi.fn(),
  imageSet: vi.fn(async () => {}),
  limit: null as number | null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.tokens ? `${key} ${values.tokens}` : key,
    i18n: { resolvedLanguage: 'en' },
  }),
}));
vi.mock('@/hooks/useModelContextLimit', () => ({
  useModelContextLimit: (target: unknown) => {
    mocks.target(target);
    return {
      limit: mocks.limit,
      isCustomized: mocks.limit !== null,
      loading: false,
      error: false,
      setLimit: mocks.setLimit,
      reset: mocks.reset,
    };
  },
}));
vi.mock('@/hooks/useModelImageInputOverride', () => ({
  useModelImageInputOverride: (target: unknown) => {
    mocks.imageTarget(target);
    return { value: null, mixed: false, loading: false, error: false, setValue: mocks.imageSet };
  },
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  useModelVisibilityVersion: () => 0,
  isModelEnabled: (_agent: unknown, _provider: unknown, model: { defaultEnabled?: boolean }) => model.defaultEnabled !== false,
  isModelVisibilityCustomized: () => false,
  setModelVisibility: vi.fn(),
  resetModelVisibilities: vi.fn(),
}));
vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0,
  getProviderModelEffort: vi.fn(() => undefined),
  setProviderModelEffort: vi.fn(),
  clearProviderModelEffort: vi.fn(),
}));
vi.mock('../ModelPriceOverrideDialog', () => ({ ModelPriceOverrideDialog: () => null }));
import { ModelAdvancedDrawer } from '../ModelAdvancedDrawer';
import { setModelVisibility } from '@/state/modelVisibilityPrefs';
import { setProviderModelEffort, getProviderModelEffort, clearProviderModelEffort } from '@/state/providerModelMemory';
import { modelPricePresentation } from '@/lib/modelPriceFormat';

const model: CatalogModel = {
  id: 'gpt-6',
  name: 'GPT-6',
  contextWindow: 272_000,
  contextWindowMax: 1_050_000,
  maxOutput: 128_000,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  modalities: { input: ['text', 'image'], output: ['text'] },
};
const provider = {
  id: 'openai',
  name: 'OpenAI',
  source: 'builtin',
  connected: true,
  agents: ['codex', 'claude-code'],
  models: {},
} as ProviderView;
function drawer(primary = model, bridgeDefault = primary.defaultEffort, bridgeEfforts = primary.efforts, source = provider) {
  const row = {
    id: primary.id,
    name: primary.name,
    avail: ['codex', 'claude-code'] as ('codex' | 'claude-code')[],
    byAgent: {
      codex: primary,
      'claude-code': { ...primary, id: `chatgpt/${primary.id}`, defaultEffort: bridgeDefault, efforts: bridgeEfforts },
    },
  };
  return (
    <ModelAdvancedDrawer
      provider={source}
      row={row}
      open
      onOpenChange={vi.fn()}
      pricePresentationOf={() => null}
      onDisable={vi.fn()}
      disabled={false}
      paymentRequired={false}
    />
  );
}
function draw(primary = model, bridgeDefault = primary.defaultEffort) {
  return render(drawer(primary, bridgeDefault));
}
const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' } as const;
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit = null;
  vi.mocked(getProviderModelEffort).mockReset();
});

describe('model advanced editor', () => {
  // Regression: the details editor must save the Codex-only Ultra intent,
  // adapting other engines instead of reducing the whole row to their maximum.
  it.each(['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra'])('saves Ultra from the %s details panel', (id) => {
    const metadata = resolveModelMetadata(BUNDLED_CATALOG.modelRegistry, 'openai', id, undefined, undefined, 'codex');
    const primary = { ...model, id, efforts: metadata.efforts!, defaultEffort: 'medium' as const };
    render(drawer(primary, 'medium', ['low', 'medium', 'high', 'xhigh', 'max']));
    fireEvent.click(screen.getByRole('radio', { name: 'effortLevels.ultra' }));
    expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', id, 'ultra');
    expect(setProviderModelEffort).toHaveBeenCalledWith('claude-code', 'openai', `chatgpt/${id}`, 'max');
  });

  it.each([
    [true, 'supported'], [false, 'unsupported'], [undefined, 'undeclared'],
  ] as const)('shows account Ultrafast capability %s independently of Fast', (supported, label) => {
    draw({ ...model, supportsFastMode: true, supportsUltrafastMode: supported });
    expect(screen.getByText('newChat.modelSelector.speed.ultrafast').parentElement?.textContent)
      .toContain(`settings.providers.models.advanced.${label}`);
  });

  it('does not infer Ultrafast support from a non-Codex engine', () => {
    render(<ModelAdvancedDrawer
      provider={{ ...provider, agents: ['pi'] }}
      row={{ id: model.id, name: model.name, avail: ['pi'],
        byAgent: { pi: { ...model, supportsFastMode: true, supportsUltrafastMode: true } } }}
      open onOpenChange={vi.fn()} pricePresentationOf={() => null}
      onDisable={vi.fn()} disabled={false} paymentRequired={false}
    />);
    expect(screen.getByText('newChat.modelSelector.speed.ultrafast').parentElement?.textContent)
      .toContain('settings.providers.models.advanced.unsupported');
  });

  it.each(['generate', 'edit', 'default'] as const)('saves image capability %s only on the explicit Images connection', async (value) => {
    const update = vi.fn(async (...args: unknown[]) => {
      void args;
      return { ok: true };
    });
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
    const source = { ...buildUserProvider({ id: 'relay', name: 'Relay', auth: { method: 'apiKey' }, runtimes: {
      pi: { baseUrl: 'https://chat.example.invalid/v1', models: [{ id: 'private-image', name: 'Image' }] },
      codex: { baseUrl: 'https://images.example.invalid/v1', imageApi: 'openai-images', models: [{
        id: 'private-image', name: 'Image', discoveredMetadata: value === 'default'
          ? { mode: 'image_generation', modalities: { input: ['text'], output: ['image'] } }
          : { contextWindow: 32768 },
        ...(value === 'default' ? { mode: 'image_generation' as const, modalities: { input: ['text', 'image'] as ('text' | 'image')[], output: ['image'] as 'image'[] } } : {}),
      }] },
    } }), connected: true } as ProviderView;
    try {
      if (value !== 'default') expect(source.imageModels).toBeUndefined();
      render(<ModelAdvancedDrawer provider={source} row={{ id: 'private-image', name: 'Image', avail: ['pi', 'codex'], byAgent: { pi: source.models.pi![0], codex: source.models.codex![0] } }} open
        onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
      fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.models.advanced.imageCapability.label' }), { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('menuitemradio', { name: `settings.providers.models.advanced.imageCapability.${value}` }));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      const config = update.mock.calls[0]![0] as Parameters<typeof buildUserProvider>[0];
      const saved = config.runtimes.codex!.models[0]!;
      expect(config.runtimes.pi!.models).toEqual([{ id: 'private-image', name: 'Image' }]);
      expect(saved.discoveredMetadata).toEqual(source.models.codex![0]!.discoveredMetadata);
      if (value === 'default') {
        expect(saved.mode).toBeUndefined();
        expect(saved.modalities).toBeUndefined();
      } else {
        expect(saved.mode).toBe('image_generation');
        expect(saved.modalities).toEqual({ input: value === 'edit' ? ['text', 'image'] : ['text'], output: ['image'] });
      }
      const active = buildUserProvider(config);
      expect(active.imageModels?.[0]?.sourceAgent).toBe('codex');
      expect(active.imageModels?.[0]?.modalities?.input).toEqual(value === 'edit' ? ['text', 'image'] : ['text']);
      expect(update.mock.calls[0]![1]).toEqual({});
    } finally { Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });
  it.each(['generate', 'edit', 'default'] as const)('saves video capability %s only on the explicit video connection', async (value) => {
    const update = vi.fn(async (...args: unknown[]) => {
      void args;
      return { ok: true };
    });
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
    const source = { ...buildUserProvider({ id: 'relay', name: 'Relay', auth: { method: 'apiKey' }, runtimes: {
      pi: { baseUrl: 'https://chat.example.invalid/v1', models: [{ id: 'private-video', name: 'Image' }] },
      codex: { baseUrl: 'https://images.example.invalid/v1', videoApi: 'xai-videos', models: [{
        id: 'private-video', name: 'Image', discoveredMetadata: value === 'default'
          ? { mode: 'video_generation', modalities: { input: ['text'], output: ['video'] } }
          : { contextWindow: 32768 },
        ...(value === 'default' ? { mode: 'video_generation' as const, modalities: { input: ['text', 'image'] as ('text' | 'image')[], output: ['video'] as 'video'[] } } : {}),
      }] },
    } }), connected: true } as ProviderView;
    try {
      if (value !== 'default') expect(source.videoModels).toBeUndefined();
      render(<ModelAdvancedDrawer provider={source} row={{ id: 'private-video', name: 'Image', avail: ['pi', 'codex'], byAgent: { pi: source.models.pi![0], codex: source.models.codex![0] } }} open
        onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
      fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.models.advanced.videoCapability.label' }), { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('menuitemradio', { name: `settings.providers.models.advanced.videoCapability.${value}` }));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      const config = update.mock.calls[0]![0] as Parameters<typeof buildUserProvider>[0];
      const saved = config.runtimes.codex!.models[0]!;
      expect(config.runtimes.pi!.models).toEqual([{ id: 'private-video', name: 'Image' }]);
      expect(saved.discoveredMetadata).toEqual(source.models.codex![0]!.discoveredMetadata);
      if (value === 'default') {
        expect(saved.mode).toBeUndefined();
        expect(saved.modalities).toBeUndefined();
      } else {
        expect(saved.mode).toBe('video_generation');
        expect(saved.modalities).toEqual({ input: value === 'edit' ? ['text', 'image'] : ['text'], output: ['video'] });
      }
      const active = buildUserProvider(config);
      expect(active.videoModels?.[0]?.sourceAgent).toBe('codex');
      expect(active.videoModels?.[0]?.modalities?.input).toEqual(value === 'edit' ? ['text', 'image'] : ['text']);
      expect(update.mock.calls[0]![1]).toEqual({});
    } finally { Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });

  it('rejects ordinary managed GGUF edits above the backend maximum', async () => {
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
      llamaCppStatus: vi.fn(async () => ({ canConfigure: true, models: [{ id: 'small', repo: 'owner/small' }] })),
    } } });
    try {
      const source = { ...buildUserProvider({ id: 'cindy-local-llamacpp', name: 'llama.cpp', runtimes: {
        pi: { baseUrl: 'http://127.0.0.1:11435/v1', wireProtocol: 'openai-chat', models: [{ id: 'small', name: 'Small', contextWindow: 32768 }] },
      } }), connected: true } as ProviderView;
      const primary = source.models.pi![0]!;
      render(<ModelAdvancedDrawer provider={source} row={{ id: primary.id, name: primary.name, avail: ['pi'], byAgent: { pi: primary } }} open onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
      const input = screen.getByRole('textbox', { name: 'settings.providers.models.advanced.contextLimitAria' });
      await waitFor(() => expect(window.electronAPI.maker.llamaCppStatus).toHaveBeenCalled());
      fireEvent.change(input, { target: { value: '64K' } });
      expect(input.getAttribute('aria-invalid')).toBe('true');
      fireEvent.blur(input);
      expect(mocks.setLimit).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: '32K' } });
      fireEvent.blur(input);
      expect(mocks.setLimit).toHaveBeenLastCalledWith(32000);
    } finally { cleanup(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });
  it.each([true, false])('gates local context configuration with capability %s', async (canConfigure) => {
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
      llamaCppStatus: vi.fn(async () => ({ canConfigure, models: [{ id: 'flash', repo: 'bartowski/Qwen3.8-Flash-Next-GGUF' }] })),
    } } });
    try {
      const source = { ...buildUserProvider({ id: 'cindy-local-llamacpp', name: 'llama.cpp', runtimes: {
        pi: { baseUrl: 'http://127.0.0.1:11435/v1', wireProtocol: 'openai-chat', models: [{ id: 'flash', name: 'Flash', contextWindow: 262144 }] },
      } }), connected: true } as ProviderView;
      const primary = source.models.pi![0]!;
      render(<ModelAdvancedDrawer provider={source} row={{ id: primary.id, name: primary.name, avail: ['pi'], byAgent: { pi: primary } }} open onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
      const million = await screen.findByRole('button', { name: '1M' });
      if (!canConfigure) {
        expect((million as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText('settings.providers.llamacpp.ownedElsewhere')).toBeTruthy();
        fireEvent.click(million);
        expect(mocks.setLimit).not.toHaveBeenCalled();
        return;
      }
      fireEvent.click(million);
      expect(mocks.setLimit).toHaveBeenLastCalledWith(1_000_000);
      fireEvent.click(screen.getByRole('button', { name: '256K' }));
      expect(mocks.setLimit).toHaveBeenLastCalledWith(262144);
      expect(screen.queryByRole('button', { name: 'Pi · settings.providers.custom.fields.wireProtocol' })).toBeNull();
    } finally {
      cleanup();
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous });
    }
  });
  it('shows the imported API as a label rather than offering unrelated supplier transports', () => {
    const source = { ...buildUserProvider({ id: 'nous-test', name: 'Hermes', runtimes: {
      pi: { catalogPresetId: 'nous', baseUrl: 'https://inference-api.nousresearch.com/v1', wireProtocol: 'openai-chat', models: [{ id: 'gpt-6', name: 'GPT-6' }] },
    } }), connected: true } as ProviderView;
    const primary = source.models.pi![0];
    render(<ModelAdvancedDrawer provider={source} row={{ id: primary.id, name: primary.name, avail: ['pi'], byAgent: { pi: primary } }} open onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
    expect(screen.queryByRole('button', { name: 'Pi · settings.providers.custom.fields.wireProtocol' })).toBeNull();
    expect(document.getElementById(screen.getByRole('switch', { name: 'GPT-6 · Pi' }).getAttribute('aria-describedby')!)?.textContent)
      .toBe('Chat Completionssettings.providers.models.advanced.protocol.sourceConnection');
  });

  it('saves protocol selection to the selected engine and model without writing derived model limits', async () => {
    const update = vi.fn(async (...args: unknown[]) => {
      void args;
      return { ok: true };
    });
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
    const source = { ...buildUserProvider({ id: 'fixture', name: 'Fixture', runtimes: {
      codex: { baseUrl: 'https://supplier.example/v1', wireProtocol: 'openai-responses', requestPath: '/custom/chat',
        models: [{ id: 'gpt-6', name: 'GPT-6', route: { baseUrl: 'https://supplier.example/v1', wireProtocol: 'openai-responses', requestPath: '/custom/chat' } }, { id: 'other', name: 'Other' }] },
    } }), connected: true } as ProviderView;
    try {
      render(drawer(source.models.codex![0], 'high', ['high'], source));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
      await screen.findByRole('menuitemradio', { name: 'Chat Completions' });
      expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['Messages', 'Responses', 'Chat Completions', 'Google Gemini']);
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Chat Completions' }));
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      const config = update.mock.calls[0]![0] as unknown as { runtimes: { codex: { models: Array<Record<string, unknown>> } } };
      expect(config.runtimes.codex.models[0]).toEqual({ id: 'gpt-6', name: 'GPT-6', api: 'openai-completions',
        route: { baseUrl: 'https://supplier.example/v1', wireProtocol: 'openai-chat' } });
      expect(config.runtimes.codex.models[1]).toEqual({ id: 'other', name: 'Other' });
    } finally { Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });

  // V6 selection is a user intent, not a copy of today's resolved route/limits. Presets hide the
  // menu, but a choice saved before keeps its way back to automatic.
  it.each(['auto', 'moonshot-kimi-code-openai-responses'])('lets a saved Kimi interface choice change to %s without locking catalog defaults', async (interfaceId) => {
    const update = vi.fn(async (...args: unknown[]) => {
      void args;
      return { ok: true };
    });
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
    const source = { ...buildUserProvider({ id: 'kimi-user', name: 'Kimi', runtimes: {
      codex: { catalogPresetId: 'moonshot-kimi-code', baseUrl: 'https://api.kimi.com/coding/v1', wireProtocol: 'openai-chat',
        models: [{ id: 'k3.1-pro', name: 'K3.1', interfaceId: 'moonshot-kimi-code-openai-completions' }] },
    } }), connected: true } as ProviderView;
    try {
      render(drawer(source.models.codex![0], 'high', ['high'], source));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('menuitemradio', { name: interfaceId === 'auto' ? 'settings.providers.models.advanced.protocol.automatic' : 'Responses' }));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      const config = update.mock.calls[0]![0] as Parameters<typeof buildUserProvider>[0];
      expect(config.runtimes.codex!.models).toEqual([{ id: 'k3.1-pro', name: 'K3.1', interfaceId }]);
      expect(buildUserProvider(config).models.codex![0].selectedInterface?.api).toBe('openai-responses');
    } finally { Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });

  // Older explicit choices stored only api/route; presets must still offer the way back to automatic.
  it('lets a legacy api/route-only preset choice return to automatic', async () => {
    const update = vi.fn(async (...args: unknown[]) => {
      void args;
      return { ok: true };
    });
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
    const source = { ...buildUserProvider({ id: 'kimi-user', name: 'Kimi', runtimes: {
      codex: { catalogPresetId: 'moonshot-kimi-code', baseUrl: 'https://api.kimi.com/coding/v1', wireProtocol: 'openai-chat',
        models: [{ id: 'k3.1-pro', name: 'K3.1', api: 'openai-completions',
          route: { baseUrl: 'https://api.kimi.com/coding/v1', wireProtocol: 'openai-chat' } }] },
    } }), connected: true } as ProviderView;
    try {
      render(drawer(source.models.codex![0], 'high', ['high'], source));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'settings.providers.models.advanced.protocol.automatic' }));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      const config = update.mock.calls[0]![0] as Parameters<typeof buildUserProvider>[0];
      expect(config.runtimes.codex!.models).toEqual([{ id: 'k3.1-pro', name: 'K3.1', interfaceId: 'auto' }]);
    } finally { Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });

  it('saves Google selection with its matching wire and official endpoint', async () => {
    const update = vi.fn(async (...args: unknown[]) => {
      void args;
      return { ok: true };
    });
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
    const source = { ...buildUserProvider({ id: 'fixture', name: 'Fixture', runtimes: {
      codex: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', wireProtocol: 'openai-chat',
        models: [{ id: 'new-gemini', name: 'New Gemini' }, { id: 'other', name: 'Other' }] },
    } }), connected: true } as ProviderView;
    try {
      render(drawer(source.models.codex![0], 'high', ['high'], source));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Google Gemini' }));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      const config = update.mock.calls[0]![0] as { runtimes: { codex: { models: unknown[] } } };
      expect(config.runtimes.codex.models).toEqual([
        { id: 'new-gemini', name: 'New Gemini', api: 'google-generative-ai', route: {
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireProtocol: 'google-generative-ai',
        } }, { id: 'other', name: 'Other' },
      ]);
    } finally { Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });

  it('rejects new small settings but accepts 100K without rewriting existing small overrides', () => {
    mocks.limit = 1_000;
    draw();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1000');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '2K' } });
    fireEvent.blur(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '99K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '100K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(100_000);
    fireEvent.change(input, { target: { value: '1K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
  });

  it.each(['cindy-local-ollama', 'ollama', 'cindy-local-lmstudio'])('keeps %s editable at 1K even when the catalog advertises a large window', (id) => {
    render(drawer(model, model.defaultEffort, model.efforts, { ...provider, id, source: 'user' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '4K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(4_000);
    fireEvent.change(input, { target: { value: '1K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(1_000);
  });

  it.each([2_048, 4_096, 8_192, 32_768])('keeps a small model with %s native tokens editable below 100K', (window) => {
    draw({ ...model, contextWindow: window, contextWindowMax: window });
    const input = screen.getByRole('textbox');
    const floor = Math.floor(window / 1000);
    fireEvent.change(input, { target: { value: `${floor - 1}K` } });
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: `${floor}K` } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(floor * 1000);
  });


  it('keeps useful identity fields without exposing internal defaults, normal lifecycle or raw descriptions', () => {
    draw({ ...model, status: 'active', defaultEnabled: false, description: 'GPT for coding tasks' });
    expect(screen.queryByText('active')).toBeNull();
    expect(screen.queryByText('GPT for coding tasks')).toBeNull();
    expect(screen.queryByText('settings.providers.models.advanced.defaultEnabled')).toBeNull();
    expect(screen.getByText('settings.providers.models.advanced.modelId')).toBeTruthy();
  });

  it.each(['alpha', 'deprecated', 'retired'] as const)('localizes the actionable model status %s', (status) => {
    draw({ ...model, status });
    expect(screen.queryByText(status)).toBeNull();
    expect(screen.getByText(`settings.providers.models.advanced.lifecycle.${status}`)).toBeTruthy();
  });

  it('preserves selected harnesses while disconnected, and restores controls after reconnect', () => {
    const view = render(
      <ModelAdvancedDrawer
        provider={{ ...provider, connected: false }}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'GPT-6 · Codex' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(setModelVisibility).not.toHaveBeenCalled();
    expect(screen.getByText('settings.providers.models.manage.connectionRequired')).toBeTruthy();
    view.rerender(drawer());
    expect(
      (screen.getByRole('switch', { name: 'GPT-6 · Codex' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText('settings.providers.models.manage.connectionRequired')).toBeNull();
    expect(screen.getByRole('switch', { name: 'GPT-6 · Codex' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(setModelVisibility).not.toHaveBeenCalled();
  });

  it('shows the exact maximum and includes Codex in shared context edits', () => {
    draw();
    expect(screen.getByText('1,050,000')).toBeTruthy();
    const input = screen.getByRole('textbox', {
      name: 'settings.providers.models.advanced.contextLimitAria',
    });
    expect((input as HTMLInputElement).value).toBe('272000');
    fireEvent.change(input, { target: { value: '500K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(500_000);
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.target).toHaveBeenLastCalledWith({
      providerId: 'openai',
      agent: 'codex',
      modelId: 'gpt-6',
      relatedTargets: [{ providerId: 'openai', agent: 'claude-code', modelId: 'chatgpt/gpt-6' }],
    });
  });

  it('edits a Codex-only route without removing the model specification', () => {
    render(
      <ModelAdvancedDrawer
        provider={provider}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '1000K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
    expect(screen.getByText('1,050,000')).toBeTruthy();
    expect(screen.queryByText('settings.providers.models.advanced.codexContextHint')).toBeNull();
  });

  it('uses the same context editor for custom Codex providers', () => {
    render(
      <ModelAdvancedDrawer
        provider={{ ...provider, id: 'custom', source: 'user' }}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '1000K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
    expect(screen.getAllByText('272K').length).toBeGreaterThan(0);
    expect(screen.queryByText('settings.providers.models.advanced.codexContextHint')).toBeNull();
  });

  it('omits an undeclared manufacturer reference instead of presenting it as broken setup', () => {
    render(drawer({ ...model, nativeApi: undefined }, undefined, undefined, { ...provider, id: 'unknown-provider', source: 'user' }));
    expect(screen.queryByText('settings.providers.models.advanced.protocol.reference')).toBeNull();
  });

  it('renders imported OpenRouter Gemini with every served engine enabled and no interface menu', () => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'openrouter')!;
    const agents = ['claude-code', 'codex', 'pi'] as const;
    const id = 'google/gemini-3.8-flash';
    const source = { ...buildUserProvider({ id: 'openrouter-test', name: 'OpenRouter', runtimes: Object.fromEntries(
      agents.map(agent => [agent, { ...preset.runtimes[agent]!, catalogPresetId: preset.id, models: [{ id, name: 'Gemini' }] }]),
    ) }, { presets: BUNDLED_CATALOG.presets, modelRegistry: BUNDLED_CATALOG.modelRegistry }), connected: true } as ProviderView;
    const byAgent = Object.fromEntries(agents.map(agent => [agent, source.models[agent]![0]]));
    render(<ModelAdvancedDrawer provider={source} row={{ id, name: 'Gemini', avail: [...agents], byAgent }} open
      onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
    for (const [agent, api] of [['Claude Code', 'Messages'], ['Codex', 'Responses'], ['Pi', 'Chat Completions']]) {
      const toggle = screen.getByRole('switch', { name: `Gemini · ${agent}` });
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(toggle.hasAttribute('data-compatibility')).toBe(false);
      expect(document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent)
        .toBe(`${api}settings.providers.models.advanced.protocol.sourceCatalog`);
    }
    expect(screen.getByText('Messages · Responses · Chat Completions')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /settings\.providers\.custom\.fields\.wireProtocol/ })).toBeNull();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('1048576');
  });

  it('shows exact tokens without rewriting the catalog value on untouched blur', () => {
    draw({ ...model, contextWindow: 1_048_576, contextWindowMax: 1_048_576 });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1048576');
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitRoute 1,048,576'),
    ).toBeTruthy();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1000K' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
  });

  it('lists Cindy AI Gemini interfaces without compatibility labels and gives Pi the recommendation', () => {
    const primary = {
      ...model,
      id: 'google/gemini-future',
      name: 'Gemini',
      nativeApi: 'google-generative-ai' as const,
    };
    const byAgent = {
      'claude-code': primary,
      codex: primary,
      pi: { ...primary, piApi: 'google-generative-ai' as const },
    };
    const agents = ['claude-code', 'codex', 'pi'] as const;
    render(
      <ModelAdvancedDrawer
        provider={{
          ...provider,
          id: 'xd',
          agents: [...agents],
          models: Object.fromEntries(agents.map((agent) => [agent, [byAgent[agent]]])),
          routing: {
            'claude-code': { wireProtocol: 'anthropic-messages' },
            codex: { wireProtocol: 'openai-responses' },
          } as ProviderView['routing'],
        }}
        row={{ id: primary.id, name: primary.name, avail: [...agents], byAgent }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    expect(
      screen.getByText('newChat.modelSelector.unified.recommended').parentElement?.textContent,
    ).toContain('Pi');
    // The gateway serves each engine's own interface; that is not Cindy's local conversion.
    for (const agent of agents) {
      expect(screen.getByRole('switch', { name: `Gemini · ${AGENT_NAMES[agent]}` }).hasAttribute('data-compatibility')).toBe(false);
    }
    expect(screen.getByText('Messages · Responses · Google Gemini')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.advanced.protocol.compatibility' })).toBeNull();
    expect(setModelVisibility).not.toHaveBeenCalled();
  });

  it('labels only the engine Cindy converts locally and explains it on demand', async () => {
    const source = { ...buildUserProvider({ id: 'chat-only', name: 'Chat Only', runtimes: {
      'claude-code': { baseUrl: 'https://supplier.example/v1', wireProtocol: 'openai-chat', models: [{ id: 'chat-model', name: 'Chat Model' }] },
      pi: { baseUrl: 'https://supplier.example/v1', wireProtocol: 'openai-chat', models: [{ id: 'chat-model', name: 'Chat Model' }] },
    } }), connected: true } as ProviderView;
    const byAgent = { 'claude-code': source.models['claude-code']![0], pi: source.models.pi![0] };
    render(<ModelAdvancedDrawer provider={source} row={{ id: 'chat-model', name: 'Chat Model', avail: ['claude-code', 'pi'], byAgent }} open
      onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
    const claude = screen.getByRole('switch', { name: 'Chat Model · Claude Code' });
    expect(claude.getAttribute('data-compatibility')).toBe('true');
    expect(document.getElementById(claude.getAttribute('aria-describedby')!)?.textContent).toContain('protocol.compatibility');
    expect(screen.getByRole('switch', { name: 'Chat Model · Pi' }).hasAttribute('data-compatibility')).toBe(false);
    const notices = screen.getAllByRole('button', { name: 'settings.providers.models.advanced.protocol.compatibility' });
    expect(notices).toHaveLength(1);
    fireEvent.click(notices[0]!);
    expect((await screen.findByRole('tooltip')).textContent).toContain('protocol.compatibilityHint');
  });

  it('preserves an existing precise override, warns above the exact maximum, and resets without rounding writes', () => {
    mocks.limit = 1_048_900;
    draw({ ...model, contextWindow: 1_048_576, contextWindowMax: 1_048_576 });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1048900');
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitOverWindow'),
    ).toBeTruthy();
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.providers.models.advanced.restoreDefault' }),
    );
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.setLimit).not.toHaveBeenCalled();
  });

  it('shows facts beside controls without disclosure and keeps related window values together', () => {
    draw();
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('details')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'GPT-6' }));
    const input = screen.getByRole('textbox');
    const controlsColumn = input.closest('section')!.parentElement!;
    expect(controlsColumn.textContent).toContain(
      'settings.providers.models.advanced.contextWindow',
    );
    expect(screen.getByText('settings.providers.models.advanced.imageInput')).toBeTruthy();
    expect(screen.getByText('settings.providers.models.advanced.modelId')).toBeTruthy();
    const scrollArea = input.closest('.overflow-y-auto')!;
    expect(
      scrollArea.contains(
        screen.getByRole('button', { name: 'settings.providers.models.disableModel' }),
      ),
    ).toBe(false);
    const close = screen.getByRole('button', { name: 'settings.providers.models.advanced.close' });
    fireEvent.focus(close);
    expect(close.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it.each([
    ['anthropic-claude/claude-opus-4-8', ['claude-code', 'codex', 'pi'], 'Claude Code'],
    ['new-vendor/gpt-9', ['claude-code', 'codex', 'pi'], 'Codex'],
    ['new-labs/next-model', ['pi'], 'Pi'],
  ] as const)('uses the shared recommendation for %s', (id, agents, expected) => {
    const primary = { ...model, id, name: id };
    const models = Object.fromEntries(agents.map((agent) => [agent, [primary]]));
    render(
      <ModelAdvancedDrawer
        provider={{ ...provider, id: 'xd', agents: [...agents], models }}
        row={{
          id,
          name: id,
          avail: [...agents],
          byAgent: Object.fromEntries(agents.map((agent) => [agent, primary])),
        }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const marker = screen.getByText('newChat.modelSelector.unified.recommended');
    expect(marker.parentElement?.textContent).toContain(expected);
  });

  it('refreshes defaults and controls in an open drawer when the catalog changes', () => {
    const { rerender } = draw();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('272000');
    rerender(
      drawer({ ...model, contextWindow: 700_000, efforts: ['high', 'max'], defaultEffort: 'max' }),
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('700000');
    expect(screen.queryByRole('radio', { name: 'effortLevels.low' })).toBeNull();
    expect(
      screen.getByRole('radio', { name: 'effortLevels.max' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('allows an intentional override above the maximum and rejects invalid input', () => {
    draw();
    const input = screen.getByRole('textbox', {
      name: 'settings.providers.models.advanced.contextLimitAria',
    });
    fireEvent.change(input, { target: { value: '1200K' } });
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitOverWindow'),
    ).toBeTruthy();
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(1_200_000);
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the saved primary effort when another harness has a different default', () => {
    vi.mocked(getProviderModelEffort).mockImplementation((agent) => agent === 'codex' ? 'max' : undefined);
    draw({ ...model, efforts: ['low', 'high', 'max'], defaultEffort: 'low' }, 'low');

    expect(screen.getByRole('radio', { name: 'effortLevels.max' }).getAttribute('aria-checked'))
      .toBe('true');
  });

  it('retains a mixed saved selection without showing per-engine default labels', () => {
    draw(model, 'low');
    expect(screen.getByText('settings.providers.models.advanced.effortMixed')).toBeTruthy();
    expect(
      screen.queryByText(/settings.providers.models.advanced.engineDefaultEffort/),
    ).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'effortLevels.high' }));
    expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', 'gpt-6', 'high');
    expect(setProviderModelEffort).toHaveBeenCalledWith('claude-code', 'openai', 'chatgpt/gpt-6', 'high');
  });

  it('shows one selected depth when another harness needs a supported-level mapping', () => {
    render(drawer(model, 'low', ['low']));
    expect(screen.queryByText('settings.providers.models.advanced.effortMixed')).toBeNull();
    expect(screen.getByRole('radio', { name: 'effortLevels.high' }).getAttribute('aria-checked'))
      .toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'effortLevels.high' }));
    expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', 'gpt-6', 'high');
    expect(setProviderModelEffort).toHaveBeenCalledWith('claude-code', 'openai', 'chatgpt/gpt-6', 'low');
  });

  it('uses provider-declared image capability ahead of family-name heuristics', () => {
    draw({ ...model, id: 'deepseek-v4', name: 'DeepSeek', supportsImageInput: true });
    expect(screen.getByText('settings.providers.models.advanced.vision.vision')).toBeTruthy();
    expect(screen.getByText('settings.providers.models.advanced.inputModalities')).toBeTruthy();
  });
});


it('shows closed Gateway tiers disabled and re-enables them on catalog refresh', () => {
  const restricted: CatalogModel = {
    ...model, efforts: ['high'], defaultEffort: 'high', displayEfforts: ['low', 'high', 'max'],
  };
  const view = render(drawer(restricted));
  const low = screen.getByRole('radio', { name: 'effortLevels.low' }) as HTMLButtonElement;
  expect(low.disabled).toBe(true);
  fireEvent.click(low);
  expect(setProviderModelEffort).not.toHaveBeenCalled();
  view.rerender(drawer({ ...restricted, efforts: ['low', 'high'] }));
  const enabledLow = screen.getByRole('radio', { name: 'effortLevels.low' }) as HTMLButtonElement;
  expect(enabledLow.disabled).toBe(false);
  fireEvent.click(enabledLow);
  expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', model.id, 'low');
  expect((screen.getByRole('radio', { name: 'effortLevels.max' }) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps the tier row visible when Gateway closes every tier', () => {
  draw({ ...model, efforts: [], defaultEffort: null, displayEfforts: ['low', 'high'] });
  for (const effort of ['low', 'high']) {
    const button = screen.getByRole('radio', { name: `effortLevels.${effort}` }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-checked')).toBe('false');
  }
});


it('describes an absent Harness route as unconfigured rather than unsupported', () => {
  render(<ModelAdvancedDrawer provider={{ ...provider, agents: ['codex', 'claude-code', 'pi'] }}
    row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
    open onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()}
    disabled={false} paymentRequired={false} />);
  expect(screen.getByRole('button', { name: 'Pi · settings.providers.models.advanced.engineNotConfigured' })).toBeTruthy();
  expect(screen.queryByLabelText(/engineUnsupported/)).toBeNull();
});

it('limits context and effort reads, writes and resets to the chat runtime', () => {
  vi.mocked(getProviderModelEffort).mockImplementation((agent) => agent === 'codex' ? 'high' : 'low');
  const mixedProvider = { ...provider, id: 'private', source: 'user' as const };
  const row = {
    id: 'shared', name: 'Shared', avail: ['claude-code', 'codex'] as const,
    byAgent: {
      'claude-code': { ...model, id: 'shared', mode: 'image_generation', efforts: ['low'] as typeof model.efforts },
      codex: { ...model, id: 'shared', mode: 'chat' },
    },
  };
  render(<ModelAdvancedDrawer provider={mixedProvider} row={{ ...row, avail: [...row.avail] }} open onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
  expect(mocks.target).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'codex', relatedTargets: [] }));
  expect(screen.queryByText('settings.providers.models.advanced.effortMixed')).toBeNull();
  expect(vi.mocked(getProviderModelEffort).mock.calls.every(([agent]) => agent === 'codex')).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: 'effortLevels.low' }));
  expect(setProviderModelEffort).toHaveBeenCalledExactlyOnceWith('codex', 'private', 'shared', 'low');
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.advanced.restoreDefault' }));
  expect(clearProviderModelEffort).toHaveBeenCalledExactlyOnceWith('codex', 'private', 'shared');
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '128K' } });
  fireEvent.blur(input);
  expect(mocks.setLimit).toHaveBeenCalledWith(128_000);
  expect(mocks.target).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'codex', relatedTargets: [] }));
});
it('keeps enterprise reference prices read-only in the model drawer', () => {
  render(
    drawer(model, model.defaultEffort, model.efforts, {
      ...provider,
      id: 'byok-example',
      source: 'organization',
    }),
  );
  expect(
    screen.queryByRole('button', { name: 'settings.providers.models.priceOverride.menu' }),
  ).toBeNull();
});

// Component contract (unit): the real drawer names the charge, independently of its token unit.
// Existing cases only name directions; one image quote and mixed/uncategorized variants cover fallback.
it.each([
  { components: ['image'], label: 'newChat.modelSelector.displayPricing.roles.image.output', prefixes: [] },
  { components: ['image', 'image'], label: 'newChat.modelSelector.displayPricing.roles.image.output', prefixes: [] },
  { components: [undefined], label: 'settings.providers.models.advanced.price.output', prefixes: [] },
  { components: ['future_kind'], label: 'settings.providers.models.advanced.price.output', prefixes: [] },
  { components: ['text', 'image'], label: 'settings.providers.models.advanced.price.output', prefixes: ['text', 'image'] },
  { components: ['image', undefined], label: 'settings.providers.models.advanced.price.output', prefixes: ['image'] },
])('labels primary quotes without inferring a category: $components', ({ components, label, prefixes }) => {
  draw({ ...model, currency: 'CNY', displayPricing: {
    items: [{ label: 'Custom fee', price: 1, unit: 'request', quantity: 1 }],
    summary: { output: components.map((component, index) => ({
      price: 840 + index, unit: 'token', quantity: 1000000, tier: index === 0 ? 'HD' : '4K', component,
    })) },
  } });
  const row = screen.getByText(label).parentElement!;
  expect(row.textContent).toContain('¥840');
  expect(row.textContent).toContain('HD');
  expect(row.textContent).not.toContain('future_kind');
  for (const component of ['text', 'image', 'audio', 'video']) {
    const prefix = `newChat.modelSelector.displayPricing.components.${component}`;
    expect(row.textContent?.includes(prefix)).toBe(prefixes.includes(component));
  }
});

// Unit contract: drawer summary must show translated roles while retaining supplier conditions below.
// Previous drawer tests had no displayPricing; one input quote previously showed only the English table.
it.each([{ hasSummary: true, withNotes: true }, { hasSummary: true, withNotes: false }, { hasSummary: false, withNotes: false }])('keeps supplementary items when they do not match the summary: %j', ({ hasSummary, withNotes }) => {
  const quote = { price: 0.02, unit: 'image', quantity: 1 };
  const summary = { input: [quote, { price: 140, unit: 'character', quantity: 1000000 }],
    output: [{ ...quote, price: 6, maxPrice: 10, tier: '480P/720P' }],
    cacheRead: [quote], cacheWrite: [quote] };
  draw({ ...model, currency: 'CNY', costDiscount: 0.2, displayPricing: {
    items: [{ ...quote, label: 'Supplier-specific charge' }], ...(withNotes ? { notes: ['Provider billing condition'] } : {}),
    ...(hasSummary ? { summary } : {}),
  } });
  expect(screen.getByText('Supplier-specific charge')).toBeTruthy();
  if (withNotes) expect(screen.getByText('Provider billing condition')).toBeTruthy();
  if (!hasSummary) {
    expect(screen.queryByText('settings.providers.models.advanced.price.input')).toBeNull();
    return;
  }
  const input = screen.getByText('settings.providers.models.advanced.price.input').parentElement!;
  expect(input.textContent).toContain('¥0.016');
  expect(input.textContent).not.toContain(' · ');
  expect(input.textContent).toContain('¥112');
  expect(input.querySelector('s')?.textContent).toBe('¥0.02');
  const output = screen.getByText('settings.providers.models.advanced.price.output').parentElement!;
  expect(screen.getByText('480P/720P')).toBeTruthy();
  expect(output.textContent).toContain('¥4.8–¥8');
  expect(output.querySelector('s')?.textContent).toBe('¥6–¥10');
  expect(screen.getByText('settings.providers.models.advanced.price.cacheRead')).toBeTruthy();
  expect(screen.getByText('settings.providers.models.advanced.price.cacheCreate')).toBeTruthy();
  expect(output.compareDocumentPosition(screen.getByText('Supplier-specific charge')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

// Unit: a plain speech table used to repeat the primary quote; notes must still keep the table visible.
it.each([false, true])('omits only a fully redundant supplementary table (notes=%s)', withNotes => {
  const quote = { price: 140, unit: 'character', quantity: 1000000 };
  draw({ ...model, currency: 'CNY', displayPricing: {
    items: [{ ...quote, label: 'Text input' }], summary: { input: [quote] },
    ...(withNotes ? { notes: ['Provider billing condition'] } : {}),
  } });
  expect(screen.getByText('settings.providers.models.advanced.price.input').parentElement!.textContent).toContain('¥140');
  expect(screen.queryByText('Text input') !== null).toBe(withNotes);
  expect(screen.queryByText('Provider billing condition') !== null).toBe(withNotes);
});

// Unit regression: the real drawer hid the discount row for displayPricing models.
// Existing summary tests checked discounted amounts but not the separate discount row.
// Minimal failure: one video quote with costDiscount=0.4 and no token price presentation.
// Discount-order regression: the row must follow summary quotes and precede supplementary items.
it.each([
  { costDiscount: 0.4, pricing: 'summary', expected: '↓40%' },
  { costDiscount: 0.4, pricing: 'table', expected: '↓40%' },
  { costDiscount: 0.4, pricing: 'chat', expected: '↓40%' },
  { costDiscount: 1, pricing: 'summary', expected: '↓100%' },
  ...[undefined, 0, -0.1, 1.1, NaN].map(costDiscount => ({ costDiscount, pricing: 'summary', expected: null })),
])('shows a discount row only for valid model discounts: %j', ({ costDiscount, pricing, expected }) => {
  const quote = { price: 0.05, maxPrice: 0.2, unit: 'second', quantity: 1 };
  draw({ ...model, currency: 'CNY', costDiscount,
    ...(pricing === 'chat' ? {} : { displayPricing: {
      items: [{ label: 'Generated video', price: 0.05, unit: 'second', quantity: 1 }],
      ...(pricing === 'summary' ? { summary: { output: [quote] } } : {}),
    } }),
  });
  const label = screen.queryByText('settings.providers.models.advanced.discount');
  if (expected) {
    expect(label?.parentElement?.textContent).toContain(expected);
    if (pricing !== 'chat') {
      expect(label!.compareDocumentPosition(screen.getByText('Generated video')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    if (pricing === 'summary') {
      const outputRow = screen.getByText('settings.providers.models.advanced.price.output').parentElement!;
      expect(outputRow.nextElementSibling).toBe(label!.parentElement);
    }
  } else expect(label).toBeNull();
});

// Unit regression found during review: ordinary Gateway chat projections carry effective cost,
// not costDiscount. Direct-field cases above cannot cover the existing inferred-discount path.
it('retains the chat discount inferred from standard and effective prices', () => {
  const primary = { ...model, cost: { input: 1.2, output: 6 } };
  render(<ModelAdvancedDrawer
    provider={{ ...provider, id: 'xd' }}
    row={{ id: primary.id, name: primary.name, avail: ['codex'], byAgent: { codex: primary } }}
    open onOpenChange={vi.fn()} onDisable={vi.fn()} disabled={false} paymentRequired={false}
    pricePresentationOf={() => modelPricePresentation({
      providerId: 'xd', modelId: primary.id, source: 'gateway', approximate: false,
      currency: 'CNY', inputPerMtok: 2, outputPerMtok: 10,
    }, primary.cost)}
  />);
  expect(screen.getByText('settings.providers.models.advanced.discount').parentElement?.textContent).toContain('↓40%');
  const outputRow = screen.getByText('settings.providers.models.advanced.price.output').parentElement!;
  expect(outputRow.nextElementSibling).toBe(screen.getByText('settings.providers.models.advanced.discount').parentElement);
});

// Unit: real editor commits normalized tokens, preserving precision and rejecting fractional tokens.
it.each([['1000000', 1_000_000], ['1M', 1_000_000], ['1.5m', 1_500_000], ['100万', 1_000_000], ['100萬', 1_000_000], ['262144', 262_144], ['1.000001M', 1_000_001], ['262.144K', 262_144]])('accepts context %s as %s tokens', (value, tokens) => {
  draw();
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
  expect(mocks.setLimit).toHaveBeenLastCalledWith(tokens);
});
// Review #7836: the bare-number rejection does not exercise unit precision.
// Unit tier: the real editor must show invalid input and never persist fractional tokens.
// Use the local-runtime 1K floor so the 1.0001K case cannot pass on the 100K guard alone.
it.each(['1.0001K', '1.0000001M', '1.00001万'])('rejects context %s that converts to fractional tokens', (value) => {
  render(drawer(model, model.defaultEffort, model.efforts, { ...provider, id: 'ollama', source: 'user' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value } });
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('settings.providers.models.advanced.contextInvalid')).toBeTruthy();
  fireEvent.blur(input);
  expect(mocks.setLimit).not.toHaveBeenCalled();
});
it('does not label an unverified working default as the upstream capacity', () => {
  draw({ ...model, contextWindow: 200_000, contextWindowMax: undefined, contextWindowVerified: false });
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '1M' } });
  expect(screen.queryByText('settings.providers.models.advanced.contextLimitOverWindow')).toBeNull();
  expect(screen.getByText('settings.providers.models.advanced.catalogMissing')).toBeTruthy();
  fireEvent.blur(input);
  expect(mocks.setLimit).toHaveBeenLastCalledWith(1_000_000);
});
