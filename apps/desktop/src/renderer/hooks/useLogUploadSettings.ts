import { useCallback, useEffect, useState } from 'react';

export interface LogUploadSettingsState {
  /** 本构建是否配置了上报目标。false = 功能整体关闭。 */
  targetConfigured: boolean;
  privacyConsentAccepted: boolean;
  crashAutoUploadEnabled: boolean;
  /** 用户是否显式设置过开关;false = 跟随当前版本默认值(默认关闭)。 */
  crashAutoUploadCustomized: boolean;
  /** 手动上传是否可用 = 已配置目标 && 已同意隐私政策。 */
  manualUploadAvailable: boolean;
  loading: boolean;
}

const INITIAL: LogUploadSettingsState = {
  targetConfigured: false,
  privacyConsentAccepted: false,
  crashAutoUploadEnabled: false,
  crashAutoUploadCustomized: false,
  manualUploadAvailable: false,
  loading: true,
};

function normalize(payload: LogUploadSettingsPayload): LogUploadSettingsState {
  return {
    targetConfigured: payload.targetConfigured === true,
    privacyConsentAccepted: payload.privacyConsentAccepted === true,
    crashAutoUploadEnabled: payload.crashAutoUploadEnabled === true,
    crashAutoUploadCustomized: payload.crashAutoUploadCustomized === true,
    manualUploadAvailable: payload.manualUploadAvailable === true,
    loading: false,
  };
}

/**
 * 客户端日志上报设置的 renderer 视图态。
 *
 * 真相在 main(`<userData>/log-upload-settings.json` + analytics 那份同意事实);
 * 这里只读快照 + 订阅广播,保证多窗口同时开着设置页时不会各说各话。
 * 初始态一律 fail closed(全 false):IPC 还没回来时不该显示成「可用 / 已开启」。
 */
export function useLogUploadSettings(): {
  state: LogUploadSettingsState;
  setCrashAutoUpload: (enabled: boolean) => Promise<void>;
  resetCrashAutoUpload: () => Promise<void>;
} {
  const [state, setState] = useState<LogUploadSettingsState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    // IPC 往返期间用户可能已经拨了开关,而广播先一步到达。那条广播比初始快照新,
    // 不能被这里的旧结果覆盖(同 useAnalyticsSettings 的处理)。
    let sawBroadcast = false;
    void window.electronAPI
      .getLogUploadSettings()
      .then((payload) => {
        if (cancelled || sawBroadcast) return;
        setState(normalize(payload));
      })
      .catch(() => {
        if (!cancelled && !sawBroadcast) {
          setState((current) => ({ ...current, loading: false }));
        }
      });
    const unsubscribe = window.electronAPI.onLogUploadSettingsChange((payload) => {
      if (cancelled) return;
      sawBroadcast = true;
      setState(normalize(payload));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setCrashAutoUpload = useCallback(async (enabled: boolean) => {
    const payload = await window.electronAPI.setLogUploadCrashAuto(enabled);
    setState(normalize(payload));
  }, []);

  const resetCrashAutoUpload = useCallback(async () => {
    const payload = await window.electronAPI.resetLogUploadCrashAuto();
    setState(normalize(payload));
  }, []);

  return { state, setCrashAutoUpload, resetCrashAutoUpload };
}
