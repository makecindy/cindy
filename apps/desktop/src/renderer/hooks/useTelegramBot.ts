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
  canConnect: boolean;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
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

  const canConnect =
    BOT_TOKEN_PATTERN.test(token.trim()) &&
    OWNER_USER_ID_PATTERN.test(ownerUserId.trim()) &&
    !isSaving &&
    !isDisconnecting;

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
    canConnect,
    connect,
    disconnect,
  };
}
