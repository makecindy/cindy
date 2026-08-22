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
  refreshChannelSettings: () => Promise<void>;
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
  /** Cindy 数据 owner 代次(auth:state-change 的 mode+dataOwnerId+ownerGeneration)。 */
  const ownerEpochRef = useRef(0);
  const cindyOwnerRef = useRef<string | null>(null);
  /** isUpdatingWorkingDir 的 ref 镜像: refreshChannelSettings 的在途守卫用。 */
  const isUpdatingWorkingDirRef = useRef(false);

  /** 拉取当前账号的渠道设置;owner 代次或更新序号已推进的迟到响应不写回。 */
  const fetchChannelSettings = useCallback(async (): Promise<void> => {
    const ownerEpoch = ownerEpochRef.current;
    const updateSeq = updateSeqRef.current;
    try {
      const settings = await window.electronAPI.wechatBot.getChannelSettings();
      if (ownerEpochRef.current !== ownerEpoch || updateSeqRef.current !== updateSeq) return;
      setChannelSettings(settings);
    } catch {
      log.error('failed to load personal WeChat channel settings');
    }
  }, []);

  /** 拉取最新渠道设置 — 设置卡展开/窗口聚焦时刷新, 让「不可用」警告及时出现。 */
  const refreshChannelSettings = useCallback(async (): Promise<void> => {
    // 工作目录更新在途时跳过: 原生选择器关窗会触发 focus 刷新, 这次读取
    // 大概率读到提交前的旧配置; choose/reset 返回的状态才是最新的。
    if (isUpdatingWorkingDirRef.current) return;
    await fetchChannelSettings();
  }, [fetchChannelSettings]);

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
        if (updateSeqRef.current !== 0 || ownerEpochRef.current !== 0) return;
        setChannelSettings(nextChannelSettings);
      })
      .catch(() => {
        if (cancelled) return;
        log.error('failed to load personal WeChat state');
      });
    return () => {
      cancelled = true;
      ownerEpochRef.current += 1;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    // Cindy 账号切换(登录/登出/换号)即时失效渠道设置: 微信状态推送不含任何
    // Cindy 身份, 不订阅 auth 的话旧账号的绝对路径会一直留在界面上; Main
    // 侧守卫只拦得住迟到响应, 清不掉已渲染状态。
    const unsubscribe = window.electronAPI.onAuthStateChange((auth) => {
      const next = `${auth.mode}/${auth.dataOwnerId ?? '-'}/${auth.ownerGeneration}`;
      if (cindyOwnerRef.current === next) return;
      cindyOwnerRef.current = next;
      ownerEpochRef.current += 1;
      setChannelSettings(null);
      void fetchChannelSettings();
    });
    return unsubscribe;
  }, [fetchChannelSettings]);

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
    isUpdatingWorkingDirRef.current = true;
    const ownerEpoch = ownerEpochRef.current;
    try {
      const result = await window.electronAPI.wechatBot.chooseWorkingDirectory();
      // 弹窗/探测期间 Cindy 账号切换: 迟到结果不得写回新账号界面。
      if (ownerEpochRef.current !== ownerEpoch) return;
      updateSeqRef.current += 1;
      setChannelSettings(result.state);
      if (!result.canceled) toast.success(t('settings.wechatBot.toasts.workingDirSaved'));
    } catch {
      log.error('failed to choose personal WeChat working directory');
      toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
    } finally {
      isUpdatingWorkingDirRef.current = false;
      setIsUpdatingWorkingDir(false);
    }
  }, [isUpdatingWorkingDir, t]);

  const resetWorkingDirectory = useCallback(async (): Promise<void> => {
    if (isUpdatingWorkingDir) return;
    setIsUpdatingWorkingDir(true);
    isUpdatingWorkingDirRef.current = true;
    const ownerEpoch = ownerEpochRef.current;
    try {
      const next = await window.electronAPI.wechatBot.resetWorkingDirectory();
      if (ownerEpochRef.current !== ownerEpoch) return;
      updateSeqRef.current += 1;
      setChannelSettings(next);
      toast.success(t('settings.wechatBot.toasts.workingDirReset'));
    } catch {
      log.error('failed to reset personal WeChat working directory');
      toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
    } finally {
      isUpdatingWorkingDirRef.current = false;
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
    refreshChannelSettings,
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
