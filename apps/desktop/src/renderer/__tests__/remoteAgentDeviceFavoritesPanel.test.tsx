// @vitest-environment jsdom
/**
 * 收藏另一台电脑上的模型(远程 Agent),用起来与本机收藏一样(model-selector-unified §1.5「远程收藏按
 * 被控电脑共享」):
 *   1. 浏览那台电脑的目录时点 ☆:写进任务所在电脑那一份收藏(运行位置编进 providerId),不读写那台
 *      电脑自己的收藏;
 *   2. 回到任务所在电脑的目录,收藏区照样列出它,来源名带那台电脑;选中 = 在那台电脑上运行;
 *   3. 那台的目录读不到时置灰列出;目录里已没有这个模型时不显示,收藏保留;
 *   4. 被控电脑上的任务:收藏读写被控电脑那一份(经设备互联)。
 */
import type { ModelSelectorContentBaseProps } from '../components/new-chat/ModelSelector';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  agentDeviceFavoriteSource,
  MODEL_FAVORITES_APPLY,
  MODEL_FAVORITES_GET,
  type ModelFavoriteMutation,
  type RemoteModelFavorite,
} from '@cindy/device-link';

// The shared-quota rail observes auth; this component fixture has no auth host.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null, useOptionalAuthDeviceId: () => null }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const table: Record<string, string> = {
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.unified.favoritesGroup': '收藏',
        'newChat.modelSelector.unified.addFavorite': '收藏',
        'newChat.modelSelector.unified.removeFavorite': '取消收藏',
        'newChat.modelSelector.unified.customize': '自定义',
        'newChat.modelSelector.unified.railAll': '全部',
        'newChat.modelSelector.unified.railRemoteProvider': `${options?.provider ?? ''} · ${options?.device ?? ''}`,
        'newChat.modelSelector.unified.remoteFavoriteUnavailable': `${options?.source ?? ''} · 读不到`,
        'newChat.modelSelector.unified.railRemoteProviderGroup': `${options?.provider ?? ''} · ${options?.device ?? ''} · ${options?.group ?? ''}`,
        'settings.providers.remote.groupBadge': `供应商组 · ${options?.count ?? ''} 台电脑`,
        'settings.providers.xd.title': 'Cindy AI',
        'modelDescriptions.writingAndCoding': '用于内容写作、编程与问题分析。',
        'effortLevels.low': '低',
        'effortLevels.high': '高',
      };
      return table[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));
const pluginLocations = vi.hoisted(() => ({ devices: [] as { deviceId: string; name: string }[] }));
vi.mock('@/hooks/useModelRouteDevices', () => ({
  useModelRouteDevices: ({ leadAgentDeviceId }: { leadAgentDeviceId?: string | null }) => ({
    devices: pluginLocations.devices,
    leadAgentDeviceId: leadAgentDeviceId ?? null,
  }),
}));
vi.mock('@/hooks/useAvailableAgents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAvailableAgents')>()),
  useModelPickerAgents: () => ['claude-code'],
}));

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
    offline: new Set<string>(),
    local: [provider('a-local', 'A Local', [['a-model', 'A Model']])] as unknown[],
    byDevice: {
      'device-b': [provider('b-main', 'B Main', [['b-model', 'B Model']])],
      'device-c': [
        provider('c-open', 'C Open', [['c-model', 'C Model']], { remoteInvocationEnabled: true }),
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
import { PluginModelPickerDialog } from '@/cindy-brain/PluginModelPickerHost';
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import {
  __resetForTest as resetFavorites,
  addModelFavorite,
  listModelFavorites,
  setModelFavoritesOwner,
} from '@/state/modelFavorites';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { providerShareFavoriteSource, reconcileProviderShareFavorites } from '@/state/providerShareFavorites';
import { resetProviderShareStoreForTests } from '@/features/provider-share/providerShareStore';
import type { ProviderShareCommand } from '../../shared/providerShare';

const devices = [{ deviceId: 'device-c', name: 'Studio' }];
const C_SOURCE = agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'c-open' });

/** 设备互联:被控电脑 device-b 上的一份收藏(其他电脑的读写都记下来,应当一次都没有)。 */
let remoteLists: Record<string, RemoteModelFavorite[]>;
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetEnginePrefs();
  resetFavorites();
  catalogs.offline.clear();
  setDataOwnerGeneration(null, 0);
  remoteLists = { 'device-b': [] };
  let seq = 1;
  invoke = vi.fn(async (deviceId: string, channel: string, args: unknown[]) => {
    const list = remoteLists[deviceId];
    if (!list) throw new Error('no favorites on this device');
    if (channel === MODEL_FAVORITES_GET) return list;
    if (channel === MODEL_FAVORITES_APPLY) {
      const mutation = args[0] as ModelFavoriteMutation;
      if (mutation.kind === 'add') list.push({ uid: `fav-${seq++}`, ...mutation.item });
      if (mutation.kind === 'update') {
        const index = list.findIndex((item) => item.uid === mutation.expected.uid);
        if (index < 0 || JSON.stringify(list[index]) !== JSON.stringify(mutation.expected))
          throw new Error('stale favorite');
        list[index] = { uid: mutation.expected.uid, ...mutation.item };
      }
      if (mutation.kind === 'remove')
        remoteLists[deviceId] = list.filter((item) => item.uid !== mutation.expected.uid);
      return remoteLists[deviceId];
    }
    throw new Error(`unexpected ${channel}`);
  });
  vi.stubGlobal('electronAPI', {
    deviceLink: {
      invoke,
      onRemotePush: () => () => {},
      onStatusChanged: () => () => {},
      onPeerLinkReset: () => () => {},
      onResponsivenessChanged: () => () => {},
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setDataOwnerGeneration(null, 0);
});

const list = () => screen.getByRole('listbox');
const favoritesGroup = () => within(list()).getByRole('group', { name: '收藏' });
const rowOf = (scope: HTMLElement, name: string) =>
  within(scope).getByText(name).closest('[data-unified-anchor]') as HTMLElement;

function renderPanel(
  remoteAgent: Partial<React.ComponentProps<typeof ModelSelectorContent>['remoteAgent']> = {},
  props: Partial<ModelSelectorContentBaseProps> = {},
) {
  const onUnifiedSelect = vi.fn(async () => true);
  const onRelocate = vi.fn(async () => true);
  const onProviderChange = vi.fn();
  render(
    React.createElement(ModelSelectorContent, {
      modelId: 'a-model',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'a-local',
      onProviderChange,
      vendorKey: 'cc',
      onUnifiedSelect,
      remoteAgent: { devices, selectedDeviceId: null, ...remoteAgent },
      ...props,
    }),
  );
  return { onUnifiedSelect, onRelocate, onProviderChange };
}

describe('本机任务:收藏另一台电脑上的模型', () => {
  it('浏览那台电脑时点 ☆ 写进本机收藏,不读写那台电脑自己的收藏', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'C Open · Studio' }));
    });
    const row = rowOf(list(), 'C Model');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: '收藏' }));
    });
    expect(listModelFavorites()).toEqual([
      expect.objectContaining({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' }),
    ]);
    // 那台电脑的视图里照样列出这条收藏(还原成那台的真实 providerId)。
    expect(within(favoritesGroup()).getByText('C Model')).toBeTruthy();
    expect(invoke.mock.calls.some(([deviceId]) => deviceId === 'device-c')).toBe(false);
  });

  it('回到本机目录:收藏区列出它并带上电脑名,选中 = 在那台电脑运行', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc', effort: 'low' });
    const uid = listModelFavorites()[0]!.uid;
    const { onUnifiedSelect, onProviderChange } = renderPanel();
    const row = rowOf(favoritesGroup(), 'C Model');
    expect(within(row).getByText('C Open · Studio')).toBeTruthy();
    // 配置在那台电脑的目录里调,这里不出配置浮层。
    expect(within(row).queryByRole('button', { name: '自定义' })).toBeNull();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(onUnifiedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'c-open',
        modelId: 'c-model',
        engine: 'cc',
        effort: 'low',
        favoriteUid: uid,
        agentDevice: { deviceId: 'device-c', name: 'Studio' },
      }),
    );
    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('在本机目录里取消这条收藏', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    renderPanel();
    const row = rowOf(favoritesGroup(), 'C Model');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: '取消收藏' }));
    });
    expect(listModelFavorites()).toEqual([]);
  });

  it('已建任务:Agent 在本机时选中它 = 连运行位置一起换到那台电脑', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    const onRelocate = vi.fn(async () => true);
    const { onProviderChange } = renderPanel(
      { onRelocate },
      { actualRoute: true, onUnifiedSelect: undefined },
    );
    await act(async () => {
      fireEvent.click(rowOf(favoritesGroup(), 'C Model'));
    });
    expect(onRelocate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'c-open',
        modelId: 'c-model',
        agent: 'claude-code',
        agentDevice: { deviceId: 'device-c', name: 'Studio' },
      }),
    );
    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('已建任务:Agent 已在那台电脑时切到那台的目录,由那里的会话链路选', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    const onRelocate = vi.fn(async () => true);
    renderPanel(
      { onRelocate, selectedDeviceId: 'device-c' },
      {
        actualRoute: true,
        onUnifiedSelect: undefined,
        modelId: 'c-model',
        currentProviderId: 'c-open',
      },
    );
    // 打开时停在那台的目录;切回本机目录(「全部」视图,按本机供应商筛的格不列其他电脑的收藏)。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    await act(async () => {
      fireEvent.click(rowOf(favoritesGroup(), 'C Model'));
    });
    expect(onRelocate).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'C Open · Studio' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(favoritesGroup()).getByText('C Model')).toBeTruthy();
  });

  it('那台的目录读不到:置灰列出;目录里已没有这个模型:不显示,收藏保留', async () => {
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    addModelFavorite({
      providerId: agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'c-open' }),
      modelId: 'gone-model',
      agent: 'cc',
    });
    catalogs.offline.add('device-c');
    const { onUnifiedSelect } = renderPanel();
    const row = rowOf(favoritesGroup(), 'c-model');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(within(row).getByText('c-open · Studio · 读不到')).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(onUnifiedSelect).not.toHaveBeenCalled();
    cleanup();

    catalogs.offline.clear();
    renderPanel();
    expect(within(favoritesGroup()).getByText('C Model')).toBeTruthy();
    expect(within(list()).queryByText('gone-model')).toBeNull();
    expect(listModelFavorites()).toHaveLength(2);
  });
});

describe('被控电脑上的任务:收藏读写被控电脑那一份', () => {
  it('浏览第三台电脑时点 ☆ 经设备互联写进被控电脑的收藏,回到被控电脑目录照样列出', async () => {
    renderPanel(
      { homeDeviceId: 'device-b' },
      { deviceId: 'device-b', modelId: 'b-model', currentProviderId: 'b-main' },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'C Open · Studio' }));
    });
    const row = rowOf(list(), 'C Model');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: '收藏' }));
    });
    expect(invoke).toHaveBeenCalledWith('device-b', MODEL_FAVORITES_APPLY, [
      {
        kind: 'add',
        item: expect.objectContaining({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' }),
      },
    ]);
    expect(invoke.mock.calls.some(([deviceId]) => deviceId === 'device-c')).toBe(false);
    // 本机自己的收藏不动。
    expect(listModelFavorites()).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    expect(within(favoritesGroup()).getByText('C Model')).toBeTruthy();
  });

  it('远程控制(不经远程 Agent)照旧读被控电脑自己的收藏', async () => {
    remoteLists['device-b'] = [
      { uid: 'fav-9', providerId: 'b-main', modelId: 'b-model', agent: 'cc' },
    ];
    render(
      React.createElement(ModelSelectorContent, {
        remoteAgent: undefined,
        modelId: 'b-model',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'b-main',
        onProviderChange: vi.fn(),
        vendorKey: 'cc',
        deviceId: 'device-b',
      }),
    );
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('device-b', MODEL_FAVORITES_GET, []);
    expect(within(favoritesGroup()).getByText('B Model')).toBeTruthy();
  });
});

// PR #8460 / unit: request-local favorites previously bypassed source projections.
// Ordinary persisted favorites did not cover that branch. Mount the real plugin dialog,
// star a remote model, revisit an aggregate view and confirm its execution location.
describe('插件临时收藏保留执行来源', () => {
  it.each([
    { source: 'device', rail: 'all', namesake: true },
    { source: 'device', rail: 'favorites', namesake: false },
    { source: 'share', rail: 'all', namesake: true },
    { source: 'share', rail: 'favorites', namesake: false },
  ])('$source / $rail / local namesake=$namesake', async ({ source, rail, namesake }) => {
    setDataOwnerGeneration('recipient', 1);
    setModelFavoritesOwner('recipient');
    const share = {
      shareId: 'temporary', memberId: 'member-temporary', providerId: 'a-local', providerLabel: 'A Local',
      hostDeviceId: 'host', deviceName: 'Host', status: 'active' as const, hostOnline: true, hostCapable: true,
      owner: { displayName: 'Shared', avatarUrl: null, region: 'global' as const },
    };
    reconcileProviderShareFavorites({
      received: source === 'share' ? [share] : [], confirmedRegions: ['global'],
      ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 1 },
    });
    const deviceId = source === 'share' ? 'share:temporary' : 'device-temporary';
    const modelId = namesake ? 'a-model' : 'remote-only';
    // 自己的另一台电脑上有同名供应商时左栏只列一处：这里是用户把它改成「运行于」那台。
    if (source === 'device') {
      const local = catalogs.local[0];
      catalogs.local[0] = { ...(local as object), runLocation: deviceId };
      onTestFinished(() => { catalogs.local[0] = local; });
    }
    pluginLocations.devices = [{ deviceId, name: 'Temporary source' }];
    catalogs.byDevice[deviceId] = [{
      ...(catalogs.local[0] as object), remoteInvocationEnabled: true,
      models: { 'claude-code': [{ id: modelId, name: 'Temporary Remote Model', efforts: ['low', 'high'], defaultEffort: 'high' }] },
    }];
    const baseline = listModelFavorites();
    const onAnswer = vi.fn(async () => ({ handled: true, accepted: true }));
    const { unmount } = render(<PluginModelPickerDialog request={{
      requestId: 'temporary-favorite', ghostId: 'plugin', ghostName: 'Plugin', allowRemote: true,
      expiresAt: Date.now() + 90_000,
      initial: { agentKind: 'cc', providerId: 'a-local', model: 'a-model', effort: 'high', fastMode: false },
    }} onAnswer={onAnswer} />);
    await act(async () => fireEvent.click(document.querySelector(`[data-rail-item="remote:${deviceId}:a-local"]`)!));
    await act(async () => fireEvent.click(within(rowOf(list(), 'Temporary Remote Model')).getByRole('button', { name: '收藏' })));
    await act(async () => fireEvent.click(document.querySelector(`[data-rail-item="${rail}"]`)!));
    await act(async () => fireEvent.click(rowOf(favoritesGroup(), 'Temporary Remote Model')));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.modelPicker.useConfiguration' })));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentDeviceId: deviceId, providerId: 'a-local', model: modelId, agentKind: 'cc',
    }));
    unmount();
    expect(listModelFavorites()).toEqual(baseline);
    expect(invoke.mock.calls.some(([, channel]) => channel === MODEL_FAVORITES_APPLY)).toBe(false);
  });
});

describe('收藏 / 全部聚合来源，供应商只筛自己的收藏', () => {
  const share = (id: string) => ({
    shareId: id, memberId: `member-${id}`, providerId: 'a-local', providerLabel: 'A Local',
    hostDeviceId: 'host', deviceName: 'Host', status: 'active' as const, hostOnline: true, hostCapable: true,
    owner: { displayName: id, avatarUrl: null, region: 'global' as const },
  });
  const shares = [share('one'), share('two')];
  const allDevices = [...devices, ...shares.map((s) => ({ deviceId: `share:${s.shareId}`, name: s.shareId }))];
  const publish = (received = shares) => reconcileProviderShareFavorites({
    received, confirmedRegions: ['global'], ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 1 },
  });
  const clickRail = async (key: string) => {
    await act(async () => fireEvent.click(document.querySelector(`[data-rail-item="${key}"]`)!));
  };
  const favoriteNames = () => [...favoritesGroup().querySelectorAll('[data-unified-anchor]')]
    .map((row) => row.textContent);

  beforeEach(() => {
    setDataOwnerGeneration('recipient', 1);
    setModelFavoritesOwner('recipient');
    publish();
    for (const s of shares) {
      catalogs.byDevice[`share:${s.shareId}`] = [{
        ...(catalogs.local[0] as object), remoteInvocationEnabled: true,
        models: { 'claude-code': [{ id: 'a-model', name: `Shared ${s.shareId}`, efforts: ['low', 'high'], defaultEffort: 'high' }] },
      }];
    }
    addModelFavorite({ providerId: 'a-local', modelId: 'a-model', agent: 'cc' });
    addModelFavorite({ providerId: C_SOURCE, modelId: 'c-model', agent: 'cc' });
    for (const s of shares) addModelFavorite({
      providerId: providerShareFavoriteSource(s), modelId: 'a-model', agent: 'cc', effort: 'low',
    });
  });

  it('从任一来源反复切回收藏 / 全部，四份收藏顺序稳定；同名连接不串收藏', async () => {
    renderPanel({ devices: allDevices });
    const initial = favoriteNames();
    expect(initial).toHaveLength(4);
    for (const [rail, name] of [
      ['remote:share:one:a-local', 'Shared one'],
      ['remote:device-c:c-open', 'C Model'],
      ['provider:a-local', 'A Model'],
      ['remote:share:two:a-local', 'Shared two'],
    ]) {
      await clickRail(rail!);
      expect(favoriteNames()).toHaveLength(1);
      expect(within(favoritesGroup()).getByText(name!)).toBeTruthy();
      await clickRail('favorites');
      expect(favoriteNames()).toEqual(initial);
      await clickRail('all');
      expect(favoriteNames()).toEqual(initial);
    }
    expect(listModelFavorites()).toHaveLength(4);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('聚合收藏选择保留分享路由和配置，取消只删除对应副本', async () => {
    const { onUnifiedSelect } = renderPanel({ devices: allDevices });
    await clickRail('favorites');
    const row = rowOf(favoritesGroup(), 'Shared one');
    await act(async () => fireEvent.click(row));
    expect(onUnifiedSelect).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'a-local', modelId: 'a-model', engine: 'cc', effort: 'low',
      agentDevice: { deviceId: 'share:one', name: 'one' },
    }));
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: '取消收藏' })));
    expect(listModelFavorites().map((item) => item.providerId)).toEqual([
      'a-local', C_SOURCE, providerShareFavoriteSource(shares[1]!),
    ]);
    await clickRail('remote:share:one:a-local');
    expect(within(list()).queryByRole('group', { name: '收藏' })).toBeNull();
  });

  it('分享下线或授权变化后，缓存目录不能把旧收藏重新显示出来', async () => {
    renderPanel({ devices: allDevices });
    await act(async () => publish([{ ...shares[0]!, hostOnline: false }, shares[1]!]));
    expect(within(favoritesGroup()).queryByText('Shared one')).toBeNull();
    expect(listModelFavorites()).toHaveLength(4);
    await act(async () => publish());
    expect(within(favoritesGroup()).getByText('Shared one')).toBeTruthy();
    await act(async () => publish([{ ...shares[0]!, memberId: 'new-member' }, shares[1]!]));
    expect(within(favoritesGroup()).queryByText('Shared one')).toBeNull();
    expect(within(favoritesGroup()).getByText('A Model')).toBeTruthy();
  });

  it('被控任务浏览分享时，收藏增删仍写被控电脑；控制端收藏保持原样', async () => {
    const controllerItems = listModelFavorites();
    remoteLists['device-b'] = [{ uid: 'home-fav', providerId: 'b-main', modelId: 'b-model', agent: 'cc' }];
    renderPanel({ devices: allDevices, homeDeviceId: 'device-b' }, {
      deviceId: 'device-b', modelId: 'b-model', currentProviderId: 'b-main',
    });
    await clickRail('remote:share:one:a-local');
    expect(within(list()).queryByRole('group', { name: '收藏' })).toBeNull();
    await act(async () => fireEvent.click(within(rowOf(list(), 'Shared one')).getByRole('button', { name: '收藏' })));
    expect(remoteLists['device-b']).toHaveLength(2);
    expect(remoteLists['device-b']![1]!.providerId).toBe(providerShareFavoriteSource(shares[0]!));
    await clickRail('favorites');
    expect(favoriteNames()).toHaveLength(2);
    expect(within(favoritesGroup()).getByText('B Model')).toBeTruthy();
    await act(async () => fireEvent.click(within(rowOf(favoritesGroup(), 'Shared one')).getByRole('button', { name: '取消收藏' })));
    expect(remoteLists['device-b']).toHaveLength(1);
    expect(listModelFavorites()).toEqual(controllerItems);
    expect(invoke.mock.calls.every(([deviceId]) => deviceId === 'device-b')).toBe(true);
  });

  it('被控任务在分享里改收藏配置：按原副本条件更新被控电脑，重读后生效', async () => {
    const controllerItems = listModelFavorites();
    const source = providerShareFavoriteSource(shares[0]!);
    const before = { uid: 'home-share', providerId: source, modelId: 'a-model', agent: 'cc' as const, effort: 'low' };
    remoteLists['device-b'] = [before];
    renderPanel({ devices: allDevices, homeDeviceId: 'device-b' }, {
      deviceId: 'device-b', modelId: 'b-model', currentProviderId: 'b-main',
    });
    await clickRail('remote:share:one:a-local');
    const row = () => rowOf(favoritesGroup(), 'Shared one');
    expect(row().querySelector('[data-unified-triple]')?.textContent).toContain('低');
    await act(async () => fireEvent.click(within(row()).getByRole('button', { name: '自定义' })));
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, { key: 'ArrowRight' });
    });
    expect(invoke).toHaveBeenCalledWith('device-b', MODEL_FAVORITES_APPLY, [{
      kind: 'update',
      expected: before,
      item: expect.objectContaining({ providerId: source, modelId: 'a-model', agent: 'cc', effort: 'high' }),
    }]);
    expect(remoteLists['device-b']).toEqual([expect.objectContaining({ uid: 'home-share', providerId: source, effort: 'high' })]);
    // 重读被控电脑的列表后，同一行按新配置显示；控制端收藏不动。
    expect(invoke.mock.calls.filter(([, channel]) => channel === MODEL_FAVORITES_GET).length).toBeGreaterThan(1);
    expect(row().querySelector('[data-unified-triple]')?.textContent).toContain('高');
    expect(listModelFavorites()).toEqual(controllerItems);
    expect(invoke.mock.calls.every(([deviceId]) => deviceId === 'device-b')).toBe(true);
  });

  it('被控电脑收藏了控制端没加载过的跨区分享：按它的区域恢复授权后照常列出', async () => {
    resetProviderShareStoreForTests();
    const cn = { ...share('three'), owner: { displayName: 'three', avatarUrl: null, region: 'cn' as const } };
    catalogs.byDevice['share:three'] = [{
      ...(catalogs.local[0] as object), remoteInvocationEnabled: true,
      models: { 'claude-code': [{ id: 'a-model', name: 'Shared three', efforts: ['low', 'high'], defaultEffort: 'high' }] },
    }];
    remoteLists['device-b'] = [{ uid: 'home-cn', providerId: providerShareFavoriteSource(cn), modelId: 'a-model', agent: 'cc' }];
    const command = vi.fn(async (request: ProviderShareCommand) => {
      if (request.action !== 'received-snapshot') return shares;
      // Main 只为线索里的区域加载跨区名单；控制端本机收藏只有 global。
      const withCn = request.favoriteRecovery?.regions.includes('cn') ?? false;
      return {
        ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 1 },
        confirmedRegions: withCn ? ['global', 'cn'] : ['global'],
        received: withCn ? [...shares, cn] : shares,
      };
    });
    vi.stubGlobal('electronAPI', {
      ...(window as unknown as { electronAPI: object }).electronAPI,
      providerShare: { command, onReceivedChanged: () => () => {} },
    });
    renderPanel({ devices: [...allDevices, { deviceId: 'share:three', name: 'three' }], homeDeviceId: 'device-b' }, {
      deviceId: 'device-b', modelId: 'b-model', currentProviderId: 'b-main',
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(command).toHaveBeenCalledWith({ action: 'received-snapshot', favoriteRecovery: {
      ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 1 }, regions: ['global', 'cn'],
    } });
    await clickRail('favorites');
    expect(within(favoritesGroup()).getByText('Shared three')).toBeTruthy();
    expect(remoteLists['device-b']).toHaveLength(1);
    resetProviderShareStoreForTests();
  });
});

describe('Cindy AI(xd)第二行：保留分享与电脑来源，原简介行显示供应商', () => {
  const DESCRIPTION = '用于内容写作、编程与问题分析。';
  /** 分享者真实电脑名：界面任何位置都不能出现(provider-sharing.md §6)。 */
  const HOST_DEVICE_NAME = 'Magi-Secret-MacBook-Pro';
  const xdShare = {
    shareId: 'magi', memberId: 'member-magi', providerId: 'xd', providerLabel: 'Cindy AI',
    hostDeviceId: 'host-magi', deviceName: HOST_DEVICE_NAME, status: 'active' as const, hostOnline: true,
    hostCapable: true, owner: { displayName: 'Magi', avatarUrl: null, region: 'global' as const },
  };
  const xdDevices = [...devices, { deviceId: 'share:magi', name: '来自 Magi 的分享' }];
  const xdProvider = (models: readonly (readonly [string, string])[], extra: Record<string, unknown> = {}) => ({
    ...(catalogs.local[0] as Record<string, unknown>), id: 'xd', name: 'Cindy AI', ...extra,
    models: { 'claude-code': models.map(([id, name]) => ({ id, name, efforts: ['low', 'high'], defaultEffort: 'high' })) },
  });
  const LOCAL = 'GLM 5.3 Flash';
  const SHARED = 'Qwen 3.8 Flash';
  const REMOTE = 'GLM 5.2';
  let saved: { local: unknown[]; byDevice: Record<string, unknown[]> };

  const clickRail = async (key: string) => {
    await act(async () => fireEvent.click(document.querySelector(`[data-rail-item="${key}"]`)!));
  };
  const sourceOf = (row: HTMLElement) => row.querySelector('[data-model-source-details]')?.textContent ?? null;
  const rowsOf = (scope: HTMLElement, name: string) =>
    within(scope).getAllByText(name).map((node) => node.closest('[data-unified-anchor]') as HTMLElement);
  const expectSupplier = (row: HTMLElement) => {
    expect(sourceOf(row)).toBeNull();
    const supplier = within(row).getByText('Cindy AI');
    expect(supplier.getAttribute('title')).toBe('Cindy AI');
    expect(supplier.className).toContain('truncate');
    expect(within(row).queryByText(DESCRIPTION)).toBeNull();
  };
  const expectSource = (row: HTMLElement, label: string) => {
    expect(sourceOf(row)).toBe(label);
    expect(within(row).queryByText(DESCRIPTION)).toBeNull();
  };
  // ModelSelectorContent 的隐藏量宽副本保留文字，但不再挂来源详情或可操作选项。
  // 这两条既有 unit 用例覆盖本机、分享与其他电脑目录；可见行的来源判断仍由上面的断言保护。
  const expectWidthProbe = (...names: string[]) => {
    const sizer = document.querySelector('[data-width-sizer]') as HTMLElement;
    expect(sizer).toBeTruthy();
    for (const name of names) expect(within(sizer).getAllByText(name).length).toBeGreaterThan(0);
    expect(sourceOf(sizer)).toBeNull();
    expect(within(sizer).queryAllByRole('option', { hidden: true })).toEqual([]);
    expect(within(sizer).queryAllByRole('button', { hidden: true })).toEqual([]);
    expect(within(sizer).queryByText(DESCRIPTION)).toBeNull();
    expect(sizer.textContent).not.toContain(HOST_DEVICE_NAME);
    return sizer;
  };
  const SHARED_LABEL = 'Cindy AI · 来自 Magi 的分享 · 供应商组 · 2 台电脑';
  const REMOTE_LABEL = 'Cindy AI · Studio';

  beforeEach(() => {
    saved = { local: [...catalogs.local], byDevice: { ...catalogs.byDevice } };
    catalogs.local.push(xdProvider([['glm-5.3-flash', LOCAL]]));
    catalogs.byDevice['share:magi'] = [
      xdProvider([['qwen3.8-flash', SHARED]], { remoteInvocationEnabled: true, groupSize: 2 }),
    ];
    catalogs.byDevice['device-c'] = [
      ...catalogs.byDevice['device-c']!,
      xdProvider([['glm-5.2', REMOTE]], { remoteInvocationEnabled: true }),
    ];
    setDataOwnerGeneration('recipient', 1);
    setModelFavoritesOwner('recipient');
    reconcileProviderShareFavorites({
      received: [xdShare], confirmedRegions: ['global'],
      ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 1 },
    });
    addModelFavorite({ providerId: 'xd', modelId: 'glm-5.3-flash', agent: 'cc' });
    addModelFavorite({ providerId: providerShareFavoriteSource(xdShare), modelId: 'qwen3.8-flash', agent: 'cc' });
    addModelFavorite({
      providerId: agentDeviceFavoriteSource({ deviceId: 'device-c', providerId: 'xd' }),
      modelId: 'glm-5.2',
      agent: 'cc',
    });
  });
  afterEach(() => {
    catalogs.local.splice(0, catalogs.local.length, ...saved.local);
    for (const key of Object.keys(catalogs.byDevice)) delete catalogs.byDevice[key];
    Object.assign(catalogs.byDevice, saved.byDevice);
  });

  it.each(['favorites', 'all'])('「%s」：分享来的与其他电脑上的 Cindy AI 显示来源，本机 Cindy AI 原描述行显示供应商', async (rail) => {
    renderPanel({ devices: xdDevices });
    await clickRail(rail);
    expectSource(rowOf(favoritesGroup(), SHARED), SHARED_LABEL);
    expectSource(rowOf(favoritesGroup(), REMOTE), REMOTE_LABEL);
    // 本机 Cindy AI：收藏区与「全部」均复用原描述容器显示供应商。
    for (const row of rowsOf(list(), LOCAL)) expectSupplier(row);
    expect(document.body.textContent).not.toContain(HOST_DEVICE_NAME);
  });

  it('单供应商分栏复用原描述行显示供应商', async () => {
    renderPanel({ devices: xdDevices });
    await clickRail('remote:share:magi:xd');
    for (const row of rowsOf(list(), SHARED)) expectSupplier(row);
    // 另一台电脑上的同名 Cindy AI 在本机能用时不占左栏(「运行于」那台时见下一条)。
    expect(document.querySelector('[data-rail-item="remote:device-c:xd"]')).toBeNull();
    await clickRail('provider:xd');
    for (const row of rowsOf(list(), LOCAL)) expectSupplier(row);
  });

  it('定宽测量保留模型与本机供应商文字，省去来源详情与交互节点', async () => {
    renderPanel({ devices: xdDevices });
    await clickRail('favorites');
    const sizer = expectWidthProbe(SHARED, REMOTE, LOCAL);
    expect(within(sizer).getAllByTitle('Cindy AI').length).toBeGreaterThan(0);
  });

  it('浏览分享或其他电脑目录时，定宽测量仍保留模型文字且不重复渲染来源详情', async () => {
    // 本机的 Cindy AI 改成「运行于」device-c，左栏才列出那台的一项。
    const local = catalogs.local.at(-1) as Record<string, unknown>;
    catalogs.local[catalogs.local.length - 1] = { ...local, runLocation: 'device-c' };
    renderPanel({ devices: xdDevices });
    await clickRail('remote:share:magi:xd');
    for (const row of rowsOf(list(), SHARED)) expectSupplier(row);
    expectWidthProbe(SHARED);
    await clickRail('remote:device-c:xd');
    for (const row of rowsOf(list(), REMOTE)) expectSupplier(row);
    expectWidthProbe(REMOTE);
    expect(document.body.textContent).not.toContain(HOST_DEVICE_NAME);
  });

  it('直接打开分享的目录(不经远程 Agent)时，分享的 Cindy AI 同样带来源', async () => {
    render(
      React.createElement(ModelSelectorContent, {
        remoteAgent: undefined,
        modelId: 'qwen3.8-flash',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'xd',
        onProviderChange: vi.fn(),
        vendorKey: 'cc',
        deviceId: 'share:magi',
      }),
    );
    await act(async () => {});
    await clickRail('all');
    for (const row of rowsOf(list(), SHARED)) expectSource(row, 'Cindy AI');
    expect(document.body.textContent).not.toContain(HOST_DEVICE_NAME);
  });

  it('远程控制被控电脑时，那台自己的 Cindy AI 仍按任务所在电脑的目录显示供应商', async () => {
    catalogs.byDevice['device-b'] = [xdProvider([['glm-5.3-flash', LOCAL]])];
    render(
      React.createElement(ModelSelectorContent, {
        remoteAgent: undefined,
        modelId: 'glm-5.3-flash',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'xd',
        onProviderChange: vi.fn(),
        vendorKey: 'cc',
        deviceId: 'device-b',
      }),
    );
    await act(async () => {});
    for (const row of rowsOf(list(), LOCAL)) expectSupplier(row);
  });
});
