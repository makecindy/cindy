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
   * 渠道设置写回的代次。每次发起新请求(挂载/刷新/选择/重置)递增;切号与卸载
   * 也递增以作废在途响应。异步结果只有发起时的代次仍是当前代次才允许写回 —
   * 否则账号 A 的旧请求晚于账号 B 的请求返回时, 会把 A 的绝对路径覆盖给 B。
   */
  const settingsEpochRef = useRef(0);
  /** null = 尚未确定 owner(冷启动, 无模块缓存种子)。 */
  const ownerRef = useRef<string | null>(cachedState?.ownerUserId ?? null);
  /** 推送代次: 挂载快照归来前已有推送先行到达时, 丢弃过期快照(同 useWechatBot)。 */
  const pushVersionRef = useRef(0);

  /** 拉取当前 owner 的渠道设置;递增代次, 迟到的旧响应不写回。 */
  const fetchChannelSettings = useCallback(async (): Promise<void> => {
    const epoch = ++settingsEpochRef.current;
    try {
      const settings = await window.electronAPI.wecomBot.getChannelSettings();
      if (settingsEpochRef.current !== epoch) return;
      setChannelSettings(settings);
    } catch (error) {
      log.error(
        'getChannelSettings failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

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
        settingsEpochRef.current += 1;
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
      settingsEpochRef.current += 1;
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
    const epoch = ++settingsEpochRef.current;
    try {
      const result = await window.electronAPI.wecomBot.chooseWorkingDirectory();
      // 原生弹窗 + Main 侧异步探测期间可能切号: 迟到结果不得写回。
      if (settingsEpochRef.current !== epoch) return;
      setChannelSettings(result.state);
      if (!result.canceled) toast.success(t('settings.wecomBot.workingDirSaved'));
    } catch (error) {
      log.error(
        'chooseWorkingDirectory failed:',
        error instanceof Error ? error.message : String(error),
      );
      toast.error(t('settings.wecomBot.workingDirFailed'));
    } finally {
      setIsUpdatingWorkingDir(false);
    }
  }, [isUpdatingWorkingDir, t]);

  const resetWorkingDirectory = useCallback(async (): Promise<void> => {
    if (isUpdatingWorkingDir) return;
    setIsUpdatingWorkingDir(true);
    const epoch = ++settingsEpochRef.current;
    try {
      const next = await window.electronAPI.wecomBot.resetWorkingDirectory();
      if (settingsEpochRef.current !== epoch) return;
      setChannelSettings(next);
      toast.success(t('settings.wecomBot.workingDirReset'));
    } catch (error) {
      log.error(
        'resetWorkingDirectory failed:',
        error instanceof Error ? error.message : String(error),
      );
      toast.error(t('settings.wecomBot.workingDirFailed'));
    } finally {
      setIsUpdatingWorkingDir(false);
    }
  }, [isUpdatingWorkingDir, t]);

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
    refreshChannelSettings: fetchChannelSettings,
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
