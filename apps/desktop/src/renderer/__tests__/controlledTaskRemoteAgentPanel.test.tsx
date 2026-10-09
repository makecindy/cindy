// @vitest-environment jsdom
/**
 * 远程控制的被控电脑上的任务也能选到第三台电脑的远程供应商(2026-10-09 用户反馈:A 远控 B 的
 * 任务时选不到 C 的远程供应商,而手机远控 B 能选到)。
 *
 * 场景:同账号 A(本机,控制端)、B(被控电脑,任务在这台)、C(开了「允许被远程调用」的电脑)。
 * 锁住模型面板的几件事:
 *   1. 任务所在电脑那一格列 B 的目录(照远程控制列全部供应商),不拿 A 本机的目录顶替;
 *   2. 其他电脑一段列 C 开放了远程调用的供应商,没开放的不列;
 *   3. 点 C 的格浏览 C 的目录,选中那里的模型 = 带着 C 换 Agent 位置;
 *   4. 不传 homeDeviceId 的本机任务照旧用本机目录。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const table: Record<string, string> = {
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.unified.favoritesGroup': '收藏',
        'newChat.modelSelector.unified.customize': '自定义',
        'newChat.modelSelector.unified.railAll': '全部',
        'newChat.modelSelector.unified.railRemoteProvider': `${options?.provider ?? ''} · ${options?.device ?? ''}`,
        'effortLevels.low': '低',
        'effortLevels.high': '高',
      };
      return table[key] ?? options?.defaultValue ?? key;
    },
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
  const provider = (
    id: string,
    name: string,
    models: readonly (readonly [string, string])[],
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    name,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'api-key' },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': models.map(([modelId, modelName]) => ({
        id: modelId,
        name: modelName,
        contextWindow: 200000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      })),
    },
    ...extra,
  });
  return {
    /** 读不到目录的电脑(离线)。 */
    offline: new Set<string>(),
    /** A:本机(控制端)自己的目录。 */
    local: [provider('a-local', 'A Local', [['a-model', 'A Model']])] as unknown[],
    byDevice: {
      // B:被控电脑。远程控制照常看到全部供应商,有没有开放远程调用都列。
      'device-b': [
        provider('b-main', 'B Main', [['b-model', 'B Model']]),
        provider('b-closed', 'B Closed', [['b-closed-model', 'B Closed Model']], {
          remoteInvocationEnabled: false,
        }),
      ],
      // C:开了「允许被远程调用」的电脑,只有一个供应商开放。
      'device-c': [
        provider('c-open', 'C Open', [['c-model', 'C Model']], { remoteInvocationEnabled: true }),
        provider('c-closed', 'C Closed', [['c-hidden-model', 'C Hidden Model']], {
          remoteInvocationEnabled: false,
        }),
      ],
    } as Record<string, unknown[]>,
  };
});

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalogs.local, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: (deviceId?: string) =>
    deviceId && catalogs.offline.has(deviceId)
      ? { providers: [], loading: false, error: 'DEVICE_LINK_UNREACHABLE', unsupported: false }
      : {
          providers: deviceId ? (catalogs.byDevice[deviceId] ?? []) : [],
          loading: false,
          error: null,
          unsupported: false,
        },
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (deviceIds: readonly string[]) =>
    new Map(
      deviceIds.map((deviceId) => [
        deviceId,
        catalogs.offline.has(deviceId)
          ? { providers: [], loading: false, error: 'DEVICE_LINK_UNREACHABLE' }
          : { providers: catalogs.byDevice[deviceId] ?? [], loading: false, error: null },
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

const devices = [{ deviceId: 'device-c', name: 'Studio' }];

function renderControlledTaskPanel(
  remoteAgent: Partial<React.ComponentProps<typeof ModelSelectorContent>['remoteAgent']> = {},
  props: Partial<React.ComponentProps<typeof ModelSelectorContent>> = {},
) {
  const onRelocate = vi.fn(async () => true);
  const onProviderChange = vi.fn();
  render(
    React.createElement(ModelSelectorContent, {
      modelId: 'b-model',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'b-main',
      onProviderChange,
      actualRoute: true,
      vendorKey: 'cc',
      // 被控电脑上的任务:ChatInput 传的 deviceId 是模型目录所在电脑(此处 Agent 在 B)。
      deviceId: 'device-b',
      remoteAgent: {
        devices,
        selectedDeviceId: null,
        homeDeviceId: 'device-b',
        onRelocate,
        ...remoteAgent,
      },
      ...props,
    }),
  );
  return { onRelocate, onProviderChange };
}

const list = () => screen.getByRole('listbox');

beforeEach(() => {
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
});

describe('被控电脑上的任务:模型面板列出第三台电脑的远程供应商', () => {
  it('任务所在电脑那一格列被控电脑的全部供应商,不拿本机目录顶替', () => {
    renderControlledTaskPanel();
    expect(screen.getByRole('button', { name: 'B Main' })).toBeTruthy();
    // 远程控制不按「允许被远程调用」裁剪被控电脑自己的目录。
    expect(screen.getByRole('button', { name: 'B Closed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'A Local' })).toBeNull();
    expect(within(list()).getByText('B Model')).toBeTruthy();
    expect(within(list()).queryByText('A Model')).toBeNull();
  });

  it('其他电脑一段只列开放了远程调用的供应商', () => {
    renderControlledTaskPanel();
    const remote = screen.getByRole('button', { name: 'C Open · Studio' });
    expect(remote.querySelector('[data-remote-source-mark]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'C Closed · Studio' })).toBeNull();
  });

  it('浏览第三台电脑的目录,选中那里的模型 = 带着那台电脑换 Agent 位置', async () => {
    const { onRelocate, onProviderChange } = renderControlledTaskPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'C Open · Studio' }));
    });
    expect(within(list()).getByText('C Model')).toBeTruthy();
    expect(within(list()).queryByText('C Hidden Model')).toBeNull();
    expect(within(list()).queryByText('B Model')).toBeNull();

    const row = within(list()).getByText('C Model').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });
    expect(onRelocate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'c-open',
        modelId: 'c-model',
        agent: 'claude-code',
        agentDevice: { deviceId: 'device-c', name: 'Studio' },
      }),
    );
    // 不经同一台电脑内换模型的链路(那条会把 C 的模型塞给被控电脑)。
    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('Agent 已在第三台电脑:打开时停在那台的目录,任务所在电脑一格仍是被控电脑', () => {
    renderControlledTaskPanel(
      { selectedDeviceId: 'device-c' },
      { deviceId: 'device-c', modelId: 'c-model', currentProviderId: 'c-open' },
    );
    expect(within(list()).getByText('C Model')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'C Open · Studio' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'B Main' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'A Local' })).toBeNull();
  });

  it('Agent 所在的第三台电脑离线:仍能回到被控电脑的目录,选中即改回被控电脑运行', async () => {
    catalogs.offline.add('device-c');
    try {
      const { onRelocate } = renderControlledTaskPanel(
        { selectedDeviceId: 'device-c' },
        { deviceId: 'device-c', modelId: 'c-model', currentProviderId: 'c-open' },
      );
      // 那台的目录读不到:它的供应商格不出现,但被控电脑那一格还在。
      expect(screen.queryByRole('button', { name: 'C Open · Studio' })).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'B Main' }));
      });
      const row = within(list()).getByText('B Model').closest('[data-unified-anchor]') as HTMLElement;
      await act(async () => {
        fireEvent.click(row);
      });
      expect(onRelocate).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'b-main', modelId: 'b-model', agentDevice: null }),
      );
    } finally {
      catalogs.offline.clear();
    }
  });
});

// 2026-10-09 用户反馈:远程控制下新建任务(选了另一台电脑当任务电脑)时模型列表里选不到远程供应商,
// 只有选本机才选得到。草稿走 onUnifiedSelect 直通,不经 onRelocate。
describe('远程控制下新建任务:草稿的模型面板同样列出第三台电脑的远程供应商', () => {
  function renderControlledDraftPanel(
    remoteAgent: Partial<React.ComponentProps<typeof ModelSelectorContent>['remoteAgent']> = {},
    props: Partial<React.ComponentProps<typeof ModelSelectorContent>> = {},
  ) {
    const onUnifiedSelect = vi.fn(async () => true);
    const onProviderChange = vi.fn();
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'b-model',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'b-main',
        onProviderChange,
        actualRoute: false,
        vendorKey: 'cc',
        deviceId: 'device-b',
        onUnifiedSelect,
        remoteAgent: {
          devices,
          selectedDeviceId: null,
          homeDeviceId: 'device-b',
          ...remoteAgent,
        },
        ...props,
      }),
    );
    return { onUnifiedSelect, onProviderChange };
  }

  it('先列被控电脑的全部供应商,再列第三台电脑开放了远程调用的供应商', () => {
    renderControlledDraftPanel();
    expect(screen.getByRole('button', { name: 'B Main' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'B Closed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'A Local' })).toBeNull();
    expect(screen.getByRole('button', { name: 'C Open · Studio' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'C Closed · Studio' })).toBeNull();
  });

  it('选中第三台电脑的模型:把那台电脑交给草稿层,不走换位置', async () => {
    const { onUnifiedSelect, onProviderChange } = renderControlledDraftPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'C Open · Studio' }));
    });
    const row = within(list()).getByText('C Model').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });
    expect(onUnifiedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'c-open',
        modelId: 'c-model',
        engine: 'cc',
        agentDevice: { deviceId: 'device-c', name: 'Studio' },
      }),
    );
    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('Agent 已选在第三台电脑:选回被控电脑的模型带 agentDevice: null', async () => {
    const { onUnifiedSelect } = renderControlledDraftPanel(
      { selectedDeviceId: 'device-c' },
      { deviceId: 'device-c', modelId: 'c-model', currentProviderId: 'c-open' },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'B Main' }));
    });
    const row = within(list()).getByText('B Model').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });
    expect(onUnifiedSelect).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'b-main', modelId: 'b-model', agentDevice: null }),
    );
  });
});

describe('本机任务不受影响', () => {
  it('不传 homeDeviceId 时任务所在电脑一格仍是本机目录', () => {
    renderControlledTaskPanel(
      { homeDeviceId: undefined },
      { deviceId: undefined, modelId: 'a-model', currentProviderId: 'a-local' },
    );
    expect(screen.getByRole('button', { name: 'A Local' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'B Main' })).toBeNull();
    expect(within(list()).getByText('A Model')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'C Open · Studio' })).toBeTruthy();
  });
});
