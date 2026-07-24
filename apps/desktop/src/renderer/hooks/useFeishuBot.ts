/**
 * useFeishuBot
 * ---------------------------------------------------------------------------
 * Renderer-side hook for the FeiShu Bot settings card.
 *
 * State machine mirrors main process: idle / testing / connected / reconnecting
 *                                     / conflict / error
 *
 * Workflow:
 *   - On mount: pull initial state via getState(), subscribe to status push.
 *   - User fills appId + appSecret → setAppId / setAppSecret
 *   - User clicks Save → save() invokes IPC + handles toast
 *   - User clicks trash → clear() with confirm
 *   - Conflict events bubble up via context dialog (subscribed at App root)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { setFeishuNotificationsEnabled } from '@/hooks/useFeishuNotificationSettings';

const log = createLogger('useFeishuBot');

export type FeishuBotStatus =
  | 'idle'
  | 'testing'
  | 'connected'
  | 'reconnecting'
  | 'conflict'
  | 'error';

export interface UseFeishuBotReturn {
  /** 当前 input 框里的 appId（可能未保存） */
  appId: string;
  setAppId: (v: string) => void;
  /** 当前 input 框里的 appSecret（可能未保存） */
  appSecret: string;
  setAppSecret: (v: string) => void;

  /** 真实状态，由 main 推送驱动 */
  status: FeishuBotStatus;
  errorMessage: string | null;
  /** 是否已有持久化凭证（独立于当前连接状态） */
  hasSavedCreds: boolean;
  /** 已绑定的 owner openId（仅显示用，可能为 null） */
  ownerOpenId: string | null;

  /** 输入端验证错（appId 格式等） */
  validationError: string | null;

  /** 操作锁 */
  isSaving: boolean;
  isClearing: boolean;
  isReconnecting: boolean;
  saveSuccess: boolean;

  /** 上下线主动通知开关 */
  lifecycleAnnouncement: boolean;
  setLifecycleAnnouncement: (enabled: boolean) => void;

  save: () => Promise<boolean>;
  reconnect: () => Promise<boolean>;
  clear: () => Promise<void>;
}

const APP_ID_PATTERN = /^cli_[A-Za-z0-9]{10,30}$/;

// Module-level cache so re-mounting (e.g. switching settings tabs) doesn't
// flash the default `idle` state for one frame before IPC getState() resolves.
interface FeishuBotCache {
  appId: string;
  appSecret: string;
  status: FeishuBotStatus;
  errorMessage: string | null;
  hasSavedCreds: boolean;
  ownerOpenId: string | null;
  lifecycleAnnouncement: boolean;
}
let cachedState: FeishuBotCache | null = null;

export function useFeishuBot(): UseFeishuBotReturn {
  const { t } = useTranslation();
  const [appId, setAppIdState] = useState(() => cachedState?.appId ?? '');
  const [appSecret, setAppSecret] = useState(() => cachedState?.appSecret ?? '');
  const [status, setStatus] = useState<FeishuBotStatus>(() => cachedState?.status ?? 'idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(() => cachedState?.errorMessage ?? null);
  const [hasSavedCreds, setHasSavedCreds] = useState(() => cachedState?.hasSavedCreds ?? false);
  const [ownerOpenId, setOwnerOpenId] = useState<string | null>(() => cachedState?.ownerOpenId ?? null);
  const [lifecycleAnnouncement, setLifecycleAnnouncementState] = useState(() => cachedState?.lifecycleAnnouncement ?? true);

  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const saveSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRequestVersionRef = useRef(0);
  const statusPushVersionRef = useRef(0);
  const latestStatusPushRef = useRef<{
    status: FeishuBotStatus;
    errorMessage: string | null;
    ownerOpenId: string | null;
  } | null>(null);

  // 重新从 main 拉一次凭证 + 状态。挂载时和扫码注册成功后都要走一次,
  // 否则 device-code 流程在 main 写完凭证后, renderer 这边 appId/secret
  // 仍然停留在初始空字符串, 导致 ConnectedCard 显示空 + 跳转链接拼成
  // /app//event 落到飞书 app 列表页。
  const reloadState = useCallback(async (): Promise<void> => {
    const reloadRequestVersion = ++reloadRequestVersionRef.current;
    const statusPushVersion = statusPushVersionRef.current;
    try {
      const state = await window.electronAPI.feishuBot.getState();
      if (reloadRequestVersion !== reloadRequestVersionRef.current) return;
      const nextAppId = state.appId ?? '';
      const nextAppSecret = state.appSecret ?? '';
      const newerStatusPush =
        statusPushVersionRef.current !== statusPushVersion ? latestStatusPushRef.current : null;
      const nextStatus = newerStatusPush?.status ?? state.status;
      const nextErrorMessage = newerStatusPush
        ? newerStatusPush.errorMessage
        : (state.error ?? null);
      const nextOwnerOpenId = newerStatusPush ? newerStatusPush.ownerOpenId : state.ownerOpenId;
      setStatus(nextStatus);
      setHasSavedCreds(state.hasSecret);
      setOwnerOpenId(nextOwnerOpenId);
      setErrorMessage(nextErrorMessage);
      setLifecycleAnnouncementState(state.lifecycleAnnouncement);
      if (state.appId) {
        setAppIdState(state.appId);
      }
      if (state.appSecret) {
        setAppSecret(state.appSecret);
      }
      cachedState = {
        appId: nextAppId || cachedState?.appId || '',
        appSecret: nextAppSecret || cachedState?.appSecret || '',
        status: nextStatus,
        errorMessage: nextErrorMessage,
        hasSavedCreds: state.hasSecret,
        ownerOpenId: nextOwnerOpenId,
        lifecycleAnnouncement: state.lifecycleAnnouncement,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('getState failed:', msg);
    }
  }, []);

  // ── status push subscription ─────────────────────────────────────────────
  useEffect(() => {
    const unsub = window.electronAPI.feishuBot.onStatusChange((update) => {
      const nextErrorMessage = update.error ?? null;
      statusPushVersionRef.current += 1;
      latestStatusPushRef.current = {
        status: update.status,
        errorMessage: nextErrorMessage,
        ownerOpenId: update.ownerOpenId,
      };
      setStatus(update.status);
      setErrorMessage(nextErrorMessage);
      setOwnerOpenId(update.ownerOpenId);
      if (cachedState) {
        cachedState = {
          ...cachedState,
          status: update.status,
          errorMessage: nextErrorMessage,
          ownerOpenId: update.ownerOpenId,
        };
      }
    });
    return unsub;
  }, []);

  // Subscribe before starting the initial read so a push cannot fall between
  // getState's snapshot and listener registration.
  useEffect(() => {
    void reloadState();
  }, [reloadState]);

  // ── registration success: hydrate from payload + refetch ────────────────
  // device-code 流程不走 save() 路径, payload 里直接有 appId/ownerOpenId,
  // 立刻 hydrate 防止 ConnectedCard 显示空 + 跳转链接拼成 /app//event。
  // appSecret 不在 payload 里, 走 reloadState 兜。
  useEffect(() => {
    const unsub = window.electronAPI.feishuBot.onRegistrationStatus((payload) => {
      if (payload.status !== 'success') return;
      if (payload.appId) {
        setAppIdState(payload.appId);
      }
      if (payload.ownerOpenId) {
        setOwnerOpenId(payload.ownerOpenId);
      }
      setHasSavedCreds(true);
      if (cachedState) {
        cachedState = {
          ...cachedState,
          appId: payload.appId ?? cachedState.appId,
          ownerOpenId: payload.ownerOpenId ?? cachedState.ownerOpenId,
          hasSavedCreds: true,
        };
      }
      void reloadState();
    });
    return unsub;
  }, [reloadState]);

  // ── setters with validation ──────────────────────────────────────────────
  const setAppId = useCallback((v: string) => {
    setAppIdState(v);
    setValidationError(null);
    if (saveSuccess) setSaveSuccess(false);
  }, [saveSuccess]);

  // ── actions ──────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (isSaving) return false;
    const trimmedAppId = appId.trim();
    const trimmedSecret = appSecret.trim();

    if (!trimmedAppId || !trimmedSecret) {
      setValidationError(t('logic.validation.feishuFieldsRequired'));
      return false;
    }
    if (!APP_ID_PATTERN.test(trimmedAppId)) {
      setValidationError(t('logic.validation.feishuAppIdFormat'));
      return false;
    }

    setValidationError(null);
    setIsSaving(true);

    try {
      const { verdict } = await window.electronAPI.feishuBot.save({
        appId: trimmedAppId,
        appSecret: trimmedSecret,
      });

      // A non-connected verdict can still coexist with persisted credentials.
      // Re-read main's current state instead of treating an earlier transport
      // verdict as either the binding state or the latest live status.
      if (verdict !== 'connected') {
        await reloadState();
      }

      if (verdict === 'connected') {
        setStatus('connected');
        setHasSavedCreds(true);
        setSaveSuccess(true);
        cachedState = {
          appId: trimmedAppId,
          appSecret: trimmedSecret,
          status: 'connected',
          errorMessage: null,
          hasSavedCreds: true,
          ownerOpenId: cachedState?.ownerOpenId ?? null,
          lifecycleAnnouncement: cachedState?.lifecycleAnnouncement ?? true,
        };
        toast.success(t('logic.toasts.feishuBotConnected'));
        if (saveSuccessTimerRef.current) clearTimeout(saveSuccessTimerRef.current);
        saveSuccessTimerRef.current = setTimeout(() => setSaveSuccess(false), 2500);
        return true;
      }

      if (verdict === 'pending') {
        return true;
      }

      if (verdict === 'conflict') {
        toast.error(t('logic.toasts.feishuBotConflict'));
        return false;
      }

      toast.error(t('logic.toasts.feishuBotConnectFailed'));
      return false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('error');
      toast.error(t('logic.toasts.feishuBotSaveFailed', { message: msg }));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [appId, appSecret, isSaving, reloadState, t]);

  const clear = useCallback(async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      await window.electronAPI.feishuBot.clear();
      setHasSavedCreds(false);
      setOwnerOpenId(null);
      setAppIdState('');
      setAppSecret('');
      setStatus('idle');
      setErrorMessage(null);
      cachedState = {
        appId: '',
        appSecret: '',
        status: 'idle',
        errorMessage: null,
        hasSavedCreds: false,
        ownerOpenId: null,
        lifecycleAnnouncement: cachedState?.lifecycleAnnouncement ?? true,
      };
      // 解绑 bot 后顺手把"飞书通知"开关落 false,避免:
      //   - main 侧每次任务事件 warn 一行 ownerOpenId 缺失
      //   - NotificationSection 上开关呈 disabled 但 checked=true 的幽灵态,
      //     用户也点不动
      // 与 NotificationSection 的 useEffect 兜底是双层保险:这里命中"解绑"
      // 这个具体动作,effect 那层兜底任何残留(旧版升级 / 异常路径)。
      setFeishuNotificationsEnabled(false);
      toast.success(t('logic.toasts.feishuBotCleared'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t('logic.toasts.feishuBotClearFailed', { message: msg }));
    } finally {
      setIsClearing(false);
    }
  }, [isClearing, t]);

  const reconnect = useCallback(async () => {
    if (isReconnecting) return false;
    setIsReconnecting(true);
    try {
      const { verdict } = await window.electronAPI.feishuBot.reconnect();
      if (verdict === 'connected') {
        setStatus('connected');
        setErrorMessage(null);
        if (cachedState) {
          cachedState = { ...cachedState, status: 'connected', errorMessage: null };
        }
        toast.success(t('logic.toasts.feishuBotReconnected'));
        return true;
      }
      if (verdict === 'conflict') {
        setStatus('conflict');
        toast.error(t('logic.toasts.feishuBotConflict'));
        return false;
      }
      setStatus('error');
      toast.error(t('logic.toasts.feishuBotReconnectFailed'));
      return false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('reconnect failed:', msg);
      toast.error(t('logic.toasts.feishuBotReconnectFailed'));
      return false;
    } finally {
      setIsReconnecting(false);
    }
  }, [isReconnecting, t]);

  const setLifecycleAnnouncement = useCallback((enabled: boolean) => {
    setLifecycleAnnouncementState(enabled);
    if (cachedState) cachedState = { ...cachedState, lifecycleAnnouncement: enabled };
    window.electronAPI.feishuBot.setLifecycleAnnouncement(enabled).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('setLifecycleAnnouncement failed:', msg);
    });
  }, []);

  return {
    appId,
    setAppId,
    appSecret,
    setAppSecret,
    status,
    errorMessage,
    hasSavedCreds,
    ownerOpenId,
    lifecycleAnnouncement,
    setLifecycleAnnouncement,
    validationError,
    isSaving,
    isClearing,
    isReconnecting,
    saveSuccess,
    save,
    reconnect,
    clear,
  };
}
