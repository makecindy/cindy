// @vitest-environment jsdom
/**
 * 模型列表里供应商组那一项的用量(provider-groups.md §10)：组那一项代表组里的几台电脑，不拿组所在电脑
 * 自己的账号当整个组的用量。
 *   1. 任务正经组在某台运行：左栏用量条与悬停读那台的账号，悬停写「当前在 {电脑} 上运行」；
 *   2. 任务运行在组所在电脑本身：读组所在电脑的账号；
 *   3. 还没运行过的任务：不显示某一台的配额，悬停说明开始后由组选电脑；
 *   4. 本机建的组：任务在本机运行时读本机账号。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared-quota rail observes auth; this component fixture has no auth host.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      const o = options ?? {};
      const table: Record<string, string> = {
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.unified.railAll': '全部',
        'newChat.modelSelector.unified.railRemoteProvider': `${o.provider} · ${o.device}`,
        'newChat.modelSelector.unified.railRemoteProviderGroup': `${o.provider} · ${o.device} · ${o.group}`,
        'newChat.modelSelector.unified.providerGroupLabel': `${o.provider} · ${o.group}`,
        'newChat.modelSelector.unified.providerGroupRunningOn': `当前在 ${o.device} 上运行`,
        'newChat.modelSelector.unified.providerGroupRunningHere': '当前在这台电脑上运行',
        'newChat.modelSelector.unified.providerGroupUnassigned': '开始后由供应商组选一台电脑，用量按那台显示',
        'settings.providers.remote.groupBadge': `供应商组 · ${o.count} 台电脑`,
        'quotaCard.weeklyLabel': '周限',
        'quotaCard.remainingPercent': `剩余 ${o.percent}%`,
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
  const provider = (id: string, name: string, identity: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'oauth', native: 'claude' },
    access: { kind: 'subscription', product: 'claude' },
    subscriptionAccount: { identity },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': [
        { id: 'opus', name: 'Opus', contextWindow: 200000, efforts: ['low', 'high'], defaultEffort: 'high' },
      ],
    },
    ...extra,
  });
  const member = (key: string, kind: string, agentDeviceId: string | null, providerId: string) => ({
    key, kind, agentDeviceId, providerId, limit: 4, weight: 1, paused: false,
  });
  return {
    local: [provider('a-local', 'A Local', 'me@desk')] as unknown[],
    localGroups: {
      'a-local': {
        strategy: 'least',
        autoSwitch: true,
        members: [member('local', 'local', null, 'a-local')],
      },
    } as Record<string, unknown>,
    byDevice: {
      // Studio 把 c-open 建成了组：Studio 自己与 Laptop。
      'device-c': [
        provider('c-open', 'C Open', 'studio@x', {
          remoteInvocationEnabled: true,
          group: {
            strategy: 'least',
            autoSwitch: true,
            members: [member('local', 'local', null, 'c-open'), member('device:device-d:d-open', 'device', 'device-d', 'd-open')],
          },
        }),
      ],
      'device-d': [
        provider('d-open', 'D Open', 'laptop@x', { remoteInvocationEnabled: true }),
        // 不在组里的供应商照常单独列出。
        provider('d-solo', 'D Solo', 'solo@x', { remoteInvocationEnabled: true }),
      ],
    } as Record<string, unknown[]>,
    // 每台电脑这个账号的周限已用百分比。
    weeklyUsed: { 'device-c': 99, 'device-d': 60, local: 30 } as Record<string, number>,
  };
});

const claude = (used: number) => ({
  subscriptionType: 'max',
  sevenDay: { utilization: used, resetsAt: Date.now() / 1000 + 86400 },
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
  ensureProviderShareReceivedStarted: vi.fn(),
  requestProviderShareFavoriteRegions: vi.fn(),
  useProviderShareReceived: () => ({ received: [], loaded: true }),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));
vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({ useCodexRateLimits: () => ({ snapshot: null }) }));
vi.mock('@/hooks/useAccountUsage', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useAccountUsage')>()),
  useAccountUsage: () => null,
}));
vi.mock('@/hooks/useXaiSubscriptionUsage', () => ({ useXaiSubscriptionUsage: () => null }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  useClaudeSubscriptionUsage: (enabled: boolean) => (enabled ? claude(catalogs.weeklyUsed.local!) : null),
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: (deviceId: string | null) =>
    deviceId && catalogs.weeklyUsed[deviceId] !== undefined ? claude(catalogs.weeklyUsed[deviceId]!) : null,
}));

import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import { __resetForTest as resetFavorites } from '@/state/modelFavorites';

const devices = [
  { deviceId: 'device-c', name: 'Studio' },
  { deviceId: 'device-d', name: 'Laptop' },
];
const GROUP = 'C Open · Studio · 供应商组 · 2 台电脑';

function renderTask(route: { deviceId: string | null; providerId: string }, taskStarted: boolean) {
  render(
    React.createElement(ModelSelectorContent, {
      modelId: 'opus',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: route.providerId,
      onProviderChange: vi.fn(),
      actualRoute: true,
      taskStarted,
      vendorKey: 'cc',
      remoteAgent: {
        devices,
        selectedDeviceId: route.deviceId,
        selfDeviceId: 'desk',
        onRelocate: vi.fn(async () => true),
      },
    }),
  );
}

const railButton = (name: string) => screen.getByRole('button', { name });
const remaining = (button: HTMLElement) =>
  button.querySelector('[data-weekly-remaining]')?.getAttribute('data-weekly-remaining') ?? null;

beforeEach(() => {
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
});

describe('模型列表里供应商组那一项的用量', () => {
  it('远控任务的普通供应商读任务所在电脑，浏览其它电脑后仍保持归属', async () => {
    render(
      <ModelSelectorContent
        modelId="opus"
        effort="high"
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        currentProviderId="d-solo"
        onProviderChange={vi.fn()}
        vendorKey="cc"
        remoteAgent={{
          devices: [devices[0]!],
          selectedDeviceId: null,
          selfDeviceId: 'desk',
          homeDeviceId: 'device-d',
        }}
      />,
    );
    const solo = railButton('D Solo · solo@x');
    expect(remaining(solo)).toBe('40');
    expect(solo.getAttribute('aria-description')).toBe('周限 · 剩余 40%');
    await act(async () => {
      fireEvent.click(railButton(GROUP));
    });
    expect(remaining(railButton('D Solo · solo@x'))).toBe('40');
  });

  it('任务正经组在另一台运行：读那台的账号并写明在哪台', () => {
    renderTask({ deviceId: 'device-d', providerId: 'd-open' }, true);
    const group = railButton(GROUP);
    expect(remaining(group)).toBe('40');
    expect(group.getAttribute('aria-description')).toBe('当前在 Laptop 上运行 · laptop@x · 周限 · 剩余 40%');
    // 组名不再带组所在电脑那一个账号。
    expect(group.getAttribute('aria-label')).not.toContain('studio@x');
  });

  it('任务运行在组所在电脑本身：读组所在电脑的账号', () => {
    renderTask({ deviceId: 'device-c', providerId: 'c-open' }, true);
    const group = railButton(GROUP);
    expect(remaining(group)).toBe('1');
    expect(group.getAttribute('aria-description')).toBe('当前在 Studio 上运行 · studio@x · 周限 · 剩余 1%');
  });

  it('还没运行过的任务：不显示某一台的配额', async () => {
    renderTask({ deviceId: 'device-c', providerId: 'c-open' }, false);
    const group = railButton(GROUP);
    expect(remaining(group)).toBeNull();
    expect(group.getAttribute('aria-description')).toBe('开始后由供应商组选一台电脑，用量按那台显示');
    // 浏览组的目录时，模型行也不拿组所在电脑的配额。
    await act(async () => {
      fireEvent.click(group);
    });
    expect(screen.getByRole('listbox').textContent).not.toContain('剩余 1%');
  });

  it('本机建的组：任务在本机运行时读本机账号', () => {
    renderTask({ deviceId: null, providerId: 'a-local' }, true);
    const group = railButton('A Local · 供应商组 · 1 台电脑');
    expect(remaining(group)).toBe('70');
    expect(group.getAttribute('aria-description')).toBe('当前在这台电脑上运行 · me@desk · 周限 · 剩余 70%');
  });

  it('不是组的供应商照旧按自己的账号显示，组员收进组那一项', () => {
    renderTask({ deviceId: 'device-d', providerId: 'd-open' }, true);
    expect(screen.queryByRole('button', { name: /^D Open · Laptop/ })).toBeNull();
    const solo = railButton('D Solo · Laptop · solo@x');
    expect(remaining(solo)).toBe('40');
    expect(solo.getAttribute('aria-description')).toBe('周限 · 剩余 40%');
  });

  it('读到任务归哪个组时，别的组那一项不认这台', async () => {
    // 本机的组也收了 Laptop：任务归的是 Studio 的组。
    catalogs.localGroups['a-local'] = {
      strategy: 'least',
      autoSwitch: true,
      members: [
        { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'a-local', limit: 4, weight: 1, paused: false },
        { key: 'device:device-d:d-open', kind: 'device', agentDeviceId: 'device-d', providerId: 'd-open', limit: 4, weight: 1, paused: false },
      ],
    };
    try {
      render(
        React.createElement(ModelSelectorContent, {
          modelId: 'opus',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          currentProviderId: 'd-open',
          onProviderChange: vi.fn(),
          actualRoute: true,
          taskStarted: true,
          vendorKey: 'cc',
          remoteAgent: {
            devices,
            selectedDeviceId: 'device-d',
            selfDeviceId: 'desk',
            readProviderGroup: async () => ({ deviceId: 'device-c', providerId: 'c-open' }),
            onRelocate: vi.fn(async () => true),
          },
        }),
      );
      await act(async () => {});
      expect(railButton(GROUP).getAttribute('aria-description')).toBe('当前在 Laptop 上运行 · laptop@x · 周限 · 剩余 40%');
      // 面板停在 Studio 的组那一项上，左栏本机那一格照样带台数。
      const local = railButton('A Local · 供应商组 · 2 台电脑');
      expect(remaining(local)).toBeNull();
      expect(local.getAttribute('aria-description')).toBe('开始后由供应商组选一台电脑，用量按那台显示');
    } finally {
      catalogs.localGroups['a-local'] = {
        strategy: 'least',
        autoSwitch: true,
        members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'a-local', limit: 4, weight: 1, paused: false }],
      };
    }
  });
});
