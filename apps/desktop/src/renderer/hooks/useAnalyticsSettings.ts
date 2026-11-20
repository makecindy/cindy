import { useCallback, useEffect, useState } from 'react';

export interface AnalyticsSettingsState {
  privacyConsentAccepted: boolean;
  analyticsEnabled: boolean;
  /** 用户是否显式设置过开关;false = 跟随当前默认值。 */
  analyticsEnabledCustomized: boolean;
  /** allowed = isReportingBuild && 已同意隐私政策 && 统计开关开启(dev 默认 false,XDT_TAPDB_DEV=1 可放行)。 */
  allowed: boolean;
  loading: boolean;
}

const INITIAL: AnalyticsSettingsState = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
  analyticsEnabledCustomized: false,
  allowed: false,
  loading: true,
};

function normalize(payload: AnalyticsSettingsPayload): AnalyticsSettingsState {
  return {
    privacyConsentAccepted: payload.privacyConsentAccepted === true,
    analyticsEnabled: payload.analyticsEnabled === true,
    analyticsEnabledCustomized: payload.analyticsEnabledCustomized === true,
    allowed: payload.allowed === true,
    loading: false,
  };
}

/**
 * 使用统计(TapDB)开关的 renderer 视图态。
 *
 * 真相在 main(<userData>/analytics-settings.json);这里只读快照 + 订阅广播,
 * 保证多窗口同时开着设置页时不会各说各话。
 */
export function useAnalyticsSettings(): {
  state: AnalyticsSettingsState;
  setAnalyticsEnabled: (enabled: boolean) => Promise<void>;
  resetAnalyticsEnabled: () => Promise<void>;
} {
  const [state, setState] = useState<AnalyticsSettingsState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    // IPC 往返期间用户可能已经拨了开关,而广播先一步到达。那条广播比初始快照新,
    // 不能被这里的旧结果覆盖 —— 否则设置页会显示成与实际隐私选择相反的状态。
    let sawBroadcast = false;
    void window.electronAPI
      .getAnalyticsSettings()
      .then((payload) => {
        if (cancelled || sawBroadcast) return;
        setState(normalize(payload));
      })
      .catch(() => {
        if (!cancelled && !sawBroadcast) {
          setState((current) => ({ ...current, loading: false }));
        }
      });
    const unsubscribe = window.electronAPI.onAnalyticsSettingsChange((payload) => {
      if (cancelled) return;
      sawBroadcast = true;
      setState(normalize(payload));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setAnalyticsEnabled = useCallback(async (enabled: boolean) => {
    const payload = await window.electronAPI.setAnalyticsEnabled(enabled);
    setState(normalize(payload));
  }, []);

  const resetAnalyticsEnabled = useCallback(async () => {
    const payload = await window.electronAPI.resetAnalyticsEnabled();
    setState(normalize(payload));
  }, []);

  return { state, setAnalyticsEnabled, resetAnalyticsEnabled };
}
