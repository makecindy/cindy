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
// 渠道设置不做模块级缓存种子(与 useWecomBot 同因): 缓存不按数据 owner 隔离,
// 切号后重新挂载会把上一账号的绝对路径闪给新账号。挂载时现拉, 数据本地量小。

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
  const [channelSettings, setChannelSettings] = useState<WechatChannelSettingsState | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isUnbinding, setIsUnbinding] = useState(false);
  const [isUpdatingWorkingDir, setIsUpdatingWorkingDir] = useState(false);
  const pushVersionRef = useRef(0);
  /**
   * 工作目录更新落地序号: choose/reset 结果写回时递增。读取请求出发时捕获,
   * 返回时序号已变(期间有一次更新落地)则丢弃 — 挂载读取会异步探测已配置
   * 目录, 网络盘下可能挂数秒, 迟到返回携带的是提交前的旧配置, 不得覆盖
   * 较新的选择/重置结果(与企微 hook 同款竞态防护)。
   */
  const updateSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.electronAPI.wechatBot.onStateChange((next) => {
      if (cancelled) return;
      pushVersionRef.current += 1;
      cachedState = next;
      setState(next);
    });
    const initialPushVersion = pushVersionRef.current;
    const initialUpdateSeq = updateSeqRef.current;
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
        if (updateSeqRef.current !== initialUpdateSeq) return;
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
      updateSeqRef.current += 1;
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
      updateSeqRef.current += 1;
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
  },
  getCache(): { state: WechatBotState | null } {
    return { state: cachedState };
  },
};
