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
  /**
   * 更新在途期间到达的 boundary-ready: 此刻拉取会被在途守卫跳过、读到提交前
   * 旧配置, 只能记下来, 由 choose/reset 收尾(finishWorkingDirUpdate)补拉 —
   * ready 一轮登录只广播一次, 跳过即永久丢失(切号后设置停在 null)。
   */
  const pendingBoundaryReadyRef = useRef(false);

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

  /**
   * choose/reset 结果因 owner 代次推进被丢弃后的收敛(与企微 hook 同款)。
   * Main 侧可能已把新状态落盘并返回(代次推进未必伴随 IM 账号切换, 如同账号
   * 重新登录推进 ownerGeneration), 但代次推进触发的渠道设置读取出发于提交
   * 之前 — 迟到落地会带着提交前的旧配置, 把已落盘的新状态盖掉或停在旧值上。
   * 先推进 updateSeq 作废这些在途旧读取, 再为当前 owner 重拉一次 — 重拉在
   * Main 返回之后发起, 必然读到已提交状态。
   */
  const refetchAfterOwnerFlip = useCallback((): void => {
    // 这里的收敛读取已覆盖「ready 待补拉」的意图 — 清掉 pending, 防止收尾
    // 时对同一目标重复拉取。
    pendingBoundaryReadyRef.current = false;
    updateSeqRef.current += 1;
    void fetchChannelSettings();
  }, [fetchChannelSettings]);

  /**
   * choose/reset 的统一收尾: 先解除更新在途守卫, 再补拉更新期间到达的
   * boundary-ready(若有)。补拉发生在 choose/reset 完全结束之后, ready 又已
   * 表示新账号边界激活 — 此时读到的是当前 owner 的已落盘状态; 迟到守卫照常,
   * ownerEpoch 再推进则丢弃, 由推进方自己的重拉兜底。
   */
  const finishWorkingDirUpdate = useCallback((): void => {
    isUpdatingWorkingDirRef.current = false;
    if (!pendingBoundaryReadyRef.current) return;
    pendingBoundaryReadyRef.current = false;
    void fetchChannelSettings();
  }, [fetchChannelSettings]);

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

  useEffect(
    () =>
      // 冷启动/换号窗口: 挂载首拉撞上 IM 账号边界未激活会被 Main fail-closed
      // 拒绝([IM_NOT_READY]), 设置停在 null; Main 在边界激活时广播 ready,
      // 到达即重拉, 不必等 focus/设置卡展开。迟到守卫不变 — ownerEpoch/
      // updateSeq 已推进的响应照旧丢弃。更新在途时不能拉也不能丢: 记入
      // pending, 由 choose/reset 收尾(finishWorkingDirUpdate)补拉。
      window.electronAPI.onImAccountBoundaryReady(() => {
        if (isUpdatingWorkingDirRef.current) {
          pendingBoundaryReadyRef.current = true;
          return;
        }
        void refreshChannelSettings();
      }),
    [refreshChannelSettings],
  );

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
      if (ownerEpochRef.current !== ownerEpoch) {
        // 代次推进丢弃结果, 但 Main 可能已提交 — 收敛到已落盘状态, 不停在
        // 代次推进触发的提交前旧读取上。
        refetchAfterOwnerFlip();
        return;
      }
      updateSeqRef.current += 1;
      setChannelSettings(result.state);
      if (!result.canceled) toast.success(t('settings.wechatBot.toasts.workingDirSaved'));
    } catch {
      log.error('failed to choose personal WeChat working directory');
      toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
    } finally {
      finishWorkingDirUpdate();
      setIsUpdatingWorkingDir(false);
    }
  }, [finishWorkingDirUpdate, isUpdatingWorkingDir, refetchAfterOwnerFlip, t]);

  const resetWorkingDirectory = useCallback(async (): Promise<void> => {
    if (isUpdatingWorkingDir) return;
    setIsUpdatingWorkingDir(true);
    isUpdatingWorkingDirRef.current = true;
    const ownerEpoch = ownerEpochRef.current;
    try {
      const next = await window.electronAPI.wechatBot.resetWorkingDirectory();
      if (ownerEpochRef.current !== ownerEpoch) {
        // 代次推进丢弃结果, 但 Main 可能已删除配置 — 收敛到已落盘状态。
        refetchAfterOwnerFlip();
        return;
      }
      updateSeqRef.current += 1;
      setChannelSettings(next);
      toast.success(t('settings.wechatBot.toasts.workingDirReset'));
    } catch {
      log.error('failed to reset personal WeChat working directory');
      toast.error(t('settings.wechatBot.toasts.workingDirFailed'));
    } finally {
      finishWorkingDirUpdate();
      setIsUpdatingWorkingDir(false);
    }
  }, [finishWorkingDirUpdate, isUpdatingWorkingDir, refetchAfterOwnerFlip, t]);

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
