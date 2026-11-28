import { useCallback, useEffect, useMemo, useRef } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';

import { useSelectableDevices } from '@/hooks/useControllableDevices';
import {
  requestPluginEnginesRefresh,
  useDevicesPluginEngines,
  usePluginEngines,
} from '@/hooks/usePluginEngines';
import { deviceDisplayName } from '@/lib/deviceName';
import {
  remotePluginEngineChoices,
  type PluginEngineChoice,
} from '@/lib/pluginEngineSelection';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare';

/**
 * 本地设置页(IM 新对话配置 / 飞书按群设置)共用的本机 + 同账号远程插件引擎列表。
 * 与新任务草稿 / 会话页同源：本机无需安装对应插件即可列出其他在线电脑或分享开放的插件引擎，
 * 并自动回读已保存的远程插件引擎目录以便 trigger 立即展示真实名称。
 */
export function useSettingsPluginEngines(rememberedDeviceId?: string | null): {
  engines: readonly PluginEngineChoice[];
  readCatalogue: () => void;
  hasSources: boolean;
} {
  const rememberedIds = useMemo(
    () => (rememberedDeviceId ? [rememberedDeviceId] : []),
    [rememberedDeviceId],
  );
  const { devices: selectableDevices } = useSelectableDevices();
  const {
    pluginEngineDevices: sharedPluginEngineDevices = [],
    nameFor: providerShareDeviceName,
  } = useProviderShareAgentDevices(rememberedIds);
  const localPluginEngines = usePluginEngines(true);

  const pluginEngineDevicesKey = JSON.stringify([
    ...selectableDevices
      .filter(
        (device) =>
          !isProviderShareAgentDeviceId(device.deviceId) &&
          !isSharedTaskPeer(device.deviceId) &&
          (device.online || device.deviceId === rememberedDeviceId),
      )
      .map(({ deviceId: id, name }): [string, string | null] => [id, name ?? null]),
    ...sharedPluginEngineDevices.map(({ deviceId: id, name }): [string, string | null] => [
      id,
      name || null,
    ]),
    ...(rememberedDeviceId &&
    isProviderShareAgentDeviceId(rememberedDeviceId) &&
    !sharedPluginEngineDevices.some((item) => item.deviceId === rememberedDeviceId)
      ? [[rememberedDeviceId, providerShareDeviceName?.(rememberedDeviceId) ?? null] as [string, string | null]]
      : []),
  ]);

  const pluginEngineDevices = useMemo(
    () =>
      (JSON.parse(pluginEngineDevicesKey) as Array<[string, string | null]>).map(([id, name]) => ({
        deviceId: id,
        name,
      })),
    [pluginEngineDevicesKey],
  );
  const pluginEngineDeviceIds = useMemo(
    () => pluginEngineDevices.map((device) => device.deviceId),
    [pluginEngineDevices],
  );
  const { catalogues: devicePluginEngines, read: readDevicePluginEngines } =
    useDevicesPluginEngines(pluginEngineDeviceIds);

  useEffect(() => {
    if (rememberedDeviceId && pluginEngineDeviceIds.includes(rememberedDeviceId)) {
      readDevicePluginEngines(rememberedDeviceId);
    }
  }, [rememberedDeviceId, pluginEngineDeviceIds, readDevicePluginEngines]);

  const engines = useMemo<readonly PluginEngineChoice[]>(() => {
    const remoteChoices = remotePluginEngineChoices(
      pluginEngineDevices,
      devicePluginEngines,
      deviceDisplayName,
      localPluginEngines,
    );
    return remoteChoices.length ? [...localPluginEngines, ...remoteChoices] : localPluginEngines;
  }, [pluginEngineDevices, devicePluginEngines, localPluginEngines]);

  const hasLocalRef = useRef(false);
  hasLocalRef.current = localPluginEngines.length > 0;
  const readCatalogue = useCallback(() => {
    if (hasLocalRef.current) requestPluginEnginesRefresh();
    readDevicePluginEngines();
  }, [readDevicePluginEngines]);

  return {
    engines,
    readCatalogue,
    hasSources: engines.length > 0 || pluginEngineDevices.length > 0,
  };
}
