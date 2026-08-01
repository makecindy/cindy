import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('useWechatBot');

const EMPTY_STATE: WechatBotState = {
  phase: 'disconnected',
  bound: false,
  queuedTasks: 0,
};

let cachedState: WechatBotState | null = null;
let cachedChannelSettings: WechatChannelSettingsState | null = null;

export interface UseWechatBotReturn {
  state: WechatBotState;
  channelSettings: WechatChannelSettingsState | null;
  isAuthorizing: boolean;
  isUnbinding: boolean;
  isUpdatingWorkingDir: boolean;
  authorize: () => Promise<boolean>;
  cancelAuthorization: () => Promise<void>;
  unbind: () => Promise<boolean>;
  chooseWorkingDirectory: () => Promise<void>;
  resetWorkingDirectory: () => Promise<void>;
}

export function useWechatBot(): UseWechatBotReturn {
  const { t } = useTranslation();
  const [state, setState] = useState<WechatBotState>(() => cachedState ?? EMPTY_STATE);
  const [channelSettings, setChannelSettings] = useState<WechatChannelSettingsState | null>(
    () => cachedChannelSettings,
  );
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isUnbinding, setIsUnbinding] = useState(false);
  const [isUpdatingWorkingDir, setIsUpdatingWorkingDir] = useState(false);
  const pushVersionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.electronAPI.wechatBot.onStateChange((next) => {
      if (cancelled) return;
      pushVersionRef.current += 1;
      cachedState = next;
      setState(next);
    });
    const initialPushVersion = pushVersionRef.current;
    void Promise.all([
      window.electronAPI.wechatBot.getState(),
      window.electronAPI.wechatBot.getChannelSettings(),
    ])
      .then(([nextState, nextChannelSettings]) => {
        if (cancelled) return;
        if (pushVersionRef.current === initialPushVersion) {
          cachedState = nextState;
          setState(nextState);
        }
        cachedChannelSettings = nextChannelSettings;
        setChannelSettings(nextChannelSettings);
      })
      .catch(() => {
        if (cancelled) return;
        log.error('failed to load personal WeChat state');
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const authorize = useCallback(async (): Promise<boolean> => {
    if (isAuthorizing) return false;
    setIsAuthorizing(true);
    try {
      await window.electronAPI.wechatBot.authorize();
      return true;
    } catch {
      log.error('failed to start personal WeChat authorization');
      toast.error(t('settings.wechatBot.toasts.authorizeFailed'));
      return false;
    } finally {
      setIsAuthorizing(false);
    }
  }, [isAuthorizing, t]);

  const cancelAuthorization = useCallback(async (): Promise<void> => {
    try {
      await window.electronAPI.wechatBot.cancelAuthorization();
    } catch {
      log.error('failed to cancel personal WeChat authorization');
      toast.error(t('settings.wechatBot.toasts.cancelFailed'));
    }
  }, [t]);

  const unbind = useCallback(async (): Promise<boolean> => {
    if (isUnbinding) return false;
    setIsUnbinding(true);
    try {
      await window.electronAPI.wechatBot.unbind();
      toast.success(t('settings.wechatBot.toasts.unbound'));
      return true;
    } catch {
      log.error('failed to unbind personal WeChat');
      toast.error(t('settings.wechatBot.toasts.unbindFailed'));
      return false;
    } finally {
      setIsUnbinding(false);
    }
  }, [isUnbinding, t]);

  const chooseWorkingDirectory = useCallback(async (): Promise<void> => {
    if (isUpdatingWorkingDir) return;
    setIsUpdatingWorkingDir(true);
    try {
      const result = await window.electronAPI.wechatBot.chooseWorkingDirectory();
      cachedChannelSettings = result.state;
      setChannelSettings(result.state);
      if (!result.canceled) toast.success(t('settings.wechatBot.toasts.workingDirSaved'));
    } catch {
      log.error('failed to choose personal WeChat working directory');
      toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
    } finally {
      setIsUpdatingWorkingDir(false);
    }
  }, [isUpdatingWorkingDir, t]);

  const resetWorkingDirectory = useCallback(async (): Promise<void> => {
    if (isUpdatingWorkingDir) return;
    setIsUpdatingWorkingDir(true);
    try {
      const next = await window.electronAPI.wechatBot.resetWorkingDirectory();
      cachedChannelSettings = next;
      setChannelSettings(next);
      toast.success(t('settings.wechatBot.toasts.workingDirReset'));
    } catch {
      log.error('failed to reset personal WeChat working directory');
      toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
    } finally {
      setIsUpdatingWorkingDir(false);
    }
  }, [isUpdatingWorkingDir, t]);

  return {
    state,
    channelSettings,
    isAuthorizing,
    isUnbinding,
    isUpdatingWorkingDir,
    authorize,
    cancelAuthorization,
    unbind,
    chooseWorkingDirectory,
    resetWorkingDirectory,
  };
}

export const __testing = {
  resetCache(): void {
    cachedState = null;
    cachedChannelSettings = null;
  },
  getCache(): {
    state: WechatBotState | null;
    channelSettings: WechatChannelSettingsState | null;
  } {
    return {
      state: cachedState,
      channelSettings: cachedChannelSettings,
    };
  },
};
