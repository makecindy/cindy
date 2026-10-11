/**
 * 这个任务此刻归哪个供应商组(provider-groups.md §10)：模型列表把归组的任务显示在组那一项下，在组那一项里
 * 选模型时留在此刻运行的那台。只问本机(组的绑定记在任务所在电脑上)，读不到按没归组处理。
 */
import type { RemoteProviderGroupEntry } from '@/lib/remoteProviderGroups';

import type { ProviderGroupSessionGroup } from '../../../shared/providerGroup';

export async function readSessionProviderGroup(sessionId: string): Promise<RemoteProviderGroupEntry | null> {
  const api = window.electronAPI?.providerGroup;
  if (typeof api?.command !== 'function') return null;
  try {
    const group = (await api.command({ action: 'session-group', sessionId })) as ProviderGroupSessionGroup;
    return group ? { deviceId: group.groupDeviceId, providerId: group.providerId } : null;
  } catch {
    return null;
  }
}
