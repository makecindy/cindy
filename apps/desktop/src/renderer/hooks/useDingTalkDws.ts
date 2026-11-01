import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

const log = createLogger('useDingTalkDws');

export type DingTalkTransportMode = 'robot' | 'dws';

const EMPTY_STATE: DingTalkDwsStateSnapshot = {
  status: { kind: 'idle' },
  enabled: false,
  installed: false,
  identity: null,
  ownerName: null,
  pairingCode: null,
};

/** 设置页切走再回来时先显示上次的快照，再异步刷新。 */
let cachedMode: DingTalkTransportMode | null = null;
let cachedState: DingTalkDwsStateSnapshot | null = null;

function connectFailureToastKey(error: unknown): string {
  switch (extractIpcError(error)?.code) {
    case 'DINGTALK_DWS_NOT_INSTALLED':
      return 'logic.toasts.dingtalkDwsNotInstalled';
    case 'DINGTALK_DWS_NOT_LOGGED_IN':
      return 'logic.toasts.dingtalkDwsNotLoggedIn';
    default:
      return 'logic.toasts.dingtalkDwsConnectFailed';
  }
}

/**
 * 钉钉连接方式（机器人应用 / 钉钉账号）与「钉钉账号（dws CLI）」方式的状态。
 * 进程、凭证都在 main；这里只读快照、发起连接 / 断开 / 重新检测。
 */
export function useDingTalkDws() {
  const { t } = useTranslation();
  const [mode, setModeState] = useState<DingTalkTransportMode | null>(() => cachedMode);
  const [state, setState] = useState<DingTalkDwsStateSnapshot>(() => cachedState ?? EMPTY_STATE);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isProbing, setIsProbing] = useState(false);

  const applyState = useCallback((next: DingTalkDwsStateSnapshot) => {
    cachedState = next;
    setState(next);
  }, []);

  const probe = useCallback(async () => {
    setIsProbing(true);
    try {
      applyState(await window.electronAPI.dingtalkBot.getDwsState());
    } catch (error) {
      log.error('getDwsState failed:', error instanceof Error ? error.message : String(error));
    } finally {
      setIsProbing(false);
    }
  }, [applyState]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dingtalkBot
      .getMode()
      .then(({ mode: next }) => {
        if (cancelled) return;
        cachedMode = next;
        setModeState(next);
      })
      .catch((error) => {
        log.error('getMode failed:', error instanceof Error ? error.message : String(error));
      });
    void probe();
    const unsubscribe = window.electronAPI.dingtalkBot.onDwsStateChange(({ state: next }) => {
      if (!cancelled) applyState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyState, probe]);

  const setMode = useCallback(
    async (next: DingTalkTransportMode) => {
      if (isSwitching || next === mode) return;
      setIsSwitching(true);
      try {
        const result = await window.electronAPI.dingtalkBot.setMode(next);
        cachedMode = result.mode;
        setModeState(result.mode);
        if (result.mode === 'dws') void probe();
      } catch (error) {
        log.error('setMode failed:', error instanceof Error ? error.message : String(error));
        toast.error(t('logic.toasts.dingtalkModeSwitchFailed'));
      } finally {
        setIsSwitching(false);
      }
    },
    [isSwitching, mode, probe, t],
  );

  const connect = useCallback(async () => {
    if (isConnecting) return false;
    setIsConnecting(true);
    try {
      applyState(await window.electronAPI.dingtalkBot.connectDws());
      cachedMode = 'dws';
      setModeState('dws');
      toast.success(t('logic.toasts.dingtalkDwsConnected'));
      return true;
    } catch (error) {
      log.error('connectDws failed:', error instanceof Error ? error.message : String(error));
      toast.error(t(connectFailureToastKey(error)));
      void probe();
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, [applyState, isConnecting, probe, t]);

  const disconnect = useCallback(async () => {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      applyState(await window.electronAPI.dingtalkBot.disconnectDws());
      toast.success(t('logic.toasts.dingtalkDwsDisconnected'));
    } catch (error) {
      log.error('disconnectDws failed:', error instanceof Error ? error.message : String(error));
      toast.error(t('logic.toasts.dingtalkBotDisconnectFailed'));
    } finally {
      setIsDisconnecting(false);
    }
  }, [applyState, isDisconnecting, t]);

  const clearOwner = useCallback(async () => {
    try {
      applyState(await window.electronAPI.dingtalkBot.clearDwsOwner());
    } catch (error) {
      log.error('clearDwsOwner failed:', error instanceof Error ? error.message : String(error));
    }
  }, [applyState]);

  return {
    mode,
    state,
    isSwitching,
    isConnecting,
    isDisconnecting,
    isProbing,
    setMode,
    probe,
    connect,
    disconnect,
    clearOwner,
  };
}
