import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerIdCurrent } from '@/contexts/dataOwnerGeneration';
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
let cacheOwnerId = getDataOwnerGeneration().dataOwnerId;

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
  setCompanion: (botId: string | null) => Promise<boolean>;
  isUpdatingCompanion: boolean;
}

type WechatBotApi = Window['electronAPI']['wechatBot'];

/**
 * `override` serves personal WeChat of another computer (a teammate's settings on a remote Desktop). Its
 * state is that computer's, so it neither reads nor writes the module caches of this window's own.
 */
export function useWechatBot(override?: WechatBotApi): UseWechatBotReturn {
  const { t } = useTranslation();
  // Resolved at use, as before: a window API object is not a render-stable identity.
  const api = () => override ?? window.electronAPI.wechatBot;
  const [owner] = useState(getDataOwnerGeneration);
  // ProtectedRoute remounts on owner changes; module caches survive that remount.
  if (cacheOwnerId !== getDataOwnerGeneration().dataOwnerId) {
    cacheOwnerId = getDataOwnerGeneration().dataOwnerId;
    cachedState = null;
    cachedChannelSettings = null;
  }
  const [state, setState] = useState<WechatBotState>(() => (override ? null : cachedState) ?? EMPTY_STATE);
  const [channelSettings, setChannelSettings] = useState<WechatChannelSettingsState | null>(
    () => (override ? null : cachedChannelSettings),
  );
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isUnbinding, setIsUnbinding] = useState(false);
  const [isUpdatingWorkingDir, setIsUpdatingWorkingDir] = useState(false);
  const [isUpdatingCompanion, setIsUpdatingCompanion] = useState(false);
  const pushVersionRef = useRef(0);
  const settingsVersionRef = useRef(0);
  const companionBusyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api().onStateChange((next) => {
      if (cancelled || !isDataOwnerIdCurrent(owner)) return;
      pushVersionRef.current += 1;
      if (!override) cachedState = next;
      setState(next);
    });
    const unsubscribeSettings = api().onChannelSettingsChange?.((settings) => {
      if (cancelled || !isDataOwnerIdCurrent(owner)) return;
      settingsVersionRef.current += 1;
      if (!override) cachedChannelSettings = settings;
      setChannelSettings(settings);
    });
    const initialPushVersion = pushVersionRef.current;
    const initialSettingsVersion = settingsVersionRef.current;
    const requestOwner = getDataOwnerGeneration();
    void Promise.all([
      api().getState(),
      api().getChannelSettings(),
    ])
      .then(([nextState, nextChannelSettings]) => {
        // Same-owner repair keeps this page mounted and these read-only settings valid.
        if (cancelled || !isDataOwnerIdCurrent(requestOwner)) return;
        if (pushVersionRef.current === initialPushVersion) {
          if (!override) cachedState = nextState;
          setState(nextState);
        }
        if (settingsVersionRef.current === initialSettingsVersion) {
          if (!override) cachedChannelSettings = nextChannelSettings;
          setChannelSettings(nextChannelSettings);
        }
      })
      .catch(() => {
        if (cancelled) return;
        log.error('failed to load personal WeChat state');
      });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeSettings?.();
    };
  }, [owner, override]);

  const authorize = useCallback(async (): Promise<boolean> => {
    if (isAuthorizing) return false;
    setIsAuthorizing(true);
    try {
      await api().authorize();
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
      await api().cancelAuthorization();
    } catch {
      log.error('failed to cancel personal WeChat authorization');
      toast.error(t('settings.wechatBot.toasts.cancelFailed'));
    }
  }, [t]);

  const unbind = useCallback(async (): Promise<boolean> => {
    if (isUnbinding) return false;
    setIsUnbinding(true);
    try {
      await api().unbind();
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
    if (isUpdatingWorkingDir || !isDataOwnerIdCurrent(owner)) return;
    const requestOwner = getDataOwnerGeneration();
    setIsUpdatingWorkingDir(true);
    try {
      const result = await api().chooseWorkingDirectory();
      if (!isDataOwnerGenerationCurrent(requestOwner)) return;
      if (!override) cachedChannelSettings = result.state;
      setChannelSettings(result.state);
      if (!result.canceled) toast.success(t('settings.wechatBot.toasts.workingDirSaved'));
    } catch {
      log.error('failed to choose personal WeChat working directory');
      toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
    } finally {
      setIsUpdatingWorkingDir(false);
    }
  }, [override, isUpdatingWorkingDir, owner, t]);

  const resetWorkingDirectory = useCallback(async (): Promise<void> => {
    if (isUpdatingWorkingDir || !isDataOwnerIdCurrent(owner)) return;
    const requestOwner = getDataOwnerGeneration();
    setIsUpdatingWorkingDir(true);
    try {
      const next = await api().resetWorkingDirectory();
      if (!isDataOwnerGenerationCurrent(requestOwner)) return;
      if (!override) cachedChannelSettings = next;
      setChannelSettings(next);
      toast.success(t('settings.wechatBot.toasts.workingDirReset'));
    } catch {
      log.error('failed to reset personal WeChat working directory');
      toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
    } finally {
      setIsUpdatingWorkingDir(false);
    }
  }, [override, isUpdatingWorkingDir, owner, t]);

  const setCompanion = useCallback(async (botId: string | null): Promise<boolean> => {
    if (companionBusyRef.current || !channelSettings || !isDataOwnerIdCurrent(owner)) return false;
    const requestOwner = getDataOwnerGeneration();
    companionBusyRef.current = true;
    setIsUpdatingCompanion(true);
    try {
      const next = await api().setCompanion(botId);
      if (!isDataOwnerGenerationCurrent(requestOwner)) return false;
      settingsVersionRef.current += 1;
      if (!override) cachedChannelSettings = next;
      setChannelSettings(next);
      return true;
    } catch {
      toast.error(t('settings.wechatBot.companion.updateFailed'));
      return false;
    } finally {
      companionBusyRef.current = false;
      setIsUpdatingCompanion(false);
    }
  }, [override, channelSettings, owner, t]);

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
    setCompanion,
    isUpdatingCompanion,
  };
}

export const __testing = {
  resetCache(): void {
    cachedState = null;
    cachedChannelSettings = null;
    cacheOwnerId = getDataOwnerGeneration().dataOwnerId;
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
