import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('useWecomBot');

interface CachedState {
  status: WecomBotTransportStatus;
  botId: string;
  ownerUserId: string;
}

let cachedState: CachedState | null = null;

export function useWecomBot() {
  const { t } = useTranslation();
  const [botId, setBotId] = useState(() => cachedState?.botId ?? '');
  const [secret, setSecret] = useState('');
  const [ownerUserId, setOwnerUserId] = useState(() => cachedState?.ownerUserId ?? '');
  const [status, setStatus] = useState<WecomBotTransportStatus>(
    () => cachedState?.status ?? { kind: 'idle' },
  );
  // 渠道设置不做模块级缓存种子: 缓存不按数据 owner 隔离, 切号后会把上一账号
  // 的绝对路径闪给新账号。挂载/展开时现拉, 数据本地且量小。
  const [channelSettings, setChannelSettings] = useState<WecomChannelSettingsState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isUpdatingWorkingDir, setIsUpdatingWorkingDir] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  /**
   * owner 代次: 仅在 owner 变化(含首次确定)与卸载时递增。所有渠道设置的异步
   * 写回(读取/选择/重置)只有发起时的 owner 代次仍有效才允许落地 — 迟到的旧
   * owner 响应不得把上一账号的绝对路径写给新账号。同 owner 内的并发请求**不**
   * 递增: focus 触发的并发刷新与选择器结果互相竞争时丢弃后者, 会让新选的
   * 目录显示不出来(实测回归)。
   */
  const ownerEpochRef = useRef(0);
  /**
   * 工作目录更新落地序号: choose/reset 结果写回时递增。早于一次更新出发的
   * 读取可能带着提交前的旧配置、在更新结果之后才返回 — 这种读取按序号丢弃。
   */
  const updateSeqRef = useRef(0);
  /** isUpdatingWorkingDir 的 ref 镜像: refreshChannelSettings 的在途守卫用。 */
  const isUpdatingWorkingDirRef = useRef(false);
  /** null = 尚未确定 owner(冷启动, 无模块缓存种子)。 */
  const ownerRef = useRef<string | null>(cachedState?.ownerUserId ?? null);
  /** 推送代次: 挂载快照归来前已有推送先行到达时, 丢弃过期快照(同 useWechatBot)。 */
  const pushVersionRef = useRef(0);
  /**
   * Cindy 数据 owner 的真身(mode+dataOwnerId+ownerGeneration)。企微的
   * ownerUserId 不是身份判据: 两个 Cindy 账号可能绑同一个企微用户, 两边
   * 都没配置企微时又同为空串 — 这些换号只有 auth 推送区分得了。
   */
  const cindyOwnerRef = useRef<string | null>(null);

  /** 拉取当前 owner 的渠道设置;owner 或更新序号已推进的迟到响应不写回。 */
  const fetchChannelSettings = useCallback(async (): Promise<void> => {
    const ownerEpoch = ownerEpochRef.current;
    const updateSeq = updateSeqRef.current;
    try {
      const settings = await window.electronAPI.wecomBot.getChannelSettings();
      if (ownerEpochRef.current !== ownerEpoch || updateSeqRef.current !== updateSeq) return;
      setChannelSettings(settings);
    } catch (error) {
      log.error(
        'getChannelSettings failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  /**
   * choose/reset 结果因 owner 翻转被丢弃后的收敛。Main 侧已把新状态落盘并
   * 返回 — TOFU 首绑定(''→sender)只是渠道维度换 owner, 不动 IM 账号代次,
   * Main 照常提交; 但 owner 翻转触发的渠道设置读取出发于提交之前, 迟到落地
   * 会带着提交前的旧配置, 把已落盘的新状态盖掉或停在旧值上。先推进
   * updateSeq 作废这些在途旧读取, 再为当前 owner 重拉一次 — 重拉在 Main
   * 返回之后发起, 必然读到已提交状态。
   */
  const refetchAfterOwnerFlip = useCallback((): void => {
    updateSeqRef.current += 1;
    void fetchChannelSettings();
  }, [fetchChannelSettings]);

  /**
   * 统一的状态落地。ownerUserId 变化(含首次确定)= 数据主人换了: 立即失效
   * 旧 owner 的渠道设置(绝对路径不得跨账号展示), 作废在途响应, 并重拉新
   * owner 的设置。在途请求无法保证服务于哪个 owner — 宁可多拉一次本地小数据。
   */
  const applyState = useCallback(
    (next: CachedState) => {
      cachedState = next;
      setStatus(next.status);
      setBotId(next.botId);
      if (ownerRef.current !== next.ownerUserId) {
        ownerRef.current = next.ownerUserId;
        ownerEpochRef.current += 1;
        setChannelSettings(null);
        void fetchChannelSettings();
      }
      setOwnerUserId(next.ownerUserId);
      if (next.status.kind === 'connected') setSecret('');
    },
    [fetchChannelSettings],
  );

  useEffect(() => {
    let cancelled = false;
    const initialPushVersion = pushVersionRef.current;
    void window.electronAPI.wecomBot
      .getStatus()
      .then((state) => {
        if (cancelled) return;
        if (pushVersionRef.current !== initialPushVersion) return;
        applyState({
          status: state.status,
          botId: state.botId ?? '',
          ownerUserId: state.ownerUserId ?? '',
        });
      })
      .catch((error) => {
        log.error('getStatus failed:', error instanceof Error ? error.message : String(error));
      });
    // owner 上下文已知(有模块缓存种子, 含已断开的 '' owner)才挂载即拉;完全
    // 未知(首次冷启动)时由 applyState 首次确定 owner 后再拉 — 拉早了无法
    // 保证请求服务于哪个 owner。
    if (cachedState) void fetchChannelSettings();
    return () => {
      cancelled = true;
      // 卸载作废在途响应(比 cancelled 标志多覆盖 fetchChannelSettings 一路)。
      ownerEpochRef.current += 1;
    };
  }, [applyState, fetchChannelSettings]);

  useEffect(
    () =>
      window.electronAPI.wecomBot.onStatusChange((state) => {
        pushVersionRef.current += 1;
        applyState({
          status: state.status,
          botId: state.botId ?? cachedState?.botId ?? '',
          ownerUserId: state.ownerUserId ?? '',
        });
      }),
    [applyState],
  );

  useEffect(() => {
    // Cindy 账号切换(登录/登出/换号)即时失效渠道设置: Main 侧守卫只拦得住
    // 迟到响应, 清不掉已经渲染出来的旧路径 — 失效必须在 renderer 侧做。
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

  const connect = useCallback(async () => {
    if (isSaving) return false;
    const nextBotId = botId.trim();
    const nextSecret = secret.trim();
    if (!nextBotId || !nextSecret) {
      setValidationError(t('settings.wecomBot.fieldsRequired'));
      return false;
    }
    setValidationError(null);
    setIsSaving(true);
    try {
      const result = await window.electronAPI.wecomBot.setConfig({
        botId: nextBotId,
        secret: nextSecret,
      });
      applyState({
        status: result.status,
        botId: result.botId ?? nextBotId,
        ownerUserId: result.ownerUserId ?? '',
      });
      if (result.saveErrorStatus?.kind === 'error' || result.status.kind === 'error') {
        toast.error(t('settings.wecomBot.connectFailed'));
        return false;
      }
      toast.success(t('settings.wecomBot.configSaved'));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('setConfig failed:', message);
      toast.error(t('settings.wecomBot.saveFailed', { message }));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [applyState, botId, isSaving, secret, t]);

  const reconnect = useCallback(async () => {
    if (isSaving || !botId.trim()) return false;
    setValidationError(null);
    setIsSaving(true);
    try {
      const result = await window.electronAPI.wecomBot.reconnect();
      applyState({
        status: result.status,
        botId: result.botId ?? botId.trim(),
        ownerUserId: result.ownerUserId ?? '',
      });
      if (result.status.kind === 'error') {
        toast.error(t('settings.wecomBot.connectFailed'));
        return false;
      }
      toast.success(t('settings.wecomBot.reconnecting'));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('reconnect failed:', message);
      toast.error(t('settings.wecomBot.reconnectFailed', { message }));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [applyState, botId, isSaving, t]);

  const disconnect = useCallback(async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      const result = await window.electronAPI.wecomBot.disconnect();
      applyState({ status: result.status, botId: '', ownerUserId: '' });
      setSecret('');
      setValidationError(null);
      toast.success(t('settings.wecomBot.disconnected'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('disconnect failed:', message);
      toast.error(t('settings.wecomBot.disconnectFailed', { message }));
    } finally {
      setIsDisconnecting(false);
    }
  }, [applyState, isDisconnecting, t]);

  const chooseWorkingDirectory = useCallback(async (): Promise<void> => {
    if (isUpdatingWorkingDir) return;
    setIsUpdatingWorkingDir(true);
    isUpdatingWorkingDirRef.current = true;
    const ownerEpoch = ownerEpochRef.current;
    try {
      const result = await window.electronAPI.wecomBot.chooseWorkingDirectory();
      // 原生弹窗 + Main 侧异步探测期间可能切号: 仅 owner 变化才丢弃。
      // 同 owner 内 focus 触发的并发刷新不构成丢弃理由 — 这里返回的是刚
      // 落盘的最新状态, 丢弃它会让新目录显示不出来(实测回归)。
      if (ownerEpochRef.current !== ownerEpoch) {
        // owner 翻转丢弃结果, 但 Main 已提交 — 收敛到已落盘状态, 不停在
        // 翻转触发的提交前旧读取上。
        refetchAfterOwnerFlip();
        return;
      }
      updateSeqRef.current += 1;
      setChannelSettings(result.state);
      if (!result.canceled) toast.success(t('settings.wecomBot.workingDirSaved'));
    } catch (error) {
      log.error(
        'chooseWorkingDirectory failed:',
        error instanceof Error ? error.message : String(error),
      );
      toast.error(t('settings.wecomBot.workingDirFailed'));
    } finally {
      isUpdatingWorkingDirRef.current = false;
      setIsUpdatingWorkingDir(false);
    }
  }, [isUpdatingWorkingDir, refetchAfterOwnerFlip, t]);

  const resetWorkingDirectory = useCallback(async (): Promise<void> => {
    if (isUpdatingWorkingDir) return;
    setIsUpdatingWorkingDir(true);
    isUpdatingWorkingDirRef.current = true;
    const ownerEpoch = ownerEpochRef.current;
    try {
      const next = await window.electronAPI.wecomBot.resetWorkingDirectory();
      if (ownerEpochRef.current !== ownerEpoch) {
        // owner 翻转丢弃结果, 但 Main 已删除配置 — 收敛到已落盘状态。
        refetchAfterOwnerFlip();
        return;
      }
      updateSeqRef.current += 1;
      setChannelSettings(next);
      toast.success(t('settings.wecomBot.workingDirReset'));
    } catch (error) {
      log.error(
        'resetWorkingDirectory failed:',
        error instanceof Error ? error.message : String(error),
      );
      toast.error(t('settings.wecomBot.workingDirFailed'));
    } finally {
      isUpdatingWorkingDirRef.current = false;
      setIsUpdatingWorkingDir(false);
    }
  }, [isUpdatingWorkingDir, refetchAfterOwnerFlip, t]);

  /** 拉取最新渠道设置 — 设置卡展开时刷新, 让「目录不可用」警告及时出现。 */
  const refreshChannelSettings = useCallback(async (): Promise<void> => {
    // 工作目录更新在途时跳过: 原生选择器关窗会触发 focus 刷新, 这次读取
    // 大概率读到提交前的旧配置; choose/reset 返回的状态才是最新的。
    if (isUpdatingWorkingDirRef.current) return;
    await fetchChannelSettings();
  }, [fetchChannelSettings]);

  useEffect(
    () =>
      // 冷启动/换号窗口: 首次拉取撞上 IM 账号边界未激活会被 Main fail-closed
      // 拒绝([IM_NOT_READY]), 设置停在 null; Main 在边界激活时广播 ready,
      // 到达即重拉, 不必等设置卡展开。迟到守卫不变 — ownerEpoch/updateSeq
      // 已推进的响应照旧丢弃, 更新在途时 refreshChannelSettings 自会跳过
      // (其结果由 choose/reset 落地的新状态取代)。
      window.electronAPI.onImAccountBoundaryReady(() => {
        void refreshChannelSettings();
      }),
    [refreshChannelSettings],
  );

  return {
    botId,
    setBotId: (value: string) => {
      setBotId(value);
      setValidationError(null);
    },
    secret,
    setSecret: (value: string) => {
      setSecret(value);
      setValidationError(null);
    },
    ownerUserId,
    status,
    channelSettings,
    validationError,
    isSaving,
    isDisconnecting,
    isUpdatingWorkingDir,
    canConnect: Boolean(
      botId.trim() &&
      secret.trim() &&
      status.kind !== 'connecting' &&
      !isSaving &&
      !isDisconnecting,
    ),
    canReconnect: Boolean(
      botId.trim() &&
      !secret.trim() &&
      status.kind !== 'connecting' &&
      !isSaving &&
      !isDisconnecting,
    ),
    connect,
    reconnect,
    disconnect,
    chooseWorkingDirectory,
    resetWorkingDirectory,
    refreshChannelSettings,
  };
}

export const __testing = {
  resetCache(): void {
    cachedState = null;
  },
  getCache(): CachedState | null {
    return cachedState;
  },
};
