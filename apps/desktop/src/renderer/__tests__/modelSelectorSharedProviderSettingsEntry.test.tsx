// @vitest-environment jsdom
/**
 * 模型面板底部「配置模型」：本机目录与分享来的供应商显示，点分享来的供应商时带上分享 id，
 * 设置页直接选中那一条(provider-sharing.md §5.2)。自己其他电脑与被控电脑上的目录要到那台电脑上改，不显示。
 */
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

vi.mock('@/hooks/useAgentCapabilities', () => ({
  evictDeviceCapabilities: vi.fn(),
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
    local: [provider('a-local', 'A Local', 'a-model')] as unknown[],
    byDevice: {
      'device-b': [provider('b-main', 'B Main', 'b-model')],
      'device-c': [provider('c-open', 'C Open', 'c-model', { remoteInvocationEnabled: true })],
      'share:abc': [provider('s-shared', 'S Shared', 's-model', { remoteInvocationEnabled: true })],
    } as Record<string, unknown[]>,
  };
});

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalogs.local, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: (deviceId?: string) => ({
    providers: deviceId ? (catalogs.byDevice[deviceId] ?? []) : [],
    loading: false,
    error: null,
    unsupported: false,
  }),
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (deviceIds: readonly string[]) =>
    new Map(
      deviceIds.map((deviceId) => [
        deviceId,
        { providers: catalogs.byDevice[deviceId] ?? [], loading: false, error: null },
      ]),
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
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import { __resetForTest as resetFavorites } from '@/state/modelFavorites';

const studio = { deviceId: 'device-c', name: 'Studio' };
const share = { deviceId: 'share:abc', name: '来自 Magi 的分享' };
const SHARE_CELL = 'S Shared · 来自 Magi 的分享';
const ENTRY = 'newChat.modelSelector.source.connect';

type Props = React.ComponentProps<typeof ModelSelectorContent>;

function renderPanel(
  remoteAgent: Partial<NonNullable<Props['remoteAgent']>> = {},
  props: Partial<Props> = {},
) {
  const onNavigateToProviders = vi.fn();
  render(
    React.createElement(ModelSelectorContent, {
      modelId: 'a-model',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'a-local',
      onProviderChange: vi.fn(),
      onUnifiedSelect: vi.fn(async () => true),
      vendorKey: 'cc',
      onNavigateToProviders,
      remoteAgent: { devices: [studio, share], selectedDeviceId: null, ...remoteAgent },
      ...props,
    }),
  );
  return { onNavigateToProviders };
}

async function browse(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

beforeEach(() => {
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
});

describe('模型面板底部「配置模型」', () => {
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
