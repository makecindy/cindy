// @vitest-environment jsdom
/**
 * 任务正跑在供应商组里的某台电脑上时，模型列表把那台聚合在组那一项下(provider-groups.md §10，
 * 2026-10-11 用户反馈：组把任务换到 grok-bot-vm 后，那台在模型列表里单独出现、还被选中，分不清)。
 *
 * 场景：Mac Mini 把 Anthropic 建成了组(Mac Mini 自己 + grok-bot-vm)，任务被组分到 grok-bot-vm 上运行。
 *   1. 归组的任务：grok-bot-vm 的 Anthropic 不单独出现，打开停在组那一项，当前模型显示为选中；在组那一项里
 *      选模型 = 留在 grok-bot-vm 只换模型(带那台上的供应商 id)，不把 Agent 挪到 Mac Mini；
 *   2. 没归组、只是直接用着那台的任务：同样收进组里，但组那一项不显示为正在用，选它照旧是挪过去；
 *   3. 组所在电脑离线(组那一项不在)：那台照常单独显示、照常选中；
 *   4. 归组的任务就在这台电脑上运行：打开同样先停在组那一项，在里面选模型留在这台。
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
        'newChat.modelSelector.unified.railRemoteProviderGroup': `${o.provider} · ${o.device} · ${o.group}`,
        'newChat.modelSelector.unified.providerGroupLabel': `${o.provider} · ${o.group}`,
        'settings.providers.remote.groupBadge': `供应商组 · ${o.count} 台电脑`,
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
  const models = [['opus', 'Opus'], ['sonnet', 'Sonnet']] as const;
  const provider = (
    id: string,
    name: string,
    rows: readonly (readonly [string, string])[],
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
      'claude-code': rows.map(([modelId, modelName]) => ({
        id: modelId,
        name: modelName,
        contextWindow: 200000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      })),
    },
    ...extra,
  });
  const member = (key: string, kind: string, agentDeviceId: string | null, providerId: string) => ({
    key, kind, agentDeviceId, providerId, paused: false,
  });
  return {
    offline: new Set<string>(),
    local: [provider('anthropic-local', 'Anthropic Local', models)] as unknown[],
    byDevice: {
      mini: [
        provider('anthropic', 'Anthropic', models, {
          remoteInvocationEnabled: true,
          group: {
            strategy: 'least',
            autoSwitch: true,
            members: [
              member('local', 'local', null, 'anthropic'),
              // 第二个订阅账号：那台上的供应商 id 带随机后缀。
              member('device:vm:anthropic-9z', 'device', 'vm', 'anthropic-9z'),
              member('device:desk:anthropic-local', 'device', 'desk', 'anthropic-local'),
            ],
          },
        }),
      ],
      vm: [
        provider('anthropic-9z', 'Anthropic', models, { remoteInvocationEnabled: true }),
        provider('fp', 'FP', [['fp-model', 'FP Model']], { remoteInvocationEnabled: true }),
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
      : { providers: deviceId ? (catalogs.byDevice[deviceId] ?? []) : [], loading: false, error: null, unsupported: false },
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (deviceIds: readonly string[]) =>
    new Map(
      deviceIds.flatMap((deviceId) =>
        catalogs.offline.has(deviceId)
          ? []
          : [[deviceId, { providers: catalogs.byDevice[deviceId] ?? [], loading: false, error: null }] as const],
      ),
    ),
}));
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({
  useLocalProviderGroups: () => ({}),
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
  { deviceId: 'mini', name: 'Mac Mini' },
  { deviceId: 'vm', name: 'grok-bot-vm' },
];
const GROUP = 'Anthropic · Mac Mini · 供应商组 · 3 台电脑';

async function renderTask(options: {
  bound: boolean;
  selectedDeviceId?: string | null;
  currentProviderId?: string;
}) {
  const onRelocate = vi.fn(async () => true);
  const onProviderChange = vi.fn();
  const readProviderGroup = vi.fn(async () => (options.bound ? { deviceId: 'mini', providerId: 'anthropic' } : null));
  render(
    React.createElement(ModelSelectorContent, {
      modelId: 'opus',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: options.currentProviderId ?? 'anthropic-9z',
      onProviderChange,
      actualRoute: true,
      vendorKey: 'cc',
      remoteAgent: {
        devices,
        selectedDeviceId: options.selectedDeviceId === undefined ? 'vm' : options.selectedDeviceId,
        onRelocate,
        readProviderGroup,
      },
    }),
  );
  // 等「这个任务归哪个组」读回来。
  await act(async () => {});
  return { onRelocate, onProviderChange, readProviderGroup };
}

const list = () => screen.getByRole('listbox');
const row = (name: string) => within(list()).getByText(name).closest('[role="option"]') as HTMLElement;

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

beforeEach(() => {
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
  catalogs.offline.clear();
});

describe('任务正跑在组里的某台电脑上', () => {
  it('归组的任务：那台收进组里，打开停在组那一项并选中当前模型', async () => {
    await renderTask({ bound: true });
    expect(screen.queryByRole('button', { name: 'Anthropic · grok-bot-vm' })).toBeNull();
    // 那台电脑上不在组里的供应商照常列出。
    expect(screen.getByRole('button', { name: 'FP · grok-bot-vm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: GROUP }).getAttribute('aria-pressed')).toBe('true');
    expect(row('Opus').getAttribute('aria-selected')).toBe('true');
    expect(row('Sonnet').getAttribute('aria-selected')).toBe('false');
  });

  it('归组的任务：在组那一项里选模型，留在 grok-bot-vm 只换模型', async () => {
    const { onRelocate } = await renderTask({ bound: true });
    await click(row('Sonnet'));
    expect(onRelocate).toHaveBeenCalledTimes(1);
    expect(onRelocate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic-9z',
        modelId: 'sonnet',
        agent: 'claude-code',
        agentDevice: { deviceId: 'vm', name: 'grok-bot-vm' },
      }),
    );
  });

  it('归组的任务：选那台电脑上组外的供应商，照旧在那台换来源', async () => {
    const { onRelocate, onProviderChange } = await renderTask({ bound: true });
    await click(screen.getByRole('button', { name: 'FP · grok-bot-vm' }));
    await click(row('FP Model'));
    expect(onRelocate).not.toHaveBeenCalled();
    expect(onProviderChange).toHaveBeenCalledWith('fp', 'fp-model', expect.anything(), expect.anything());
  });

  it('没归组的任务：那台同样收进组里，但组那一项不显示为正在用，选它是把 Agent 挪到组所在电脑', async () => {
    const { onRelocate } = await renderTask({ bound: false });
    expect(screen.queryByRole('button', { name: 'Anthropic · grok-bot-vm' })).toBeNull();
    expect(screen.getByRole('button', { name: GROUP }).getAttribute('aria-pressed')).toBe('true');
    expect(row('Opus').getAttribute('aria-selected')).toBe('false');
    await click(row('Sonnet'));
    expect(onRelocate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'anthropic', modelId: 'sonnet', agentDevice: { deviceId: 'mini', name: 'Mac Mini' } }),
    );
  });

  it('组所在电脑离线：那台照常单独显示并选中', async () => {
    catalogs.offline.add('mini');
    const { onRelocate } = await renderTask({ bound: true });
    expect(screen.queryByRole('button', { name: GROUP })).toBeNull();
    expect(screen.getByRole('button', { name: 'Anthropic · grok-bot-vm' }).getAttribute('aria-pressed')).toBe('true');
    expect(row('Opus').getAttribute('aria-selected')).toBe('true');
    expect(onRelocate).not.toHaveBeenCalled();
  });

  it('归组的任务就在这台电脑上运行：打开停在组那一项，在里面选模型留在这台', async () => {
    const { onRelocate } = await renderTask({ bound: true, selectedDeviceId: null, currentProviderId: 'anthropic-local' });
    expect(screen.getByRole('button', { name: GROUP }).getAttribute('aria-pressed')).toBe('true');
    expect(row('Opus').getAttribute('aria-selected')).toBe('true');
    await click(row('Sonnet'));
    expect(onRelocate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'anthropic-local', modelId: 'sonnet', agentDevice: null }),
    );
  });
});
