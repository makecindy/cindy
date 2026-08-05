import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('useDiscordBot');
const OWNER_USER_ID_PATTERN = /^\d{17,20}$/;

interface DiscordBotCache {
  ownerUserId: string;
  status: DiscordBotTransportStatus;
  lifecycleAnnouncement: boolean;
}

let cachedState: DiscordBotCache | null = null;

export interface UseDiscordBotReturn {
  token: string;
  setToken: (v: string) => void;
  ownerUserId: string;
  setOwnerUserId: (v: string) => void;
  status: DiscordBotTransportStatus;
  lifecycleAnnouncement: boolean;
  setLifecycleAnnouncement: (enabled: boolean) => void;
  validationError: string | null;
  isSaving: boolean;
  isDisconnecting: boolean;
  canConnect: boolean;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
}

export function useDiscordBot(): UseDiscordBotReturn {
  const { t } = useTranslation();
  const [token, setTokenState] = useState('');
  const [ownerUserId, setOwnerUserIdState] = useState(() => cachedState?.ownerUserId ?? '');
  const [status, setStatus] = useState<DiscordBotTransportStatus>(
    () => cachedState?.status ?? { kind: 'idle' },
  );
  const [lifecycleAnnouncement, setLifecycleAnnouncementState] = useState(
    () => cachedState?.lifecycleAnnouncement ?? true,
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const lifecycleRequestVersionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const lifecycleReadVersion = lifecycleRequestVersionRef.current;
    void (async () => {
      try {
        const state = await window.electronAPI.discordBot.getStatus();
        if (cancelled) return;
        const nextOwnerUserId = state.ownerUserId ?? '';
        const nextLifecycleAnnouncement = state.lifecycleAnnouncement !== false;
        const lifecycleReadIsCurrent = lifecycleReadVersion === lifecycleRequestVersionRef.current;
        setStatus(state.status);
        setOwnerUserIdState(nextOwnerUserId);
        if (lifecycleReadIsCurrent) {
          setLifecycleAnnouncementState(nextLifecycleAnnouncement);
        }
        cachedState = {
          ownerUserId: nextOwnerUserId,
          status: state.status,
          lifecycleAnnouncement: lifecycleReadIsCurrent
            ? nextLifecycleAnnouncement
            : (cachedState?.lifecycleAnnouncement ?? true),
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
    const unsub = window.electronAPI.discordBot.onStatusChange((update) => {
      setStatus(update.status);
      cachedState = {
        ownerUserId: cachedState?.ownerUserId ?? '',
        status: update.status,
        lifecycleAnnouncement: cachedState?.lifecycleAnnouncement ?? true,
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

  const setLifecycleAnnouncement = useCallback((enabled: boolean) => {
    const previous = lifecycleAnnouncement;
    const requestVersion = ++lifecycleRequestVersionRef.current;
    setLifecycleAnnouncementState(enabled);
    cachedState = {
      ownerUserId: cachedState?.ownerUserId ?? '',
      status: cachedState?.status ?? { kind: 'idle' },
      lifecycleAnnouncement: enabled,
    };
    void window.electronAPI.discordBot.setLifecycleAnnouncement(enabled).then((result) => {
      if (requestVersion !== lifecycleRequestVersionRef.current) return;
      if (result.ok && result.lifecycleAnnouncement === enabled) return;
      setLifecycleAnnouncementState(result.lifecycleAnnouncement);
      if (cachedState) {
        cachedState = { ...cachedState, lifecycleAnnouncement: result.lifecycleAnnouncement };
      }
    }).catch((err) => {
      if (requestVersion !== lifecycleRequestVersionRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      log.error('setLifecycleAnnouncement failed:', msg);
      setLifecycleAnnouncementState(previous);
      if (cachedState) cachedState = { ...cachedState, lifecycleAnnouncement: previous };
    });
  }, [lifecycleAnnouncement]);

  const connect = useCallback(async () => {
    if (isSaving) return false;
    const trimmedToken = token.trim();
    const trimmedOwnerUserId = ownerUserId.trim();

    if (!trimmedToken || !trimmedOwnerUserId) {
      setValidationError(t('logic.validation.discordFieldsRequired'));
      return false;
    }
    if (!OWNER_USER_ID_PATTERN.test(trimmedOwnerUserId)) {
      setValidationError(t('logic.validation.discordOwnerUserIdFormat'));
      return false;
    }

    setValidationError(null);
    setIsSaving(true);
    try {
      const result = await window.electronAPI.discordBot.setConfig({
        token: trimmedToken,
        ownerUserId: trimmedOwnerUserId,
      });
      const canonicalOwnerUserId = result.ownerUserId ?? '';
      setStatus(result.status);
      setOwnerUserIdState(canonicalOwnerUserId);
      cachedState = {
        ownerUserId: canonicalOwnerUserId,
        status: result.status,
        lifecycleAnnouncement: cachedState?.lifecycleAnnouncement ?? lifecycleAnnouncement,
      };
      if (result.saveErrorStatus?.kind === 'error' || result.status.kind === 'error') {
        toast.error(t('logic.toasts.discordBotConnectFailed'));
        return false;
      }
      toast.success(t('logic.toasts.discordBotConnected'));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('setConfig failed:', msg);
      toast.error(t('logic.toasts.discordBotSaveFailed', { message: msg }));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, lifecycleAnnouncement, ownerUserId, t, token]);

  const disconnect = useCallback(async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      const result = await window.electronAPI.discordBot.disconnect();
      setStatus(result.status);
      setOwnerUserIdState('');
      setTokenState('');
      setValidationError(null);
      cachedState = {
        ownerUserId: '',
        status: result.status,
        lifecycleAnnouncement: cachedState?.lifecycleAnnouncement ?? lifecycleAnnouncement,
      };
      toast.success(t('logic.toasts.discordBotDisconnected'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('disconnect failed:', msg);
      toast.error(t('logic.toasts.discordBotDisconnectFailed', { message: msg }));
    } finally {
      setIsDisconnecting(false);
    }
  }, [isDisconnecting, lifecycleAnnouncement, t]);

  const canConnect =
    token.trim().length > 0 &&
    OWNER_USER_ID_PATTERN.test(ownerUserId.trim()) &&
    !isSaving &&
    !isDisconnecting;

  return {
    token,
    setToken,
    ownerUserId,
    setOwnerUserId,
    status,
    lifecycleAnnouncement,
    setLifecycleAnnouncement,
    validationError,
    isSaving,
    isDisconnecting,
    canConnect,
    connect,
    disconnect,
  };
}
