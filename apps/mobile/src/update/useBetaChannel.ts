import { useCallback, useEffect, useState } from 'react';

import {
  hydrateBetaChannel,
  isBetaChannel,
  subscribeBetaChannel,
  syncBetaChannel,
} from './betaChannelStore';

/**
 * 设备级 beta 开关的状态与写操作(设置页用)。
 * hydrate 完成前 ready=false,开关应禁用(显示的是 fail-safe 默认值,避免对陈旧值取反)。
 */
export function useBetaChannel(): {
  enabled: boolean;
  ready: boolean;
  setEnabled: (next: boolean) => Promise<void>;
} {
  const [enabled, setEnabledState] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (!cancelled) setEnabledState(isBetaChannel());
    };
    const unsubscribe = subscribeBetaChannel(sync);
    void hydrateBetaChannel().then(() => {
      if (!cancelled) {
        sync();
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setEnabled = useCallback(async (next: boolean) => {
    await syncBetaChannel(next);
    setEnabledState(next);
  }, []);

  return { enabled, ready, setEnabled };
}
