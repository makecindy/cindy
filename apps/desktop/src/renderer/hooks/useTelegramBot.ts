import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('useTelegramBot');
/** Telegram 数字 user id(私聊 chat id 同值);现网长度 5-15 位左右, 放宽到 4-20。 */
const OWNER_USER_ID_PATTERN = /^\d{4,20}$/;
/** BotFather token 形态: `<botId>:<secret>` — 只做粗校验挡手滑。 */
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;

interface TelegramBotCache {
  ownerUserId: string;
  botUsername: string | null;
  status: TelegramBotTransportStatus;
}

let cachedState: TelegramBotCache | null = null;

/**
 * 把传输层状态翻成当前语言的失败原因。
 *
 * main 层的 `reason` 是诊断原文——既有英文技术串(`network unreachable`)也有硬编码
 * 中文,直接塞进 toast 会给非中文用户拼出混合语言。稳定分类走 `code` → i18n key;
 * 只有旧路径/其它渠道没带 code 时才回退 reason(总比空白强)。
 */
export function describeTelegramStatusFailure(
  status: TelegramBotTransportStatus,
  t: (key: string) => string,
): string {
  if (status.kind !== 'error') return t(`settings.telegramBot.status.${status.kind}`);
  if (status.code) return t(`settings.telegramBot.errorCode.${status.code}`);
  return status.reason;
}

export interface UseTelegramBotReturn {
  token: string;
  setToken: (v: string) => void;
  ownerUserId: string;
  setOwnerUserId: (v: string) => void;
  status: TelegramBotTransportStatus;
  botUsername: string | null;
  validationError: string | null;
  isSaving: boolean;
  isDisconnecting: boolean;
  /** 上线/下线切换在途(与解绑分开, 两个按钮各自禁用)。 */
  isTogglingOnline: boolean;
  canConnect: boolean;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  /** 只切轮询, 保留 token 与绑定信息 —— 与 disconnect(清凭证)是两个动作。 */
  setOnline: (online: boolean) => Promise<void>;
}

/** 个人 Telegram bot 设置卡的状态钩子 — 与 useDiscordBot 同构(token 手填模式)。 */
export function useTelegramBot(): UseTelegramBotReturn {
  const { t } = useTranslation();
  const [token, setTokenState] = useState('');
  const [ownerUserId, setOwnerUserIdState] = useState(() => cachedState?.ownerUserId ?? '');
  const [botUsername, setBotUsername] = useState<string | null>(
    () => cachedState?.botUsername ?? null,
  );
  const [status, setStatus] = useState<TelegramBotTransportStatus>(
    () => cachedState?.status ?? { kind: 'idle' },
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isTogglingOnline, setIsTogglingOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await window.electronAPI.telegramBot.getStatus();
        if (cancelled) return;
        const nextOwnerUserId = state.ownerUserId ?? '';
        setStatus(state.status);
        setOwnerUserIdState(nextOwnerUserId);
        setBotUsername(state.botUsername);
        cachedState = {
          ownerUserId: nextOwnerUserId,
          botUsername: state.botUsername,
          status: state.status,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('getStatus failed:', msg);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsub = window.electronAPI.telegramBot.onStatusChange((update) => {
      setStatus(update.status);
      setBotUsername(update.botUsername);
      cachedState = {
        ownerUserId: cachedState?.ownerUserId ?? '',
        botUsername: update.botUsername,
        status: update.status,
      };
    });
    return unsub;
  }, []);

  const setToken = useCallback((v: string) => {
    setTokenState(v);
    setValidationError(null);
  }, []);

  const setOwnerUserId = useCallback((v: string) => {
    setOwnerUserIdState(v);
    setValidationError(null);
  }, []);

  const connect = useCallback(async () => {
    if (isSaving) return false;
    const trimmedToken = token.trim();
    const trimmedOwnerUserId = ownerUserId.trim();

    if (!trimmedToken || !trimmedOwnerUserId) {
      setValidationError(t('logic.validation.telegramFieldsRequired'));
      return false;
    }
    if (!BOT_TOKEN_PATTERN.test(trimmedToken)) {
      setValidationError(t('logic.validation.telegramTokenFormat'));
      return false;
    }
    if (!OWNER_USER_ID_PATTERN.test(trimmedOwnerUserId)) {
      setValidationError(t('logic.validation.telegramOwnerUserIdFormat'));
      return false;
    }

    setValidationError(null);
    setIsSaving(true);
    try {
      const result = await window.electronAPI.telegramBot.setConfig({
        token: trimmedToken,
        ownerUserId: trimmedOwnerUserId,
      });
      const canonicalOwnerUserId = result.ownerUserId ?? '';
      setStatus(result.status);
      setOwnerUserIdState(canonicalOwnerUserId);
      setBotUsername(result.botUsername);
      cachedState = {
        ownerUserId: canonicalOwnerUserId,
        botUsername: result.botUsername,
        status: result.status,
      };
      if (result.saveErrorStatus?.kind === 'error' || result.status.kind === 'error') {
        toast.error(t('logic.toasts.telegramBotConnectFailed'));
        return false;
      }
      toast.success(t('logic.toasts.telegramBotConnected'));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('setConfig failed:', msg);
      toast.error(t('logic.toasts.telegramBotSaveFailed', { message: msg }));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, ownerUserId, t, token]);

  const disconnect = useCallback(async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      const result = await window.electronAPI.telegramBot.disconnect();
      setStatus(result.status);
      setOwnerUserIdState('');
      setTokenState('');
      setBotUsername(null);
      setValidationError(null);
      cachedState = {
        ownerUserId: '',
        botUsername: null,
        status: result.status,
      };
      toast.success(t('logic.toasts.telegramBotDisconnected'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('disconnect failed:', msg);
      toast.error(t('logic.toasts.telegramBotDisconnectFailed', { message: msg }));
    } finally {
      setIsDisconnecting(false);
    }
  }, [isDisconnecting, t]);

  const setOnline = useCallback(
    async (online: boolean) => {
      if (isTogglingOnline) return;
      setIsTogglingOnline(true);
      try {
        const result = await window.electronAPI.telegramBot.setOnline({ online });
        setStatus(result.status);
        // 与 disconnect 的关键差异: 绑定信息一律保留, 不清 owner/botUsername。
        cachedState = {
          ownerUserId: cachedState?.ownerUserId ?? '',
          botUsername: cachedState?.botUsername ?? null,
          status: result.status,
        };
        // IPC 正常 resolve ≠ 切换成功: 上线可能因 token 失效/网络不可达落到 error,
        // 下线可能因安全存储写不进而保持原样。只有真到达目标态才报成功, 否则用户
        // 会拿到一个「其实没发生」的确认。
        const reached = online ? result.status.kind === 'connected' : result.status.kind === 'offline';
        if (!reached) {
          toast.error(
            t('logic.toasts.telegramBotToggleOnlineFailed', {
              message: describeTelegramStatusFailure(result.status, t),
            }),
          );
          return;
        }
        toast.success(
          online
            ? t('logic.toasts.telegramBotWentOnline')
            : t('logic.toasts.telegramBotWentOffline'),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('setOnline failed:', msg);
        toast.error(t('logic.toasts.telegramBotToggleOnlineFailed', { message: msg }));
      } finally {
        setIsTogglingOnline(false);
      }
    },
    [isTogglingOnline, t],
  );

  const canConnect =
    BOT_TOKEN_PATTERN.test(token.trim()) &&
    OWNER_USER_ID_PATTERN.test(ownerUserId.trim()) &&
    !isSaving &&
    !isDisconnecting &&
    !isTogglingOnline;

  return {
    token,
    setToken,
    ownerUserId,
    setOwnerUserId,
    status,
    botUsername,
    validationError,
    isSaving,
    isDisconnecting,
    isTogglingOnline,
    canConnect,
    connect,
    disconnect,
    setOnline,
  };
}
