import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import type { DesktopLoginAction } from '@/lib/authService';

interface UseLoginReturn {
  isLoading: boolean;
  errorCode: string | null;
  retryAt: number | undefined;
  loginState: ReturnType<typeof useAuth>['loginState'];
  credentialStoreUnavailable: ReturnType<typeof useAuth>['credentialStoreUnavailable'];
  hasAccountDeletionReceipt: boolean;
  getAccountDeletionStatus: ReturnType<typeof useAuth>['getAccountDeletionStatus'];
  clearAccountDeletionReceipt: ReturnType<typeof useAuth>['clearAccountDeletionReceipt'];
  listAccounts: ReturnType<typeof useAuth>['listAccounts'];
  dispatch: (action: DesktopLoginAction) => Promise<boolean>;
  /**
   * 与 dispatch 同一条链路,但把失败码返回给调用方——captcha 兜底重试需要在
   * 调用点区分 CAPTCHA_REQUIRED/CAPTCHA_INVALID 与其他失败(errorCode state
   * 在同一 tick 内读不到新值)。busy 短路时 code 为 null(与 dispatch 静默
   * 返回 false 同口径,不产生可展示错误)。
   */
  dispatchWithResult: (
    action: DesktopLoginAction,
  ) => Promise<{ success: boolean; code: string | null }>;
  clearError: () => void;
  /**
   * 「跳过登录」必须走这里,不能直接调 `authEnterLocal` IPC。
   * AuthContext 会用返回值立刻改 `mode` / `canEnterApp`;绕过它只改主进程会话,
   * 界面仍停在登录页,再点一次也不会重播状态。
   */
  enterLocalMode: ReturnType<typeof useAuth>['enterLocalMode'];
}

/** Coordinates presentation state while all credentials and tickets stay in main. */
export function useLogin({ autoLoad = true }: { autoLoad?: boolean } = {}): UseLoginReturn {
  const {
    loginState,
    credentialStoreUnavailable,
    loadLoginState,
    dispatchLoginAction,
    hasAccountDeletionReceipt,
    getAccountDeletionStatus,
    clearAccountDeletionReceipt,
    listAccounts,
    enterLocalMode: enterLocalModeFromAuth,
  } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const operationRef = useRef(0);

  useEffect(() => {
    if (!autoLoad || loginState || loadingRef.current) return;
    const operation = ++operationRef.current;
    loadingRef.current = true;
    setIsLoading(true);
    void loadLoginState()
      .then((result) => {
        if (operation !== operationRef.current) return;
        if (!result.success) {
          setErrorCode(result.code);
        }
      })
      .catch(() => {
        if (operation === operationRef.current) setErrorCode('AUTH_SERVICE_UNAVAILABLE');
      })
      .finally(() => {
        if (operation !== operationRef.current) return;
        loadingRef.current = false;
        setIsLoading(false);
      });
  }, [autoLoad, loadLoginState, loginState]);

  const dispatchWithResult = useCallback(
    async (action: DesktopLoginAction): Promise<{ success: boolean; code: string | null }> => {
      if (loadingRef.current && action.type !== 'cancel-browser' && action.type !== 'back') {
        return { success: false, code: null };
      }
      const operation = ++operationRef.current;
      loadingRef.current = true;
      setIsLoading(true);
      setErrorCode(null);
      try {
        const result = await dispatchLoginAction(action);
        if (operation !== operationRef.current) return { success: false, code: null };
        if (!result.success) {
          setErrorCode(result.code === 'USER_CANCELLED' ? null : result.code);
          return { success: false, code: result.code };
        }
        return { success: true, code: null };
      } catch {
        if (operation !== operationRef.current) return { success: false, code: null };
        setErrorCode('AUTH_REQUEST_FAILED');
        return { success: false, code: 'AUTH_REQUEST_FAILED' };
      } finally {
        if (operation === operationRef.current) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [dispatchLoginAction],
  );

  const dispatch = useCallback(
    async (action: DesktopLoginAction): Promise<boolean> =>
      (await dispatchWithResult(action)).success,
    [dispatchWithResult],
  );

  const enterLocalMode = useCallback(async () => {
    const operation = ++operationRef.current;
    loadingRef.current = true;
    setIsLoading(true);
    setErrorCode(null);
    try {
      await enterLocalModeFromAuth();
    } finally {
      if (operation === operationRef.current) {
        loadingRef.current = false;
        setIsLoading(false);
      }
    }
  }, [enterLocalModeFromAuth]);

  return {
    isLoading,
    errorCode,
    retryAt:
      (errorCode ?? (loginState?.step === 'error' ? loginState.code : null)) === 'RATE_LIMITED'
        ? loginState?.retryAt
        : undefined,
    loginState,
    credentialStoreUnavailable,
    hasAccountDeletionReceipt,
    getAccountDeletionStatus,
    clearAccountDeletionReceipt,
    listAccounts,
    dispatch,
    dispatchWithResult,
    clearError: () => {
      setErrorCode(null);
    },
    enterLocalMode,
  };
}
