/**
 * 分享给我的供应商在模型列表里的「电脑」：`share:<shareId>`，名字写成「来自 Magi 的分享」，
 * 不写分享者的电脑名(provider-sharing.md §5.1、§6)。模型列表分组标题沿用 railRemoteProvider
 * (`{{provider}} · {{device}}`)，于是标题成为「Anthropic · 来自 Magi 的分享」。
 *
 * 只并进远程 Agent 的候选(remoteAgentDevices)，**不**进设备切换器：分享者的电脑不是可远程
 * 控制的设备。已暂停或已不在的分享只有在它正是任务当前 / 即将使用的位置时才保留，让用户
 * 看得到、换得走。分享者电脑暂时离线时照常列出，名字后标「暂时离线」(providerSharePickerState，
 * 与手机同一条规则)，不随在线状态来回出现、消失。
 */
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { providerSharePickerState } from '@cindy/device-link';

import { pluginEngineKeyFromProviderId } from '../../../shared/pluginEngines';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare';
import { providerShareAgentDeviceId } from './providerShareFormat';
import { providerShareDisplayNames } from './providerShareNames';
import { useProviderShareReceived } from './providerShareStore';
import { useControlledShareIds } from './useControlledShareIds';

export interface ProviderShareAgentDevice {
  deviceId: string;
  name: string;
}

export interface ProviderShareAgentDevices {
  devices: readonly ProviderShareAgentDevice[];
  /** 已收到的插件引擎分享(`acp-plugin:…`)，供插件引擎选择器读取，不混入内置供应商目录轮询。 */
  pluginEngineDevices: readonly ProviderShareAgentDevice[];
  /** 已拿到过一次已收到分享的权威列表。 */
  loaded: boolean;
  /** `share:<id>` → 展示名；不是分享 id 时返回 null。 */
  nameFor: (deviceId: string | null | undefined) => string | null;
  /**
   * 该分享仍在已收到列表里(无论是否暂停)。列表未加载或为空(设备互联断开时 main 推空列表)
   * 时返回 true，不把「暂时读不到」当成「已删除」。
   */
  isKnown: (deviceId: string | null | undefined) => boolean;
  /** 该分享确实在本机已收到的列表里(无论是否暂停)；列表未加载或为空时返回 false。 */
  isReceived: (deviceId: string | null | undefined) => boolean;
}

export function useProviderShareAgentDevices(
  keepDeviceIds: readonly (string | null | undefined)[] = [],
  controlledDeviceId?: string | null,
): ProviderShareAgentDevices {
  const { t } = useTranslation();
  const { received, loaded } = useProviderShareReceived();
  const keepKey = keepDeviceIds.filter(isProviderShareAgentDeviceId).join('\n');
  const controlledShareIds = useControlledShareIds(controlledDeviceId, received);

  const names = useMemo(() => {
    const byShare = providerShareDisplayNames(received, t);
    const map = new Map<string, string>();
    for (const share of received) {
      const name = byShare.get(share.shareId) ?? '';
      map.set(providerShareAgentDeviceId(share.shareId), providerSharePickerState(share) === 'offline'
        ? t('providerShare.picker.offline', { name }) : name);
    }
    return map;
  }, [received, t]);

  const { devices, pluginEngineDevices } = useMemo(() => {
    const keep = new Set(keepKey ? keepKey.split('\n') : []);
    const list: ProviderShareAgentDevice[] = [];
    const pluginList: ProviderShareAgentDevice[] = [];
    for (const share of received) {
      const deviceId = providerShareAgentDeviceId(share.shareId);
      const isPlugin = pluginEngineKeyFromProviderId(share.providerId) !== null;
      if (share.status !== 'active' && !keep.has(deviceId)) continue;
      if (controlledDeviceId && !controlledShareIds.has(deviceId) && !keep.has(deviceId)) continue;
      const entry = { deviceId, name: names.get(deviceId) ?? '' };
      if (isPlugin) pluginList.push(entry);
      else list.push(entry);
      keep.delete(deviceId);
    }
    // 任务仍指着、但已不在列表里的分享(被删除或已退出)：保留一行，名字说明已不可用。
    if (loaded) {
      for (const deviceId of keep) {
        list.push({ deviceId, name: t('providerShare.picker.unavailable') });
      }
    }
    return { devices: list, pluginEngineDevices: pluginList };
  }, [controlledDeviceId, controlledShareIds, keepKey, loaded, names, received, t]);

  const nameFor = useCallback(
    (deviceId: string | null | undefined) => {
      if (!deviceId || !isProviderShareAgentDeviceId(deviceId)) return null;
      return names.get(deviceId) ?? (loaded ? t('providerShare.picker.unavailable') : null);
    },
    [loaded, names, t],
  );

  const isKnown = useCallback(
    (deviceId: string | null | undefined) => {
      if (!deviceId || !isProviderShareAgentDeviceId(deviceId)) return false;
      // 设备互联断开或换账号时 main 会推一份空列表(分享暂时读不到，不等于被删除)：
      // 只有在非空列表里找不到时才判定这条分享已经不在。
      return !loaded || names.size === 0 || names.has(deviceId);
    },
    [loaded, names],
  );

  const isReceived = useCallback(
    (deviceId: string | null | undefined) => !!deviceId && names.has(deviceId),
    [names],
  );

  return { devices, pluginEngineDevices, loaded, nameFor, isKnown, isReceived };
}
