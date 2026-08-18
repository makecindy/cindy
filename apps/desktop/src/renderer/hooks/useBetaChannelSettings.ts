import { useCallback, useEffect, useState } from 'react';

export interface BetaChannelSettingsState {
  enableBeta: boolean;
  isCustomized: boolean;
  loading: boolean;
}

interface BetaChannelSettingsPayload {
  enableBeta: boolean;
  isCustomized?: boolean;
}

const INITIAL: BetaChannelSettingsState = {
  enableBeta: false,
  isCustomized: false,
  loading: true,
};

function normalize(payload: BetaChannelSettingsPayload): BetaChannelSettingsState {
  return {
    enableBeta: payload.enableBeta === true,
    isCustomized: payload.isCustomized === true,
    loading: false,
  };
}

/**
 * beta 测试渠道(设备级)开关的状态与写操作。
 * 语义与 auto-update-settings 一致:默认值 + override,恢复默认只删 override。
 */
export function useBetaChannelSettings(): {
  state: BetaChannelSettingsState;
  setEnableBeta: (enabled: boolean) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [state, setState] = useState<BetaChannelSettingsState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    let latestSeq = 0;
    void window.electronAPI
      .getUpdateChannelSettings()
      .then((payload) => {
        if (cancelled || latestSeq !== 0) return;
        setState(normalize(payload));
      })
      .catch(() => {
        if (cancelled || latestSeq !== 0) return;
        setState((current) => ({ ...current, loading: false }));
      });
    const unsubscribe = window.electronAPI.onUpdateChannelSettings((payload) => {
      if (cancelled) return;
      latestSeq += 1;
      setState(normalize(payload));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setEnableBeta = useCallback(async (enabled: boolean) => {
    const payload = await window.electronAPI.setUpdateChannelSettings({
      enableBeta: enabled,
    });
    setState(normalize(payload));
  }, []);

  const reset = useCallback(async () => {
    const payload = await window.electronAPI.resetUpdateChannelSettings();
    setState(normalize(payload));
  }, []);

  return { state, setEnableBeta, reset };
}
