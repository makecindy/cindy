import { useCallback, useEffect, useState } from 'react';
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
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.wecomBot
      .getStatus()
      .then((state) => {
        if (cancelled) return;
        const next = {
          status: state.status,
          botId: state.botId ?? '',
          ownerUserId: state.ownerUserId ?? '',
        };
        cachedState = next;
        setStatus(next.status);
        setBotId(next.botId);
        setOwnerUserId(next.ownerUserId);
      })
      .catch((error) => {
        log.error('getStatus failed:', error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      window.electronAPI.wecomBot.onStatusChange((state) => {
        const next = {
          status: state.status,
          botId: state.botId ?? cachedState?.botId ?? '',
          ownerUserId: state.ownerUserId ?? '',
        };
        cachedState = next;
        setStatus(next.status);
        setBotId(next.botId);
        setOwnerUserId(next.ownerUserId);
        if (next.status.kind === 'connected') setSecret('');
      }),
    [],
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
      const next = {
        status: result.status,
        botId: result.botId ?? nextBotId,
        ownerUserId: result.ownerUserId ?? '',
      };
      cachedState = next;
      setStatus(next.status);
      setBotId(next.botId);
      setOwnerUserId(next.ownerUserId);
      if (next.status.kind === 'connected') setSecret('');
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
  }, [botId, isSaving, secret, t]);

  const reconnect = useCallback(async () => {
    if (isSaving || !botId.trim()) return false;
    setValidationError(null);
    setIsSaving(true);
    try {
      const result = await window.electronAPI.wecomBot.reconnect();
      const next = {
        status: result.status,
        botId: result.botId ?? botId.trim(),
        ownerUserId: result.ownerUserId ?? '',
      };
      cachedState = next;
      setStatus(next.status);
      setBotId(next.botId);
      setOwnerUserId(next.ownerUserId);
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
  }, [botId, isSaving, t]);

  const disconnect = useCallback(async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      const result = await window.electronAPI.wecomBot.disconnect();
      const next = { status: result.status, botId: '', ownerUserId: '' };
      cachedState = next;
      setStatus(next.status);
      setBotId('');
      setSecret('');
      setOwnerUserId('');
      setValidationError(null);
      toast.success(t('settings.wecomBot.disconnected'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('disconnect failed:', message);
      toast.error(t('settings.wecomBot.disconnectFailed', { message }));
    } finally {
      setIsDisconnecting(false);
    }
  }, [isDisconnecting, t]);

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
    validationError,
    isSaving,
    isDisconnecting,
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
  };
}
