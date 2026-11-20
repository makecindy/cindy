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
import { MODEL_FAVORITES_GET, MODEL_GROUPS_REMOTE_CHANNEL } from '@cindy/device-link';
import { useRemoteModelGroups } from '@/features/model-groups/remoteModelGroups';

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
    <ModelSelector remoteAgent={undefined}
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
        onPresenceChanged: () => vi.fn(),
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

/**
 * 测试价值
 * - 生产入口与可观察结果：真实 ModelSelector 的打开回调 + 真实 useRemoteModelGroups；草稿开着时那台新建了模式，
 *   重新打开选择器就列出来，关着时不发请求。
 * - 规则依据：model-groups.md「在另一台电脑上开的新任务」(2026-11-17 用户裁决：每次打开选择器重读一次，不轮询)。
 * - 现有覆盖缺口：remoteModelGroups.test.tsx 只覆盖代次变了就重读，没有覆盖选择器打开时给出代次、打开期间不重复读。
 * - 最小失败输入：先只有 Coding，那台加了 Planning 后关上再打开选择器。
 * - tier：unit/jsdom，只替换 preload 的 deviceLink 桥。
 */
describe('另一台电脑的模型组', () => {
  it('每次打开选择器向那台重读一次模式，关着时不读', async () => {
    fixtures.cloudOnline = true;
    const route = (id: string, name: string) => ({
      id, name, strategy: 'order', candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt' }],
    });
    let routes = [route('coding', 'Coding')];
    const base = fixtures.invoke.getMockImplementation()!;
    fixtures.invoke.mockImplementation(async (deviceId: string, channel: string, args: unknown[]) =>
      channel === MODEL_GROUPS_REMOTE_CHANNEL ? { config: { routes } } : base(deviceId, channel, args));
    const listReads = () => fixtures.invoke.mock.calls.filter(([, channel]) => channel === MODEL_GROUPS_REMOTE_CHANNEL).length;
    function RemoteDraftPicker() {
      const [reread, setReread] = React.useState(0);
      const groups = useRemoteModelGroups('cloud-device', true, reread);
      return (
        <ModelSelector remoteAgent={undefined}
          modelId="cloud-model" effort="medium" vendorKey="cc" deviceId="cloud-device" currentProviderId="cloud-provider"
          onModelChange={vi.fn()} onEffortChange={vi.fn()} onProviderChange={vi.fn()}
          onPickerOpen={() => setReread((value) => value + 1)}
          {...(groups.status === 'ready' ? { modelGroups: { config: groups.config, active: null, onSelect: vi.fn(), remote: true } } : {})}
        />
      );
    }
    render(<RemoteDraftPicker />);
    await waitFor(() => expect(listReads()).toBe(1));
    const trigger = screen.getByRole('button');

    fireEvent.click(trigger);
    expect(await within(await screen.findByRole('listbox')).findByText('Coding')).toBeTruthy();
    expect(listReads()).toBe(2);

    routes = [route('coding', 'Coding'), route('planning', 'Planning')];
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(listReads()).toBe(2);

    fireEvent.click(trigger);
    expect(await within(await screen.findByRole('listbox')).findByText('Planning')).toBeTruthy();
    expect(listReads()).toBe(3);
  });
});
