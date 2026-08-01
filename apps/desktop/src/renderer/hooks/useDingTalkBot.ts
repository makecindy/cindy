import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

const log = createLogger('useDingTalkBot');

interface CachedState {
  appKey: string;
  hasSecret: boolean;
  ownerUserId: string;
  status: DingTalkBotTransportStatus;
}

let cachedState: CachedState | null = null;

function connectFailureToastKey(error: unknown): string {
  switch (extractIpcError(error)?.code) {
    case 'DINGTALK_AUTH_FAILED':
      return 'logic.toasts.dingtalkBotAuthFailed';
    case 'DINGTALK_NETWORK_FAILED':
      return 'logic.toasts.dingtalkBotNetworkFailed';
    case 'DINGTALK_STREAM_CONNECTION_FAILED':
      return 'logic.toasts.dingtalkBotStreamFailed';
    default:
      return 'logic.toasts.dingtalkBotConnectFailed';
  }
}

export function useDingTalkBot() {
  const { t } = useTranslation();
  const [appKey, setAppKeyState] = useState(() => cachedState?.appKey ?? '');
  const [appSecret, setAppSecretState] = useState('');
  const [hasSecret, setHasSecret] = useState(() => cachedState?.hasSecret ?? false);
  const [ownerUserId, setOwnerUserId] = useState(() => cachedState?.ownerUserId ?? '');
  const [status, setStatus] = useState<DingTalkBotTransportStatus>(
    () => cachedState?.status ?? { kind: 'idle' },
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const updateState = useCallback(
    (state: {
      appKey: string | null;
      hasSecret: boolean;
      ownerUserId: string | null;
      status: DingTalkBotTransportStatus;
    }) => {
      const next = {
        appKey: state.appKey ?? '',
        hasSecret: state.hasSecret,
        ownerUserId: state.ownerUserId ?? '',
        status: state.status,
      };
      setAppKeyState(next.appKey);
      setHasSecret(next.hasSecret);
      setOwnerUserId(next.ownerUserId);
      setStatus(next.status);
      cachedState = next;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dingtalkBot
      .getState()
      .then((state) => {
        if (!cancelled) updateState(state);
      })
      .catch((error) => {
        log.error('getState failed:', error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [updateState]);

  useEffect(() => {
    const unsubStatus = window.electronAPI.dingtalkBot.onStatusChange(({ status: next }) => {
      setStatus(next);
      if (cachedState) cachedState = { ...cachedState, status: next };
    });
    const unsubOwner = window.electronAPI.dingtalkBot.onOwnerChange(({ ownerUserId: next }) => {
      setOwnerUserId(next);
      if (cachedState) cachedState = { ...cachedState, ownerUserId: next };
    });
    return () => {
      unsubStatus();
      unsubOwner();
    };
  }, []);

  const setAppKey = useCallback((value: string) => {
    setAppKeyState(value);
    setValidationError(null);
  }, []);

  const setAppSecret = useCallback((value: string) => {
    setAppSecretState(value);
    setValidationError(null);
  }, []);

  const connect = useCallback(async () => {
    if (isSaving) return false;
    const key = appKey.trim();
    const secret = appSecret.trim();
    if (!key || !secret) {
      setValidationError(t('logic.validation.dingtalkFieldsRequired'));
      return false;
    }
    setIsSaving(true);
    setValidationError(null);
    try {
      const state = await window.electronAPI.dingtalkBot.save({
        appKey: key,
        appSecret: secret,
      });
      updateState(state);
      setAppSecretState('');
      toast.success(t('logic.toasts.dingtalkBotConnected'));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('save failed:', message);
      // saveAndConnect restores the last persisted connection on failure. Keep
      // the user's current credential draft so they can correct and retry it.
      toast.error(t(connectFailureToastKey(error)));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [appKey, appSecret, isSaving, t, updateState]);

  const reconnect = useCallback(async () => {
    if (isSaving) return false;
    setIsSaving(true);
    try {
      const state = await window.electronAPI.dingtalkBot.reconnect();
      updateState(state);
      toast.success(t('logic.toasts.dingtalkBotConnected'));
      return true;
    } catch (error) {
      log.error('reconnect failed:', error instanceof Error ? error.message : String(error));
      try {
        updateState(await window.electronAPI.dingtalkBot.getState());
      } catch {
        // The toast below remains the user-facing fallback.
      }
      toast.error(t(connectFailureToastKey(error)));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, t, updateState]);

  const clear = useCallback(async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      await window.electronAPI.dingtalkBot.clear();
      updateState({
        appKey: null,
        hasSecret: false,
        ownerUserId: null,
        status: { kind: 'idle' },
      });
      setAppSecretState('');
      toast.success(t('logic.toasts.dingtalkBotDisconnected'));
    } catch (error) {
      log.error('clear failed:', error instanceof Error ? error.message : String(error));
      toast.error(t('logic.toasts.dingtalkBotDisconnectFailed'));
    } finally {
      setIsClearing(false);
    }
  }, [isClearing, t, updateState]);

  return {
    appKey,
    appSecret,
    hasSecret,
    ownerUserId,
    status,
    validationError,
    isSaving,
    isClearing,
    canConnect: Boolean(appKey.trim() && appSecret.trim() && !isSaving && !isClearing),
    setAppKey,
    setAppSecret,
    connect,
    reconnect,
    clear,
  };
}
