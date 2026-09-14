import { useEffect, useState } from 'react';

import type { UpdateChannel } from '@cindy/maker-shared/update-channel';

import {
  hydrateCanaryChannel,
  resolveUpdateChannelForDevice,
  subscribeCanaryChannel,
} from './canaryChannelStore';
import { hydrateBetaChannel, subscribeBetaChannel } from './betaChannelStore';

export interface UpdateChannelGateState {
  ready: boolean;
  channel: UpdateChannel;
}

/**
 * 在所有自建更新请求之前恢复本地发布通道快照(canary 账号级 + beta 设备级)。
 * 组合结果按 resolveUpdateChannelForDevice 收敛为 canary > beta > release;
 * 读取完成前 ready=false,调用方不发任何 /manifest 或 /latest 请求。
 */
export function useUpdateChannelGate(enabled = true): UpdateChannelGateState {
  const [state, setState] = useState<UpdateChannelGateState>(() => (
    enabled
      ? { ready: false, channel: 'release' }
      : { ready: true, channel: 'release' }
  ));

  useEffect(() => {
    if (!enabled) {
      setState({ ready: true, channel: 'release' });
      return undefined;
    }
    let cancelled = false;
    let hydrated = false;
    const syncFromStore = () => {
      if (!cancelled && hydrated) {
        setState({ ready: true, channel: resolveUpdateChannelForDevice() });
      }
    };
    const unsubscribeCanary = subscribeCanaryChannel(syncFromStore);
    const unsubscribeBeta = subscribeBetaChannel(syncFromStore);
    void Promise.all([hydrateCanaryChannel(), hydrateBetaChannel()]).then(() => {
      hydrated = true;
      if (!cancelled) {
        setState({ ready: true, channel: resolveUpdateChannelForDevice() });
      }
    });
    return () => {
      cancelled = true;
      unsubscribeCanary();
      unsubscribeBeta();
    };
  }, [enabled]);

  return state;
}
