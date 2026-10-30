/**
 * 这个任务此刻归哪个供应商组(provider-groups.md §10)：模型列表把归组的任务显示在组那一项下，在组那一项里选模型
 * 时留在此刻运行的那台、只换模型。组的绑定记在任务所在的被控电脑上，经 `provider-group:remote` 的只读
 * `session-group` 问它；旧版本(不认识这个通道或这个动作)、离线或回包不对都按没归组处理。
 */
import { useEffect, useState } from 'react';

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import { useDeviceLink } from '@/device-link/DeviceLinkContext';

import { parseSessionProviderGroup, type MobileProviderGroupEntry } from './remoteProviderGroups';

/**
 * @param enabled 只在模型选择器打开、且没有挂着换电脑的意图时读(挂着时下一条消息就不在原处，不按组显示)。
 * @param routeKey 任务此刻的位置(电脑 + 供应商)：变了重读。
 */
export function useSessionProviderGroup(input: {
  enabled: boolean;
  hostDeviceId: string;
  sessionId: string;
  routeKey: string;
}): MobileProviderGroupEntry | null {
  const { invoke } = useDeviceLink();
  const [state, setState] = useState<{ key: string; entry: MobileProviderGroupEntry | null } | null>(null);
  const key = JSON.stringify([input.hostDeviceId, input.sessionId, input.routeKey]);
  useEffect(() => {
    if (!input.enabled || !input.hostDeviceId || !input.sessionId) return;
    let cancelled = false;
    invoke(input.hostDeviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'session-group', sessionId: input.sessionId }])
      .then(
        (raw) => {
          if (!cancelled) setState({ key, entry: parseSessionProviderGroup(raw, input.hostDeviceId) });
        },
        () => {
          if (!cancelled) setState({ key, entry: null });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [input.enabled, input.hostDeviceId, input.sessionId, invoke, key]);
  return input.enabled && state?.key === key ? state.entry : null;
}
