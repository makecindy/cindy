/**
 * 这个任务此刻归哪个供应商组(provider-groups.md §10)：模型列表把归组的任务显示在组那一项下，在组那一项里
 * 选模型时留在此刻运行的那台。组的绑定记在任务所在电脑上：本机任务问本机，被控电脑上的任务经设备互联问
 * 那台(`provider-group:remote` 的只读 `session-group`)。读不到(含旧版本)按没归组处理。
 */
import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import type { RemoteProviderGroupEntry } from '@/lib/remoteProviderGroups';

import {
  parseProviderGroupRemoteSessionGroup,
  type ProviderGroupSessionGroup,
} from '../../../shared/providerGroup';

/**
 * @param hostDeviceId 任务所在的被控电脑；本机任务不传。返回的位置是任务所在电脑视角(`deviceId` 为 null =
 *   那台自己的供应商，与模型列表里任务所在电脑那一栏一致)。
 */
export async function readSessionProviderGroup(
  sessionId: string,
  hostDeviceId?: string,
): Promise<RemoteProviderGroupEntry | null> {
  try {
    let group: ProviderGroupSessionGroup;
    if (hostDeviceId) {
      const deviceLink = window.electronAPI?.deviceLink;
      if (typeof deviceLink?.invoke !== 'function') return null;
      group = parseProviderGroupRemoteSessionGroup(
        await deviceLink.invoke(hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'session-group', sessionId }]),
      );
    } else {
      const api = window.electronAPI?.providerGroup;
      if (typeof api?.command !== 'function') return null;
      group = (await api.command({ action: 'session-group', sessionId })) as ProviderGroupSessionGroup;
    }
    if (!group) return null;
    return {
      deviceId: hostDeviceId && group.groupDeviceId === hostDeviceId ? null : group.groupDeviceId,
      providerId: group.providerId,
    };
  } catch {
    return null;
  }
}
