// @vitest-environment jsdom
/**
 * 模型面板底部「配置模型」：本机目录与分享来的供应商显示，点分享来的供应商时带上分享 id，
 * 设置页直接选中那一条(provider-sharing.md §5.2)。自己其他电脑与被控电脑上的目录要到那台电脑上改，不显示。
 */
import type { ModelSelectorContentBaseProps } from '../components/new-chat/ModelSelector';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared-quota rail observes auth; this component fixture has no auth host.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null, useOptionalAuthDeviceId: () => null }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      key === 'newChat.modelSelector.unified.railRemoteProvider'
        ? `${options?.provider ?? ''} · ${options?.device ?? ''}`
        : options?.defaultValue ?? key,
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));

vi.mock('@/hooks/useAgentCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAgentCapabilities')>()),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  useAgentCapabilities: () => ({
    capabilities: { hasFastMode: false, effortLevels: [], availableModels: [] },
    loading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useApiKey', () => ({ useApiKey: () => ({ hasSavedKey: true }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));

const catalogs = vi.hoisted(() => {
  const provider = (id: string, name: string, modelId: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'api-key' },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': [
        { id: modelId, name: modelId, contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' },
      ],
    },
    ...extra,
  });
  return {
    shareError: null as string | null,
    shareLoading: false,
    local: [provider('a-local', 'A Local', 'a-model')] as unknown[],
    byDevice: {
      'device-b': [provider('b-main', 'B Main', 'b-model')],
      'device-c': [provider('c-open', 'C Open', 'c-model', { remoteInvocationEnabled: true })],
      'share:abc': [provider('s-shared', 'S Shared', 's-model', { remoteInvocationEnabled: true })],
    } as Record<string, unknown[]>,
  };
});

function modelSource(key?: string): string | undefined {
  return key ? parseModelCatalogKey(key)?.agentDeviceId ?? key : undefined;
}

const shareState = vi.hoisted(() => ({ received: [] as Array<Record<string, unknown>> }));
vi.mock('@/features/provider-share/providerShareStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/provider-share/providerShareStore')>()),
  ensureProviderShareReceivedStarted: vi.fn(),
  useProviderShareReceived: () => ({ received: shareState.received, loaded: true }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalogs.local, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDeviceProviders')>()),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: (key?: string) => {
    const deviceId = modelSource(key);
    return {
      providers: deviceId === 'share:abc' && (catalogs.shareError || catalogs.shareLoading) ? [] : deviceId ? (catalogs.byDevice[deviceId] ?? []) : [],
      loading: deviceId === 'share:abc' && catalogs.shareLoading,
      error: deviceId === 'share:abc' ? catalogs.shareError : null,
      unsupported: false,
    };
  },
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (deviceIds: readonly string[]) =>
    new Map(
      deviceIds.map((key) => {
        const deviceId = modelSource(key)!;
        return [key, {
          providers: deviceId === 'share:abc' && (catalogs.shareError || catalogs.shareLoading) ? [] : catalogs.byDevice[deviceId] ?? [],
          loading: deviceId === 'share:abc' && catalogs.shareLoading,
          error: deviceId === 'share:abc' ? catalogs.shareError : null,
        }];
      }),
    ),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));
vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: () => null,
}));

import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { CONTROLLED_MODEL_CATALOG_CHANNEL, CONTROLLED_MODEL_CATALOG_RETRY_SHARE, modelCatalogKey, parseModelCatalogKey } from '../../shared/controlledModelCatalog';
import { prefetchDeviceProviders } from '@/hooks/useDeviceProviders';
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import { __resetForTest as resetFavorites } from '@/state/modelFavorites';

const studio = { deviceId: 'device-c', name: 'Studio' };
const share = { deviceId: 'share:abc', name: '来自 Magi 的分享' };
const SHARE_CELL = 'S Shared · 来自 Magi 的分享';
const ENTRY = 'newChat.modelSelector.source.connect';

type Props = React.ComponentProps<typeof ModelSelectorContent>;

function renderPanel(
  remoteAgent: Partial<NonNullable<Props['remoteAgent']>> = {},
  props: Partial<ModelSelectorContentBaseProps> = {},
) {
  const onNavigateToProviders = vi.fn();
  const onUnifiedSelect = vi.fn(async () => true);
  const panel = () => React.createElement(ModelSelectorContent, {
      modelId: 'a-model',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'a-local',
      onProviderChange: vi.fn(),
      onUnifiedSelect,
      vendorKey: 'cc',
      onNavigateToProviders,
      remoteAgent: { devices: [studio, share], selectedDeviceId: null, ...remoteAgent },
      ...props,
    });
  const result = render(panel());
  return { onNavigateToProviders, onUnifiedSelect, refresh: () => result.rerender(panel()) };
}

async function browse(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

beforeEach(() => {
  catalogs.shareError = null;
  catalogs.shareLoading = false;
  catalogs.byDevice['share:abc'] = [{ ...(catalogs.byDevice['share:abc'][0] as object), connected: true, hidden: false }];
  shareState.received = [];
  vi.clearAllMocks();
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('模型面板底部「配置模型」', () => {
  // Unit / #10826: a known share with no cached catalog must expose retry and
  // recover selection. Existing fixtures only exercised already-loaded shares.
  it.each([undefined, 'device-b'])('keeps a first-load failed share browsable and retries on its catalog host (%s)', async (catalogHostDeviceId) => {
    catalogs.shareError = 'share catalog unavailable';
    const membership = Promise.withResolvers<{ ok: true }>();
    const command = vi.fn(() => membership.promise);
    const invoke = vi.fn(() => membership.promise);
    vi.stubGlobal('electronAPI', { ...window.electronAPI, providerShare: { command }, deviceLink: { invoke } });
    const panel = renderPanel({ catalogHostDeviceId });
    await browse(share.name);
    expect(screen.getByRole('alert').textContent).toContain('newChat.modelSelector.remoteLoadFailed');
    await browse('newChat.modelSelector.retryRemoteModels');
    if (catalogHostDeviceId) {
      expect(invoke).toHaveBeenCalledExactlyOnceWith(catalogHostDeviceId, CONTROLLED_MODEL_CATALOG_CHANNEL, [{
        op: CONTROLLED_MODEL_CATALOG_RETRY_SHARE, agentDeviceId: share.deviceId,
      }]);
      expect(command).not.toHaveBeenCalled();
    } else {
      expect(command).toHaveBeenCalledExactlyOnceWith({ action: 'retry-model-catalog', agentDeviceId: share.deviceId });
    }
    expect(prefetchDeviceProviders).not.toHaveBeenCalled();
    await act(async () => { membership.resolve({ ok: true }); });
    expect(prefetchDeviceProviders).toHaveBeenCalledWith(modelCatalogKey(share.deviceId, catalogHostDeviceId));
    catalogs.shareError = null;
    catalogs.shareLoading = true;
    panel.refresh();
    expect(screen.getByRole('button', { name: share.name })).toBeTruthy();
    catalogs.shareLoading = false;
    panel.refresh();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 's-model high' })); });
    expect(panel.onUnifiedSelect).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 's-shared', modelId: 's-model', agentDevice: share,
    }));
  });
  // Gap (2026-11-23 real run): once the sharer's computer went offline its provider read as
  // disconnected, the share had no listed models and vanished from the rail, coming back with the
  // owner's presence. Minimal input: an active share whose owner is offline and provider disconnected.
  it('keeps a share whose owner computer is offline in the rail and explains it instead of an empty list', async () => {
    catalogs.byDevice['share:abc'] = [{ ...(catalogs.byDevice['share:abc'][0] as object), connected: false }];
    shareState.received = [{ shareId: 'abc', memberId: 'm', providerId: 's-shared', providerLabel: 'S Shared',
      hostDeviceId: 'host', deviceName: 'Cindy', owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
      status: 'active', hostOnline: false, hostCapable: false }];
    renderPanel();
    await browse(SHARE_CELL);
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('providerShare.received.offlineNote'))).toBe(true);
    expect(screen.queryByText('newChat.modelSelector.search.noResults')).toBeNull();
  });

  // Review (#12246): keeping an offline share must not bring back a share its owner hid from the
  // picker. Minimal input: the same offline share, with its provider marked hidden.
  it('does not bring a hidden share back into the rail while its owner computer is offline', () => {
    catalogs.byDevice['share:abc'] = [{ ...(catalogs.byDevice['share:abc'][0] as object), connected: false, hidden: true }];
    shareState.received = [{ shareId: 'abc', memberId: 'm', providerId: 's-shared', providerLabel: 'S Shared',
      hostDeviceId: 'host', deviceName: 'Cindy', owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
      status: 'active', hostOnline: false, hostCapable: false }];
    renderPanel();
    expect(screen.queryByRole('button', { name: SHARE_CELL })).toBeNull();
  });

  it('本机目录照旧显示，打开供应商页不带目标', () => {
    const { onNavigateToProviders } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: ENTRY }));
    expect(onNavigateToProviders).toHaveBeenCalledOnce();
    expect(onNavigateToProviders).toHaveBeenCalledWith(undefined);
  });

  it('浏览分享来的供应商时显示，点击带上这条分享', async () => {
    const { onNavigateToProviders } = renderPanel();
    await browse(SHARE_CELL);
    fireEvent.click(screen.getByRole('button', { name: ENTRY }));
    expect(onNavigateToProviders).toHaveBeenCalledWith({ shareId: 'abc' });
  });

  it('Agent 已在分享上：打开时停在分享的目录，同样带上这条分享', () => {
    const { onNavigateToProviders } = renderPanel(
      { selectedDeviceId: 'share:abc' },
      { modelId: 's-model', currentProviderId: 's-shared' },
    );
    fireEvent.click(screen.getByRole('button', { name: ENTRY }));
    expect(onNavigateToProviders).toHaveBeenCalledWith({ shareId: 'abc' });
  });

  it('自己其他电脑上的远程供应商不显示(要到那台电脑上改)', async () => {
    renderPanel();
    await browse('C Open · Studio');
    expect(screen.queryByRole('button', { name: ENTRY })).toBeNull();
  });

  it('被控电脑上的任务：浏览分享来的供应商也不显示(本机设置管不到那台电脑)', async () => {
    renderPanel(
      { homeDeviceId: 'device-b' },
      { deviceId: 'device-b', modelId: 'b-model', currentProviderId: 'b-main' },
    );
    expect(screen.queryByRole('button', { name: ENTRY })).toBeNull();
    await browse(SHARE_CELL);
    expect(screen.queryByRole('button', { name: ENTRY })).toBeNull();
  });
});
