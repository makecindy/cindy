// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const provider = (id: string, name: string, modelId: string, modelName: string) => ({
    id,
    name,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'oauth' },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': [{
        id: modelId,
        name: modelName,
        group: 'anthropic',
        sortOrder: 1,
        contextWindow: 200000,
        efforts: ['low', 'medium'],
        defaultEffort: 'medium',
      }],
    },
  });
  return {
    localProviders: [provider('task-provider', 'Task computer provider', 'local-model', 'Local model')],
    cloudProviders: [provider('cloud-provider', 'Cloud provider', 'cloud-model', 'Cloud model')],
    favoritesErrorCode: null as string | null,
    cloudOnline: false,
    invoke: vi.fn(),
  };
});

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'newChat.modelSelector.remoteLoading': '正在读取远程设备上的模型…',
        'newChat.modelSelector.remoteLoadFailed': '无法读取远程设备上的模型。请检查连接后重试。',
        'newChat.modelSelector.retryRemoteModels': '重新读取模型',
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.search.noResults': '无匹配模型',
        'newChat.modelSelector.unified.railAll': '全部',
        'newChat.modelSelector.unified.railFavorites': '收藏',
        'newChat.modelSelector.unified.railSameEngine': `仅 ${options?.agent ?? ''}`,
        'newChat.modelSelector.unified.favoritesGroup': '收藏',
        'newChat.modelSelector.unified.favoritesSyncFailedUnreachable': '收藏暂不可达',
        'newChat.modelSelector.unified.favoritesSyncFailed': '收藏同步失败',
        'settings.providers.anthropic.title': 'Anthropic',
        'effortLevels.medium': '中',
        'effortLevels.low': '低',
      };
      return translations[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: fixtures.localProviders, providerOrder: [], loading: false }),
}));
vi.mock('@/hooks/useApiKey', () => ({ useApiKey: () => ({ hasSavedKey: true }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));
vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ accountTier: null }),
}));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: () => new Map(),
}));
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({
  useLocalProviderGroups: () => ({}),
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: () => null,
}));
vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));

import { ModelSelector, type RemoteAgentRelocation } from '@/components/new-chat/ModelSelector';
import { evictDeviceCapabilities } from '@/hooks/useAgentCapabilities';
import { evictDeviceProviders } from '@/hooks/useDeviceProviders';
import { makerApiForDevice } from '@/lib/makerTransport';
import { MODEL_FAVORITES_GET } from '@cindy/device-link';

const remoteError = () => new Error('[DEVICE_LINK_TIMEOUT] remote device did not respond');
const capabilities = (modelId: string, modelName: string) => ({
  availableModels: [{
    id: modelId,
    displayName: modelName,
    contextWindow: 200000,
    efforts: ['low', 'medium'],
    defaultEffort: 'medium',
  }],
  hasFastMode: false,
  effortLevels: [{ id: 'low', displayName: 'Low' }, { id: 'medium', displayName: 'Medium' }],
  permissionModes: [],
  supportsSessionAgentSwitch: true,
  supportsSessionAgentSwitchCas: true,
});

function renderRemoteAgentPicker(onRelocate: (selection: RemoteAgentRelocation) => Promise<boolean>) {
  return render(
    <ModelSelector
      modelId="cloud-model"
      effort="medium"
      vendorKey="cc"
      currentProviderId="cloud-provider"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onProviderChange={vi.fn()}
      remoteAgent={{
        devices: [{ deviceId: 'cloud-device', name: 'Cloud computer' }],
        selectedDeviceId: 'cloud-device',
        homeDeviceId: 'task-device',
        onRelocate,
      }}
    />,
  );
}

function renderRemoteDevicePicker(deviceId = 'cloud-device') {
  return render(
    <ModelSelector
      modelId="cloud-model"
      effort="medium"
      vendorKey="cc"
      deviceId={deviceId}
      currentProviderId="cloud-provider"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onProviderChange={vi.fn()}
    />,
  );
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button'));
  await screen.findByRole('listbox');
}

beforeEach(() => {
  fixtures.cloudOnline = false;
  fixtures.favoritesErrorCode = null;
  fixtures.invoke.mockReset().mockImplementation(async (deviceId: string, channel: string) => {
    if (channel === 'maker:get-capabilities') {
      if (deviceId === 'cloud-device' && !fixtures.cloudOnline) throw remoteError();
      return deviceId === 'cloud-device'
        ? capabilities('cloud-model', 'Cloud model')
        : capabilities('local-model', 'Local model');
    }
    if (channel === 'maker:provider:list') {
      if (deviceId === 'cloud-device' && !fixtures.cloudOnline) throw remoteError();
      return { providers: deviceId === 'cloud-device' ? fixtures.cloudProviders : fixtures.localProviders };
    }
    if (channel === MODEL_FAVORITES_GET) {
      if (fixtures.favoritesErrorCode) {
        throw new Error(`[${fixtures.favoritesErrorCode}] favorite list failed`);
      }
      return [];
    }
    if (channel === 'maker:switch-session-agent') return { switched: true };
    return null;
  });
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        invoke: fixtures.invoke,
        onRemotePush: () => vi.fn(),
        onStatusChanged: () => vi.fn(),
        onPeerLinkReset: () => vi.fn(),
        onResponsivenessChanged: () => vi.fn(),
      },
    },
  });
  for (const deviceId of ['cloud-device', 'task-device']) {
    evictDeviceCapabilities(deviceId);
    evictDeviceProviders(deviceId);
  }
});

afterEach(() => {
  for (const deviceId of ['cloud-device', 'task-device']) {
    evictDeviceCapabilities(deviceId);
    evictDeviceProviders(deviceId);
  }
});

describe('Agent 所在电脑离线时的真实模型面板(协同任务与普通任务同一套)', () => {
  it('云端目录超时后显示错误与重试；点本机供应商格选本机模型，切换 IPC 带 agentDeviceId=null', async () => {
    const relocate = vi.fn(async (selection) => {
      await makerApiForDevice('task-device').switchSessionAgent(
        'session-1',
        selection.agent,
        selection.modelId,
        selection.providerId,
        selection.effort,
        selection.fast,
        { agentDeviceId: selection.agentDevice?.deviceId ?? null },
      );
      return true;
    });
    renderRemoteAgentPicker(relocate);
    await openPicker();

    expect((await screen.findByRole('alert')).textContent).toContain('无法读取远程设备上的模型');
    expect(screen.getByRole('button', { name: '重新读取模型' })).toBeTruthy();

    fixtures.invoke.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '重新读取模型' }));
    await waitFor(() =>
      expect(fixtures.invoke).toHaveBeenCalledWith(
        'cloud-device',
        'maker:provider:list',
        expect.any(Array),
      ),
    );

    const taskProviderCell = await screen.findByRole('button', { name: 'Task computer provider' });
    expect(taskProviderCell.getAttribute('data-rail-item')).toBe('provider:task-provider');
    fireEvent.click(taskProviderCell);
    const localModel = await within(screen.getByRole('listbox')).findByText('Local model');
    fireEvent.click(localModel.closest('[data-unified-anchor]') as HTMLElement);

    await waitFor(() => expect(relocate).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'task-provider',
      modelId: 'local-model',
      agent: 'claude-code',
      agentDevice: null,
    })));
    expect(fixtures.invoke).toHaveBeenCalledWith('task-device', 'maker:switch-session-agent', [
      'session-1',
      'claude-code',
      'local-model',
      'task-provider',
      'medium',
      false,
      { agentDeviceId: null },
    ]);
  });

  it.each([
    ['DEVICE_LINK_TIMEOUT', '收藏暂不可达'],
    ['DEVICE_LINK_CHANNEL_NOT_ALLOWED', '收藏同步失败'],
  ])('收藏读取错误 %s 映射为对应用户文案', async (errorCode, expectedText) => {
    fixtures.cloudOnline = true;
    fixtures.favoritesErrorCode = errorCode;
    renderRemoteDevicePicker();
    await openPicker();

    expect((await screen.findByRole('status')).textContent).toContain(expectedText);
  });
});
