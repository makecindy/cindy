// @vitest-environment jsdom
/**
 * 生产入口与可观察结果：usePickerPluginEngines 为非输入框模型选择器收集本机与远端插件引擎。
 * 规则依据：2026-11-27 全系统放开插件引擎；远端 hostDeviceId 必须按被控电脑的可用位置名单
 * (`useControlledModelLocations` + `controlledPluginEngineSources`) 经 `modelCatalogKey(id, hostDeviceId)`
 * 代读目录，且 `enabled=false`（如弹窗关闭）时必须停止远端分享与位置读取。
 * 覆盖缺口：此前 hostDeviceId 分支只读 rememberedIds 且用裸设备 ID；enabled=false 未门控分享查询。
 * 最小失败输入与 tier：unit（jsdom），分别传入 enabled=false+hostDeviceId 与 enabled=true+hostDeviceId。
 */
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allDevices: [
    { deviceId: 'self-mac', name: 'My Mac', isSelf: true, online: true },
    { deviceId: 'remote-host', name: 'Studio Mac', isSelf: false, online: true },
  ] as Array<{ deviceId: string; name: string; isSelf: boolean; online: boolean }>,
  selectableDevices: [
    { deviceId: 'remote-host', name: 'Studio Mac', online: true },
  ] as Array<{ deviceId: string; name: string; online: boolean }>,
  hostLocations: undefined as
    | Array<{ agentDeviceId: string; name: string; favoriteSource?: { providerId: string } }>
    | undefined,
  shareCalls: [] as Array<{ keep: readonly (string | null | undefined)[]; host: string | null | undefined }>,
  locationCalls: [] as Array<{ host: string | null | undefined; self: string | null | undefined }>,
  remoteHostEngines: [] as Array<Record<string, unknown>>,
  deviceCatalogues: new Map<string, Array<Record<string, unknown>> | null>(),
  readRemoteCatalogues: vi.fn(),
  deviceCatalogueKeys: [] as string[],
}));

vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => mocks.allDevices,
}));
vi.mock('@/hooks/useControllableDevices', () => ({
  useSelectableDevices: () => ({ devices: mocks.selectableDevices }),
}));
vi.mock('@/hooks/useControlledModelLocations', () => ({
  useControlledModelLocations: (host: string | null | undefined, self?: string | null) => {
    mocks.locationCalls.push({ host, self });
    return host ? mocks.hostLocations : undefined;
  },
}));
vi.mock('@/features/provider-share/useProviderShareAgentDevices', () => ({
  useProviderShareAgentDevices: (keep: readonly (string | null | undefined)[] = [], host?: string | null) => {
    mocks.shareCalls.push({ keep, host });
    return {
      devices: [],
      pluginEngineDevices: [],
      loaded: true,
      nameFor: (id: string | null | undefined) => (id === 'share:s-plugin' ? '来自 Magi 的分享' : null),
      isKnown: () => true,
      isReceived: (id: string | null | undefined) => id === 'share:s-plugin',
    };
  },
}));
vi.mock('@/hooks/usePluginEngines', () => ({
  usePluginEngines: () => [],
  useRemotePluginEngines: (deviceId: string | undefined) => ({
    engines: deviceId ? mocks.remoteHostEngines : [],
    refresh: vi.fn(),
  }),
  useDevicesPluginEngines: (keys: readonly string[]) => {
    mocks.deviceCatalogueKeys = [...keys];
    return {
      catalogues: mocks.deviceCatalogues,
      read: mocks.readRemoteCatalogues,
    };
  },
  findPluginEngine: () => null,
  requestPluginEnginesRefresh: vi.fn(),
}));

import { modelCatalogKey } from '../../../shared/controlledModelCatalog';
import { usePickerPluginEngines } from '../usePickerPluginEngines';

describe('usePickerPluginEngines', () => {
  beforeEach(() => {
    mocks.shareCalls = [];
    mocks.locationCalls = [];
    mocks.hostLocations = undefined;
    mocks.remoteHostEngines = [];
    mocks.deviceCatalogues = new Map();
    mocks.deviceCatalogueKeys = [];
    mocks.readRemoteCatalogues.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not query controlled shares or host model locations when enabled is false', () => {
    const { result } = renderHook(() =>
      usePickerPluginEngines({
        enabled: false,
        hostDeviceId: 'remote-host',
        rememberedDeviceIds: ['share:s-plugin', 'peer-mac'],
      }),
    );

    expect(result.current.engines).toEqual([]);
    expect(result.current.hasSources).toBe(false);
    expect(mocks.shareCalls).toEqual([{ keep: [], host: undefined }]);
    expect(mocks.locationCalls).toEqual([{ host: undefined, self: 'self-mac' }]);
    expect(mocks.deviceCatalogueKeys).toEqual([]);
    expect(mocks.readRemoteCatalogues).not.toHaveBeenCalled();
  });

  it('discovers controlled host peer/share plugin sources and reads catalogues via modelCatalogKey', () => {
    mocks.hostLocations = [
      { agentDeviceId: 'self-mac', name: 'My Mac' },
      { agentDeviceId: 'share:s-plugin', name: 'Magi Share', favoriteSource: { providerId: 'acp-plugin:dsh:dsh' } },
      { agentDeviceId: 'share:s-builtin', name: 'OpenAI Share', favoriteSource: { providerId: 'openai' } },
    ];
    const selfKey = modelCatalogKey('self-mac', 'remote-host')!;
    const shareKey = modelCatalogKey('share:s-plugin', 'remote-host')!;
    const rememberedKey = modelCatalogKey('offline-peer', 'remote-host')!;
    mocks.remoteHostEngines = [
      {
        key: 'agy:agy',
        providerId: 'acp-plugin:agy:agy',
        ghostId: 'agy',
        harnessId: 'agy',
        name: 'Antigravity',
        availability: { state: 'available' },
        models: [{ id: 'gemini-3-pro', displayName: 'Gemini 3 Pro' }],
        permissionModes: [{ id: 'ask' }],
        defaultPermissionMode: 'ask',
      },
    ];
    mocks.deviceCatalogues = new Map([
      [
        shareKey,
        [
          {
            key: 'dsh:dsh',
            providerId: 'acp-plugin:dsh:dsh',
            ghostId: 'dsh',
            harnessId: 'dsh',
            name: 'DeepSeek Harness',
            availability: { state: 'available' },
            remoteUse: { supported: true, enabled: true },
            models: [{ id: 'deepseek-v4', displayName: 'DeepSeek V4' }],
            permissionModes: [{ id: 'ask' }],
            defaultPermissionMode: 'ask',
          },
        ],
      ],
    ]);

    const { result } = renderHook(() =>
      usePickerPluginEngines({
        enabled: true,
        hostDeviceId: 'remote-host',
        rememberedDeviceIds: ['offline-peer'],
      }),
    );

    expect(mocks.locationCalls).toContainEqual({ host: 'remote-host', self: 'self-mac' });
    expect(mocks.deviceCatalogueKeys).toEqual([selfKey, shareKey, rememberedKey]);
    expect(mocks.readRemoteCatalogues).toHaveBeenCalledWith(rememberedKey);
    expect(result.current.hasSources).toBe(true);
    expect(result.current.engines.map((e) => [e.providerId, e.deviceId ?? null, e.deviceName ?? null])).toEqual([
      ['acp-plugin:agy:agy', null, null],
      ['acp-plugin:dsh:dsh', 'share:s-plugin', '来自 Magi 的分享'],
    ]);
  });
});
