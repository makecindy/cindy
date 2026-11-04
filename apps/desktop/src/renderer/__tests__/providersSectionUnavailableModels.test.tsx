// @vitest-environment jsdom

/**
 * ProvidersSection(双栏重构)关键不变量:
 *   1. 首个可见供应商默认选中;Cindy AI 实时模型清单为空时仍保留手动刷新入口。
 *   2. 未连接的内置渠道不再常驻占行(入口在向导目录 + 检测建议)。
 *   3. 本机 CLI 检测命中且渠道未连接时,左栏出现建议行,点击直达向导授权步。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CustomProviderConfig, ModelRegistry, ProviderView } from '@cindy/model-providers';
import { createIpcError } from '../../shared/ipc-errors';
import { toast } from '@/lib/toast';

const {
  refreshBuiltinModelsSpy,
  requestAutoRefreshSpy,
  setProviderOrderSpy,
  refetchProvidersSpy,
  confirmSpy,
  authState,
  providerSnapshotState,
  wizardSpy,
} = vi.hoisted(() => ({
  refreshBuiltinModelsSpy: vi.fn(async () => ({ ok: true, providerId: 'xd' as const })),
  requestAutoRefreshSpy: vi.fn(async () => ({ ok: true as const })),
  setProviderOrderSpy: vi.fn(async () => ({ ok: true as const })),
  refetchProvidersSpy: vi.fn(),
  confirmSpy: vi.fn(async () => false),
  authState: { dataOwnerId: 'owner-1' as string | null },
  providerSnapshotState: {
    dataOwnerId: 'owner-1' as string | null,
    ownerGeneration: 1,
    order: ['anthropic', 'xd', 'custom'],
    customConnected: true,
    mediaReady: false,
    customOverride: null as ProviderView | null,
    loading: false,
    error: null as { reason: 'storage-quota' } | null,
  },
  wizardSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === 'settings.providers.models.manage.selected' ? `${key}:${options?.count}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => {
    const providers = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: {},
        models: {
          'claude-code': [
            {
              id: 'claude-sonnet-5',
              name: 'Sonnet 5',
              contextWindow: 200_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
        connected: false,
      } satisfies ProviderView,
      {
        id: 'xd',
        name: 'XD Gateway',
        source: 'builtin',
        agents: ['claude-code', 'codex'],
        auth: { method: 'managed' },
        routing: {},
        models: { 'claude-code': [], codex: [] },
        connected: false,
      } satisfies ProviderView,
      {
        id: 'custom',
        name: 'Custom',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {},
        models: {
          codex: [
            {
              id: 'custom-model',
              name: 'Custom model',
              contextWindow: 128_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
        connected: providerSnapshotState.customConnected,
        imageModels: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
        availableMediaModelIds: providerSnapshotState.mediaReady ? ['gpt-image-2'] : [],
      } satisfies ProviderView,
    ];
    const byId = new Map<string, ProviderView>(providers.map((provider) => [provider.id, provider]));
    if (providerSnapshotState.customOverride) {
      byId.delete('custom');
      byId.set(providerSnapshotState.customOverride.id, providerSnapshotState.customOverride);
    }
    return {
      providers:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId && !providerSnapshotState.loading ? [...byId.values()] : [],
      providerOrder:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId
          ? providerSnapshotState.order
          : [],
      ownerGeneration:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId
          ? providerSnapshotState.ownerGeneration
          : null,
      loading: providerSnapshotState.dataOwnerId !== authState.dataOwnerId || providerSnapshotState.loading,
      error: providerSnapshotState.error,
      refetch: refetchProvidersSpy,
    };
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    mode: 'cloud',
    dataOwnerId: authState.dataOwnerId,
    exitLocalMode: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: () => false,
  useCodexAuth: () => ({
    state: { kind: 'unauthenticated' },
    triggerLogin: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ key: '', hasSavedKey: false, clearKey: vi.fn() }),
}));

vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ state: 'failed', source: null, endpoint: null }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: confirmSpy }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/customProviders', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/customProviders')>(),
  deleteCustomProvider: vi.fn(),
  readCustomProviderKey: vi.fn(async () => null),
  updateCustomProvider: vi.fn(),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/lib/providerSubtitle', () => ({
  customProviderSubtitleForDisplay: () => '',
  providerSubtitleForDisplay: () => 'XD Gateway',
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  setModelVisibilities: vi.fn(),
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/ProviderConnectionDialog', () => ({
  ProviderConnectionDialog: () => null,
}));

vi.mock('@/components/settings/AddProviderWizard', () => ({
  AddProviderWizard: (props: { entry?: { kind: string; providerId: string } }) => {
    wizardSpy(props.entry);
    return React.createElement('div', { 'data-testid': 'wizard-stub' });
  },
}));

import { setModelVisibilities } from '@/state/modelVisibilityPrefs';
import { readCustomProviderKey, updateCustomProvider } from '@/lib/customProviders';
import { BUNDLED_CATALOG, buildUserProvider, providerPresetOAuth } from '@cindy/model-providers';

import { ProvidersSection } from '@/components/settings/ProvidersSection';

type ScanResult = { detections: unknown[] };
let scanResult: ScanResult;

beforeEach(() => {
  authState.dataOwnerId = 'owner-1';
  providerSnapshotState.dataOwnerId = 'owner-1';
  providerSnapshotState.ownerGeneration = 1;
  providerSnapshotState.customConnected = true;
  providerSnapshotState.mediaReady = false;
  providerSnapshotState.customOverride = null;
  providerSnapshotState.loading = false;
  providerSnapshotState.error = null;
  providerSnapshotState.order = ['anthropic', 'xd', 'custom'];
  scanResult = { detections: [] };
  confirmSpy.mockReset().mockResolvedValue(false);
  vi.mocked(updateCustomProvider).mockResolvedValue({ ok: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => scanResult),
      refreshBuiltinProviderModels: refreshBuiltinModelsSpy,
      requestProviderModelsAutoRefresh: requestAutoRefreshSpy,
      setProviderOrder: setProviderOrderSpy,
      onProviderOAuthProgress: vi.fn(() => () => {}),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — 双栏管理', () => {
  // Renderer unit: click the real provider refresh/menu, inspect the persisted
  // config and visible dialog. Earlier refresh cases only used chat-only proxies;
  // a MiniMax API connection with no speech is the minimal missing-default case.
  const miniMaxConfig = () => ({
    id: 'minimax-api', name: 'My MiniMax', runtimes: {
      codex: { baseUrl: 'https://api.minimax.io/v1', wireProtocol: 'openai-chat' as const,
        models: [{ id: 'MiniMax-M3', name: 'My chat', defaultEnabled: false }] },
    },
  });
  function selectSpeechProvider(
    config: CustomProviderConfig = miniMaxConfig(),
    modelRegistry = BUNDLED_CATALOG.modelRegistry,
  ) {
    const provider = buildUserProvider(config, { modelRegistry });
    providerSnapshotState.customOverride = { ...provider, connected: true,
      availableMediaModelIds: provider.audioModels?.map(model => model.id) ?? [] };
    providerSnapshotState.order = [provider.id, 'xd'];
  }
  it.each(['missing', 'discovered', 'hidden', 'explicit-other'] as const)(
    'manual refresh handles %s speech without changing saved switches', async kind => {
      const config = miniMaxConfig();
      if (kind === 'hidden') config.runtimes.codex.models.push({
        id: 'speech-2.8-hd', name: 'My hidden voice', defaultEnabled: false,
      });
      selectSpeechProvider(config);
      const discovered = kind === 'discovered'
        ? [{ id: 'new-voice', name: 'New voice', discoveredMetadata: { mode: 'audio_speech' as const } }]
        : kind === 'explicit-other'
          ? [{ id: 'speech-2.8-turbo', name: 'Not TTS', discoveredMetadata: { mode: 'other' as const } }]
          : [];
      window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true, models: [
        { id: 'MiniMax-M3', name: 'Upstream name' }, ...discovered,
      ] }));
      // Reference persistence is covered by the real Main handler tests. The
      // renderer must display Main's result and send only the discovery merge.
      if (kind === 'missing') vi.mocked(updateCustomProvider).mockResolvedValueOnce({
        ok: true, speechReferenceAdded: true,
      });
      const view = render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
      // Opening Settings only schedules discovery, never writes reference models.
      expect(updateCustomProvider).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.models.refreshAria' })); });
      const saved = vi.mocked(updateCustomProvider).mock.lastCall![0];
      expect(saved.name).toBe(config.name);
      expect(saved.runtimes.codex!.models.find(model => model.id === 'MiniMax-M3')).toMatchObject(config.runtimes.codex.models[0]);
      const speech = buildUserProvider(saved, { modelRegistry: BUNDLED_CATALOG.modelRegistry }).audioModels?.filter(model => model.mode === 'audio_speech') ?? [];
      expect(speech.map(model => model.id)).toEqual(kind === 'missing' ? []
        : kind === 'discovered' ? ['new-voice'] : kind === 'hidden' ? ['speech-2.8-hd'] : []);
      if (kind === 'hidden') expect(speech[0].defaultEnabled).toBe(false);
      expect(setModelVisibilities).not.toHaveBeenCalled();
      expect(vi.mocked(updateCustomProvider).mock.lastCall![2])
        .toEqual({ source: 'manual-settings', speechReferenceRefreshAgents: ['codex'] });
      if (kind === 'missing') {
        expect(toast.success).toHaveBeenLastCalledWith('settings.providers.models.refreshSpeechAdded');
        // A second click sees the saved reference; it does not add HD/other defaults.
        const persisted = structuredClone(saved);
        persisted.runtimes.codex!.models.push({ id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo', defaultEnabled: true });
        selectSpeechProvider(persisted);
        view.rerender(<MemoryRouter><ProvidersSection /></MemoryRouter>);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.refreshAria' })); });
        expect(vi.mocked(updateCustomProvider).mock.lastCall![0].runtimes.codex!.models.map(model => model.id))
          .toEqual(persisted.runtimes.codex!.models.map(model => model.id));
      }
    },
  );
  // #6928: a newly discovered ID has no pre-refresh projection or reported mode.
  // The active Registry must classify it before a reference can be persisted.
  it('does not append a reference beside newly discovered Server-only speech', async () => {
    const config = miniMaxConfig();
    const discovered = { id: 'server-only-new-speech', name: 'New speech' };
    const modelRegistry: ModelRegistry = {
      ...BUNDLED_CATALOG.modelRegistry!,
      baseModels: [...BUNDLED_CATALOG.modelRegistry!.baseModels!,
        { id: discovered.id, aliases: [], defaults: { mode: 'audio_speech' } }],
    };
    selectSpeechProvider(config, modelRegistry);
    window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true, models: [discovered] }));
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.models.refreshAria' })); });
    const saved = vi.mocked(updateCustomProvider).mock.lastCall![0];
    expect(vi.mocked(updateCustomProvider).mock.lastCall![2])
      .toEqual({ source: 'manual-settings', speechReferenceRefreshAgents: ['codex'] });
    expect(buildUserProvider(saved, { modelRegistry }).audioModels?.map(model => model.id))
      .toEqual([discovered.id]);
    expect(saved.runtimes.codex!.models.find(model => model.id === discovered.id)?.mode).toBeUndefined();
    expect(saved.runtimes.codex!.models.find(model => model.id === 'MiniMax-M3'))
      .toMatchObject(config.runtimes.codex.models[0]);
  });
  // Keep raw saved settings through refresh. Main's real handler regression
  // separately proves classification and reference persistence for these modes.
  it.each([
    ['codex', true, 'audio_speech'],
    ['codex', false, 'audio_speech'],
    ['pi', false, 'audio_speech'],
    ['codex', false, 'audio_transcription'],
  ] as const)('respects current Registry audio on %s (enabled=%s, mode=%s)', async (agent, defaultEnabled, mode) => {
    const config: CustomProviderConfig = miniMaxConfig();
    const savedAudio = { id: 'server-only-audio', name: 'My saved audio', defaultEnabled };
    const runtime = config.runtimes[agent] ??= { baseUrl: 'https://proxy.example/v1', models: [] };
    runtime.models.push(savedAudio);
    const modelRegistry: ModelRegistry = {
      schemaVersion: 5, updatedAt: '2026-10-23T00:00:00Z', models: [],
      baseModels: [{ id: savedAudio.id, aliases: [], defaults: { mode } }],
    };
    selectSpeechProvider(config, modelRegistry);
    expect(providerSnapshotState.customOverride!.audioModels).toEqual([
      expect.objectContaining({ id: savedAudio.id, mode, defaultEnabled, sourceAgent: agent }),
    ]);
    window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true, models: [] }));
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.models.refreshAria' })); });
    const saved = vi.mocked(updateCustomProvider).mock.lastCall![0];
    expect(saved.runtimes[agent]!.models.find(model => model.id === savedAudio.id)).toEqual(savedAudio);
    expect(saved.runtimes.codex!.models.some(model => model.id === 'speech-2.8-turbo'))
      .toBe(false);
    expect(buildUserProvider(saved, { modelRegistry }).audioModels)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: savedAudio.id, mode, defaultEnabled })]));
    expect(setModelVisibilities).not.toHaveBeenCalled();
  });
  it.each(['proxy', 'oauth', 'disabled-route'] as const)(
    'does not offer or auto-add speech for an unconfirmed %s connection', async kind => {
      const config = miniMaxConfig();
      if (kind === 'proxy') config.runtimes.codex.baseUrl = 'https://proxy.example/v1';
      selectSpeechProvider(config);
      if (kind === 'oauth') providerSnapshotState.customOverride!.auth = { method: 'oauth' };
      if (kind === 'disabled-route') providerSnapshotState.customOverride!.routing.codex!.disabled = true;
      window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true,
        models: [{ id: 'MiniMax-M3', name: 'Chat' }] }));
      render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
      expect(screen.queryByRole('button', { name: 'settings.providers.speechSetup.add' })).toBeNull();
      fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.models.manage.menu' }), { key: 'ArrowDown' });
      expect(screen.queryByRole('menuitem', { name: 'settings.providers.speechSetup.add' })).toBeNull();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.refreshAria' })); });
      const saved = vi.mocked(updateCustomProvider).mock.lastCall![0];
      expect(buildUserProvider(saved).audioModels ?? []).toEqual([]);
    },
  );
  it.each([0, 1])('moves manual speech additions into management with %s saved models', async count => {
    const config = miniMaxConfig();
    if (!count) config.runtimes.codex.models = [];
    selectSpeechProvider(config);
    window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: false }));
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'settings.providers.speechSetup.add' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.models.manage.menu' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.providers.speechSetup.add' }));
    expect(await screen.findByRole('dialog', { name: 'settings.providers.speechSetup.add' })).toBeTruthy();
    expect(await screen.findByRole('checkbox', { name: /speech-2.8-turbo/ })).toBeTruthy();
    expect(updateCustomProvider).not.toHaveBeenCalled();
  });
  // #6928 P2, renderer unit: the empty-connection case above never suspended
  // its provider. Exercise the real menu and next snapshot so the enable entry
  // cannot disappear along with the speech setup action.
  it('keeps an empty speech connection visible through suspend and resume', async () => {
    const config = miniMaxConfig();
    config.runtimes.codex.models = [];
    selectSpeechProvider(config);
    const setModelDisable = vi.fn<typeof window.electronAPI.maker.setModelDisable>(async input => {
      if (input.kind === 'provider')
        providerSnapshotState.customOverride = { ...providerSnapshotState.customOverride!, suspended: input.disabled };
      return { ok: true as const };
    });
    window.electronAPI.maker.setModelDisable = setModelDisable;
    const view = render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.detail.moreActionsAria' }), { key: 'ArrowDown' });
    await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.providers.menu.disableProvider' })); });
    expect(setModelDisable).toHaveBeenLastCalledWith({ kind: 'provider', providerId: config.id, disabled: true });
    view.rerender(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    expect(await screen.findByText('settings.providers.detail.suspendedBanner')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.refreshAria' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.manage.menu' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.providers.button.enableProvider' })); });
    expect(setModelDisable).toHaveBeenLastCalledWith({ kind: 'provider', providerId: config.id, disabled: false });
    view.rerender(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    expect(screen.queryByText('settings.providers.detail.suspendedBanner')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.models.manage.menu' }), { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: 'settings.providers.speechSetup.add' })).toBeTruthy();
    expect(updateCustomProvider).not.toHaveBeenCalled();
    expect(setModelVisibilities).not.toHaveBeenCalled();
  });
  it.each(['hidden-other-runtime', 'failed-target'] as const)(
    'does not supplement a reference across runtimes: %s', async kind => {
      const config: CustomProviderConfig = miniMaxConfig();
      config.runtimes.pi = { baseUrl: 'https://proxy.example/v1', models: [
        { id: 'my-speech', name: 'Saved name', mode: 'audio_speech',
          nativeApi: 'openai-audio-speech', defaultEnabled: false },
      ] };
      if (kind === 'failed-target') config.runtimes.pi.models = [{ id: 'my-chat', name: 'My chat' }];
      selectSpeechProvider(config);
      window.electronAPI.maker.fetchProviderModels = vi.fn(async request => (
        kind === 'failed-target' && request.agent === 'codex' ? { ok: false, status: 401 }
          : { ok: true, models: [{ id: 'another-chat', name: 'Another chat' }] }
      ));
      render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
      await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.models.refreshAria' })); });
      const saved = vi.mocked(updateCustomProvider).mock.lastCall![0];
      expect(saved.runtimes.codex!.models.some(model => model.id === 'speech-2.8-turbo')).toBe(false);
      expect(saved.runtimes.pi!.models).toEqual(expect.arrayContaining(config.runtimes.pi.models));
      expect(vi.mocked(updateCustomProvider).mock.lastCall![2])
        .toEqual({ source: 'manual-settings', speechReferenceRefreshAgents: kind === 'failed-target' ? ['pi'] : ['codex', 'pi'] });
      expect(setModelVisibilities).not.toHaveBeenCalled();
    },
  );
  it('keeps speech additions out of native subscription management', async () => {
    selectSpeechProvider();
    providerSnapshotState.customOverride = { ...providerSnapshotState.customOverride!,
      id: 'openai', source: 'builtin', auth: { method: 'oauth', native: 'codex' }, routing: {} };
    providerSnapshotState.order = ['openai', 'xd'];
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'settings.providers.speechSetup.add' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.models.manage.menu' }), { key: 'ArrowDown' });
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'settings.providers.speechSetup.add' })).toBeNull();
    expect(updateCustomProvider).not.toHaveBeenCalled();
  });
  it.each([401, 500])('does not add references when discovery fails with HTTP %s', async status => {
    selectSpeechProvider();
    window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: false, status }));
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.models.refreshAria' })); });
    expect(updateCustomProvider).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('settings.providers.models.refreshFailed');
    expect(toast.success).not.toHaveBeenCalled();
  });
  // #6928 P1, renderer unit: real refresh -> existing confirmation -> save/retry.
  // Earlier chat-only cases did not protect a busy Responses image Host from
  // a speech-only addition. Cancel must stay silent; retry must retain discovery
  // options and use the final save result, even if Main no longer adds a model.
  it.each(['cancel', 'interrupt', 'idle', 'no-add-on-retry'] as const)(
    'confirms speech refresh Host changes: %s', async action => {
      const config: CustomProviderConfig = { id: 'openai-api', name: 'My OpenAI', runtimes: {
        codex: { baseUrl: 'https://api.openai.com/v1', wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [{ id: 'chat-model', name: 'My chat', defaultEnabled: false }] },
      } };
      selectSpeechProvider(config);
      window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true,
        models: [{ id: 'chat-model', name: 'Upstream chat' }] }));
      if (action !== 'idle') vi.mocked(updateCustomProvider).mockResolvedValueOnce({ ok: false,
        confirmationRequired: 'codex-image-generation-reload', busyCount: 1 });
      vi.mocked(updateCustomProvider).mockResolvedValue({ ok: true,
        ...(action !== 'no-add-on-retry' ? { speechReferenceAdded: true } : {}) });
      confirmSpy.mockResolvedValue(action !== 'cancel');
      render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
      await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.models.refreshAria' })); });
      const saved = vi.mocked(updateCustomProvider).mock.calls[0][0];
      expect(saved.runtimes.codex!.models[0]).toMatchObject(config.runtimes.codex!.models[0]);
      expect(updateCustomProvider).toHaveBeenNthCalledWith(1, saved, {}, {
        source: 'manual-settings', speechReferenceRefreshAgents: ['codex'],
      });
      expect(confirmSpy).toHaveBeenCalledTimes(action === 'idle' ? 0 : 1);
      if (action !== 'idle') expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
        title: 'settings.providers.custom.imageGenerationReload.title',
        confirmText: 'settings.providers.custom.imageGenerationReload.interrupt',
        cancelText: 'settings.providers.custom.imageGenerationReload.cancel',
      }));
      expect(updateCustomProvider).toHaveBeenCalledTimes(action === 'cancel' || action === 'idle' ? 1 : 2);
      if (action === 'interrupt' || action === 'no-add-on-retry') {
        expect(updateCustomProvider).toHaveBeenNthCalledWith(2, saved, {}, {
          source: 'manual-settings', codexImageGenerationRestartPolicy: 'interrupt',
          speechReferenceRefreshAgents: ['codex'],
        });
      }
      expect(toast.error).not.toHaveBeenCalled();
      if (action === 'cancel') {
        expect(toast.success).not.toHaveBeenCalled();
        expect(refetchProvidersSpy).not.toHaveBeenCalled();
      } else {
        expect(toast.success).toHaveBeenCalledWith(action === 'no-add-on-retry'
          ? 'settings.providers.models.refreshNoNew' : 'settings.providers.models.refreshSpeechAdded');
        expect(refetchProvidersSpy).toHaveBeenCalledOnce();
      }
      expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'settings.providers.models.refreshAria' }).hasAttribute('disabled')).toBe(false);
    },
  );
  it('keeps a recovery action accessible when the first complete catalog could not be published', async () => {
    providerSnapshotState.loading = true;
    providerSnapshotState.error = { reason: 'storage-quota' };
    refetchProvidersSpy.mockResolvedValue(true);
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    expect(screen.getByRole('status').textContent).toContain('catalogRecovery.quota');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.catalogRecovery.retry' }));
    });
    expect(refetchProvidersSpy).toHaveBeenCalledOnce();
    expect(screen.queryByRole('switch', { name: 'Custom model' })).toBeNull();
  });

  it.each([
    ['openrouter-existing', 'oauth', true],
    ['openrouter-new', 'oauth', false],
    ['openrouter-reconnected', 'oauth', true],
    ['openrouter-retry', 'oauth', true],
    ['openrouter-key', 'apiKey', true],
    ['nous-existing', 'oauth', true],
  ] as const)('%s can refresh models using its saved %s connection (existing models: %s)', async (id, method, hasModels) => {
    const isNous = id.startsWith('nous');
    const oauth = providerPresetOAuth(isNous ? 'nous' : 'openrouter')!;
    const baseUrl = isNous ? 'https://inference-api.nousresearch.com/v1' : 'https://openrouter.ai/api/v1';
    providerSnapshotState.customOverride = {
      id, name: id, source: 'user', agents: ['codex'], connected: true,
      auth: method === 'oauth' ? { method, oauth } : { method },
      routing: { codex: { upstream: baseUrl, modelsUrl: `${baseUrl}/models`, authStrategy: method === 'oauth' ? 'oauth-token' : 'api-key-header' } },
      models: { codex: hasModels ? [{ id: 'old-model', name: 'Old', contextWindow: 64000, efforts: [], defaultEffort: null, defaultEnabled: false }] : [] },
    };
    providerSnapshotState.order = [id, 'xd'];
    const fetchModels = vi.fn(async () => ({ ok: true, models: [
      { id: 'old-model', name: 'Old' },
      { id: 'new-model', name: 'New', discoveredMetadata: { nativeApi: 'openai-responses' } },
      { id: 'chat-model', name: 'Chat', discoveredMetadata: { nativeApi: 'openai-completions' } },
    ] }));
    if (id === 'openrouter-retry') fetchModels.mockResolvedValueOnce({ ok: false, models: [] });
    Object.assign(window.electronAPI.maker, { fetchProviderModels: fetchModels });
    if (id === 'openrouter-reconnected') providerSnapshotState.customOverride.connected = false;
    const view = render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    if (id === 'openrouter-reconnected') {
      providerSnapshotState.customOverride.connected = true;
      view.rerender(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    }
    const refresh = await screen.findByRole('button', { name: 'settings.providers.models.refreshAria' });
    await act(async () => { fireEvent.click(refresh); });
    if (id === 'openrouter-retry') {
      expect(updateCustomProvider).not.toHaveBeenCalled();
      expect((refresh as HTMLButtonElement).disabled).toBe(false);
      await act(async () => { fireEvent.click(refresh); });
      expect(fetchModels).toHaveBeenCalledTimes(2);
    }
    expect(fetchModels).toHaveBeenCalledWith(expect.objectContaining({
      savedProviderId: id, authMethod: method, baseUrl, modelsUrl: `${baseUrl}/models`,
    }));
    if (method === 'oauth') expect(readCustomProviderKey).not.toHaveBeenCalled();
    expect(updateCustomProvider).toHaveBeenCalledWith(expect.objectContaining({ id,
      ...(method === 'oauth' ? { auth: { method, oauth } } : {}),
      runtimes: expect.objectContaining({ codex: expect.objectContaining({ models: expect.arrayContaining([
        expect.objectContaining({ id: 'new-model', discoveredMetadata: { nativeApi: 'openai-responses' } }),
        ...(hasModels ? [expect.objectContaining({ id: 'old-model', contextWindow: 64000, defaultEnabled: false })] : []),
      ]) }) }),
    }), {}, { source: 'manual-settings' });
    const saved = vi.mocked(updateCustomProvider).mock.calls[0]![0];
    // Refresh adds membership without freezing a visibility choice. Codex speaks the
    // Responses API the supplier serves, so a Chat-native model is not local conversion.
    for (const modelId of ['new-model', 'chat-model']) {
      const model = saved.runtimes.codex?.models.find(model => model.id === modelId);
      expect(model).toBeDefined();
      expect(model).not.toHaveProperty('defaultEnabled');
    }
    const projected = buildUserProvider(saved).models.codex!;
    expect(projected.find(model => model.id === 'new-model')?.defaultEnabled).toBe(true);
    expect(projected.find(model => model.id === 'chat-model')?.defaultEnabled).toBe(true);
    if (hasModels) expect(projected.find(model => model.id === 'old-model')?.defaultEnabled).toBe(false);
    expect(refetchProvidersSpy).toHaveBeenCalled();
  });
  it('dims GPT Image 2 without a ready image channel, independently of chat connection', async () => {
    providerSnapshotState.order = ['custom', 'xd'];
    providerSnapshotState.customConnected = true;
    const view = render(
      <MemoryRouter>
        <ProvidersSection />
      </MemoryRouter>,
    );
    await screen.findByRole('switch', { name: 'Custom model' });
    fireEvent.click(screen.getByRole('button', { name: 'newChat.modelSelector.category.image1' }));
    providerSnapshotState.customConnected = false;
    view.rerender(
      <MemoryRouter>
        <ProvidersSection />
      </MemoryRouter>,
    );
    const imageRow = () => screen.getByText('GPT Image 2').closest('div.group')!;
    expect(imageRow().classList.contains('opacity-55')).toBe(true);
    expect(screen.getByText('GPT Image 2').getAttribute('style')).toBe(
      screen.getByText('Custom model').getAttribute('style'),
    );
    providerSnapshotState.mediaReady = true;
    view.rerender(
      <MemoryRouter>
        <ProvidersSection />
      </MemoryRouter>,
    );
    expect(imageRow().classList.contains('opacity-55')).toBe(false);
    expect(screen.getByRole('switch', { name: 'Custom model' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    providerSnapshotState.mediaReady = false;
    providerSnapshotState.customConnected = true;
    view.rerender(
      <MemoryRouter>
        <ProvidersSection />
      </MemoryRouter>,
    );
    expect(imageRow().classList.contains('opacity-55')).toBe(true);
    expect(screen.getByRole('switch', { name: 'Custom model' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('keeps selections but blocks toggles when a connected source becomes unavailable', async () => {
    providerSnapshotState.order = ['custom', 'xd'];
    const view = render(
      <MemoryRouter>
        <ProvidersSection />
      </MemoryRouter>,
    );
    let toggle = (await screen.findByRole('switch', { name: 'Custom model' })) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('settings.providers.models.manage.selected:1')).toBeTruthy();
    providerSnapshotState.customConnected = false;
    view.rerender(
      <MemoryRouter>
        <ProvidersSection />
      </MemoryRouter>,
    );
    toggle = screen.getByRole('switch', { name: 'Custom model' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('settings.providers.models.manage.selected:0')).toBeTruthy();
    fireEvent.click(toggle);
    expect(setModelVisibilities).not.toHaveBeenCalled();
    expect(screen.getByText('settings.providers.models.manage.connectionRequired')).toBeTruthy();
    providerSnapshotState.customConnected = true;
    view.rerender(
      <MemoryRouter>
        <ProvidersSection />
      </MemoryRouter>,
    );
    expect(
      (screen.getByRole('switch', { name: 'Custom model' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText('settings.providers.models.manage.connectionRequired')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Custom model' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByText('settings.providers.models.manage.selected:1')).toBeTruthy();
    expect(setModelVisibilities).not.toHaveBeenCalled();
  });

  it('首个可见供应商默认选中;未连接内置渠道不占行;零模型仍可手动刷新', async () => {
    // ProvidersSection 内部消费 useSearchParams(深链定位),测试需要 Router 上下文。
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
    expect(requestAutoRefreshSpy).toHaveBeenCalledWith('providers-open');

    // 左栏保留品牌翻译，详情头使用连接的实际显示名。
    expect(
      (await screen.findAllByText('settings.providers.xd.title')).length,
    ).toBeGreaterThanOrEqual(1);
    // 详情标题的模型数/订阅标签必须在可用宽度内折行，不能溢出覆盖右侧连接操作。
    const identity = screen.getByTestId('provider-detail-identity');
    const metadata = screen.getByTestId('provider-detail-metadata');
    expect(identity.contains(metadata)).toBe(true);
    expect(identity.classList.contains('flex-auto')).toBe(true);
    expect(metadata.classList.contains('flex-wrap')).toBe(true);
    // 未连接的 Anthropic 不出现在左栏(无检测建议时整页不出现)。
    expect(screen.queryByText('Anthropic')).toBeNull();
    // xd 实时模型为空 → 详情仍渲染模型工具行与刷新入口，避免用户无从恢复。
    expect(screen.getByText('settings.providers.detail.emptyModels')).not.toBeNull();
    expect(screen.getByText('settings.providers.models.manage.title')).not.toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' }),
      );
    });
    expect(refreshBuiltinModelsSpy).toHaveBeenCalledWith('xd');
  });

  it('同一事件循环内连续点击刷新只启动一个请求', async () => {
    let resolveRefresh!: (value: { ok: true; providerId: 'xd' }) => void;
    const pendingRefresh = new Promise<{ ok: true; providerId: 'xd' }>((resolve) => {
      resolveRefresh = resolve;
    });
    refreshBuiltinModelsSpy.mockReturnValueOnce(pendingRefresh);
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    const button = await screen.findByRole('button', {
      name: 'settings.providers.models.refreshBuiltinAria',
    });
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(refreshBuiltinModelsSpy).toHaveBeenCalledTimes(1);
    const refreshingButton = screen.getByRole('button', {
      name: 'settings.providers.models.refreshingAria',
    });
    expect(refreshingButton.getAttribute('title')).toBe('settings.providers.models.refreshingAria');

    await act(async () => {
      resolveRefresh({ ok: true, providerId: 'xd' });
      await pendingRefresh;
    });
  });

  it('内置刷新失败按错误码区分文案:dev 禁网提示跳过,其余保持通用失败', async () => {
    refreshBuiltinModelsSpy.mockRejectedValueOnce(
      createIpcError('MODEL_CATALOG_FETCH_DISABLED', '模型目录远程拉取未启用'),
    );
    refreshBuiltinModelsSpy.mockRejectedValueOnce(new Error('network down'));
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' }),
      );
    });
    expect(toast.info).toHaveBeenLastCalledWith('settings.providers.models.refreshFetchDisabled');

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' }),
      );
    });
    expect(toast.error).toHaveBeenLastCalledWith('settings.providers.models.refreshFailed');
  });

  it('检测到本机 CLI 且渠道未连接 → 建议行出现,点击直达向导授权步', async () => {
    scanResult = {
      detections: [
        { cli: 'claude-cli', providerId: 'anthropic', installed: true, loggedIn: true },
        { cli: 'codex-cli', providerId: 'openai', installed: false, loggedIn: false },
      ],
    };
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    // 建议组标签 + Anthropic 建议行(codex 未安装不出现)。
    expect(await screen.findByText('settings.providers.detect.groupLabel')).not.toBeNull();
    const action = screen.getByText('settings.providers.detect.action');
    fireEvent.click(action.closest('button')!);

    // 向导以 entry 直达 anthropic。
    expect(screen.getByTestId('wizard-stub')).not.toBeNull();
    expect(wizardSpy).toHaveBeenCalledWith({ kind: 'builtin', providerId: 'anthropic' });
  });

  it('首次记录可见项，并用方向键提交新的可见顺序', async () => {
    providerSnapshotState.order = ['anthropic', 'xd'];
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );

    const handles = await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-1', 1, ['custom']);
    await act(async () => {
      fireEvent.keyDown(handles[0]!, { key: 'ArrowDown' });
      await Promise.resolve();
    });
    // Renderer 只提交左栏顺序；Main 负责保留曾出现但当前隐藏的供应商槽位。
    expect(setProviderOrderSpy).toHaveBeenLastCalledWith('owner-1', 1, ['custom', 'xd']);
    const selectedRows = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'true');
    expect(selectedRows).toHaveLength(1);
    expect(selectedRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(screen.queryByRole('button', { name: 'settings.providers.order.reset' })).toBeNull();

    // Main 对未观察隐藏项的权威结果会把它放到末尾。pending 只比较左栏可见顺序，
    // 收到该快照后应清除；后续 Main 顺序变化不得再被旧乐观状态覆盖。
    await act(async () => {
      providerSnapshotState.order = ['custom', 'xd', 'anthropic'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    await act(async () => {
      providerSnapshotState.order = ['xd', 'custom', 'anthropic'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    const providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(providerRows[1]?.textContent).toContain('Custom');
  });

  it('已有顺序快照挂载时不自动回写，避免旧窗口覆盖显式排序', async () => {
    providerSnapshotState.order = ['anthropic', 'custom', 'xd'];
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    expect(setProviderOrderSpy).not.toHaveBeenCalled();
  });

  it('写入结束后的同目录权威快照会结束乐观排序，以另一窗口的后写结果为准', async () => {
    let resolveOrderWrite!: (value: { ok: true }) => void;
    const orderWrite = new Promise<{ ok: true }>((resolve) => {
      resolveOrderWrite = resolve;
    });
    setProviderOrderSpy.mockReturnValueOnce(orderWrite);
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );

    const handles = await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    fireEvent.keyDown(handles[0]!, { key: 'ArrowDown' });
    let providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('Custom');
    expect(providerRows[1]?.textContent).toContain('settings.providers.xd.title');

    await act(async () => {
      resolveOrderWrite({ ok: true });
      await orderWrite;
      await Promise.resolve();
    });
    expect(refetchProvidersSpy).toHaveBeenCalledOnce();

    // B 窗口后写成为 Main 最终顺序；目录成员没变，但新快照必须结束 A 的 pending。
    await act(async () => {
      providerSnapshotState.order = ['anthropic', 'xd', 'custom'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(providerRows[1]?.textContent).toContain('Custom');
  });

  it('切换数据 owner 后会按新 owner 重新记录可见项', async () => {
    providerSnapshotState.order = ['anthropic', 'xd'];
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );
    await waitFor(() => {
      expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-1', 1, ['custom']);
    });
    setProviderOrderSpy.mockClear();

    await act(async () => {
      authState.dataOwnerId = 'owner-2';
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    expect(setProviderOrderSpy).not.toHaveBeenCalled();

    await act(async () => {
      providerSnapshotState.dataOwnerId = 'owner-2';
      providerSnapshotState.ownerGeneration = 2;
      providerSnapshotState.order = ['xd'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-2', 2, ['custom']);
    });
  });
});
