// @vitest-environment jsdom
/**
 * 模型列表里供应商组的一行说明(provider-groups.md §10，2026-10-10 用户要求)：
 *   1. 浏览同账号另一台电脑的组：标题下列出组里有几台、是哪几台(组所在电脑、我的其他电脑、分享来的电脑)；
 *   2. 分享来的电脑只用分享者昵称称呼(「Magi 的电脑」)，不出现分享者的电脑名(provider-sharing.md §6)；
 *   3. 分享给我的供应商建了组：只写组里有几台，不写是哪几台，左栏也标出「供应商组」；
 *   4. 本机建的组：本机那一格同样有这行说明，组所在电脑写「本机」；
 *   5. 没有组的供应商不显示说明。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      const o = options ?? {};
      const table: Record<string, string> = {
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.unified.favoritesGroup': '收藏',
        'newChat.modelSelector.unified.customize': '自定义',
        'newChat.modelSelector.unified.railAll': '全部',
        'newChat.modelSelector.unified.railRemoteProvider': `${o.provider} · ${o.device}`,
        'newChat.modelSelector.unified.railRemoteProviderGroup': `${o.provider} · ${o.device} · 供应商组`,
        'newChat.modelSelector.unified.groupNote': `供应商组 · ${o.count} 台电脑`,
        'newChat.modelSelector.unified.groupNoteMembers': `供应商组 · ${o.count} 台电脑：${o.names}`,
        'providerGroup.member.local': '本机',
        'providerGroup.member.shareComputer': `${o.name} 的电脑`,
        'providerGroup.member.shareComputerUnknown': '分享来的电脑',
        'effortLevels.low': '低',
        'effortLevels.high': '高',
      };
      return table[key] ?? (o.defaultValue as string | undefined) ?? key;
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
  const member = (key: string, kind: string, agentDeviceId: string | null, providerId: string, label?: string) => ({
    key, kind, agentDeviceId, providerId, ...(label ? { label } : {}), paused: false,
  });
  return {
    local: [
      provider('a-local', 'A Local', [['a-model', 'A Model']]),
      provider('a-plain', 'A Plain', [['plain-model', 'Plain Model']]),
    ] as unknown[],
    localGroups: {
      'a-local': {
        strategy: 'least',
        autoSwitch: true,
        members: [member('local', 'local', null, 'a-local'), member('device:device-d:d-open', 'device', 'device-d', 'd-open', 'Laptop')],
      },
    } as Record<string, unknown>,
    byDevice: {
      // Studio 把 c-open 建成了组：组所在电脑自己、Laptop、Magi 分享来的一台。
      'device-c': [
        provider('c-open', 'C Open', [['c-model', 'C Model']], {
          remoteInvocationEnabled: true,
          group: {
            strategy: 'least',
            autoSwitch: true,
            members: [
              member('local', 'local', null, 'c-open'),
              member('device:device-d:d-open', 'device', 'device-d', 'd-open', 'Old Laptop Name'),
              // 旧版本存下的快照可能是分享者的电脑名，界面不能用它。
              member('share:s1:x', 'share', 'share:s1', 'x', "Magi's Mac Mini"),
            ],
          },
        }),
        provider('c-solo', 'C Solo', [['solo-model', 'Solo Model']], { remoteInvocationEnabled: true }),
      ],
      'device-d': [provider('d-open', 'D Open', [['d-model', 'D Model']], { remoteInvocationEnabled: true })],
      // Kai 分享给我的供应商建了组：目录里只有台数。
      'share:abc': [
        provider('s-shared', 'S Shared', [['s-model', 'S Model']], { remoteInvocationEnabled: true, groupSize: 3 }),
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
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({
  useLocalProviderGroups: () => catalogs.localGroups,
}));
vi.mock('@/features/provider-share/providerShareStore', () => ({
  useProviderShareReceived: () => ({
    received: [{ shareId: 's1', providerLabel: 'X', deviceName: "Magi's Mac Mini", owner: { displayName: 'Magi' } }],
    loaded: true,
  }),
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

const devices = [
  { deviceId: 'device-c', name: 'Studio' },
  { deviceId: 'device-d', name: 'Laptop' },
  { deviceId: 'share:abc', name: '来自 Kai 的分享' },
];

function renderLocalTaskPanel() {
  render(
    React.createElement(ModelSelectorContent, {
      modelId: 'a-model',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'a-local',
      onProviderChange: vi.fn(),
      actualRoute: true,
      vendorKey: 'cc',
      remoteAgent: { devices, selectedDeviceId: null, onRelocate: vi.fn(async () => true) },
    }),
  );
}

const list = () => screen.getByRole('listbox');
// 测试里没有 i18n 实例，名单按运行环境的默认语言拼接(与组件同一种写法)。
const names = (items: string[]) => new Intl.ListFormat(undefined, { style: 'short', type: 'conjunction' }).format(items);
const notes = () => Array.from(list().querySelectorAll('[data-group-note]')).map((node) => node.textContent);

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

describe('模型列表顶部的供应商组说明', () => {
  it('同账号另一台电脑的组：列出组里有几台、是哪几台，分享来的电脑只写分享者昵称', async () => {
    renderLocalTaskPanel();
    // 组员 Laptop 收进了组，左栏只剩组那一项。
    expect(screen.queryByRole('button', { name: 'D Open · Laptop' })).toBeNull();
    await browse('C Open · Studio · 供应商组');
    expect(notes()).toEqual([`供应商组 · 3 台电脑：${names(['Studio', 'Laptop', 'Magi 的电脑'])}`]);
    expect(list().textContent).not.toContain('Mac Mini');
  });

  it('没有组的供应商不显示说明', async () => {
    renderLocalTaskPanel();
    await browse('C Solo · Studio');
    expect(within(list()).getByText('Solo Model')).toBeTruthy();
    expect(notes()).toEqual([]);
  });

  it('分享来的组只写台数，左栏标出供应商组', async () => {
    renderLocalTaskPanel();
    await browse('S Shared · 来自 Kai 的分享 · 供应商组');
    expect(within(list()).getByText('S Model')).toBeTruthy();
    expect(notes()).toEqual(['供应商组 · 3 台电脑']);
  });

  it('本机建的组：本机那一格同样有说明，组所在电脑写「本机」', async () => {
    renderLocalTaskPanel();
    // 「全部」视图里当前模型收进了推荐小节，供应商标题要点进那一格才出现。
    await browse('A Local');
    expect(within(list()).getByText('A Model')).toBeTruthy();
    expect(notes()).toEqual([`供应商组 · 2 台电脑：${names(['本机', 'Laptop'])}`]);
  });
});
