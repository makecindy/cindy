import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { useOwnedCodexLogin, verifyCodexAuthRecovery } from './useCodexAuth';
import type { CodexLoginResult } from './codexAuthLogin';
import { isCodexOAuthReconnectRequired } from './codexAuthRecovery';

export const isCodexSessionExpiredError = isCodexOAuthReconnectRequired;

type CodexCredentialScope = NonNullable<CodexLoginResult['credentialScope']>;

function reconnectCopyForScope(scope: CodexCredentialScope): {
  description: string;
  confirmText: string;
} {
  if (scope === 'system-shared') {
    return {
      description: 'chatgptAuthRecovery.systemSharedInvalidated',
      confirmText: 'chatgptAuthRecovery.relogin',
    };
  }
  return {
    description:
      scope === 'instance-isolated'
        ? 'chatgptAuthRecovery.instanceIsolatedInvalidated'
        : 'chatgptAuthRecovery.unknownInvalidated',
    confirmText: 'chatgptAuthRecovery.relogin',
  };
}

export function useCodexSessionExpiredPrompt(options?: {
  onAuthenticated?: (recoveredError: string) => void;
  onPromptClosed?: () => void;
  /** 已有内联说明和显式按钮时可跳过二次确认，直接进入浏览器连接流程。 */
  confirmBeforeLogin?: boolean;
}): (error: string) => boolean {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const triggerOwnedLogin = useOwnedCodexLogin();
  const promptedForErrorRef = useRef<string | null>(null);
  const promptActiveRef = useRef(false);
  const mountedRef = useRef(true);
  const onAuthenticatedRef = useRef(options?.onAuthenticated);
  const onPromptClosedRef = useRef(options?.onPromptClosed);
  onAuthenticatedRef.current = options?.onAuthenticated;
  onPromptClosedRef.current = options?.onPromptClosed;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      promptedForErrorRef.current = null;
      promptActiveRef.current = false;
    };
  }, []);

  return useCallback(
    (error: string) => {
      if (!isCodexSessionExpiredError(error)) return false;
      if (promptedForErrorRef.current === error) return promptActiveRef.current;
      promptedForErrorRef.current = error;
      promptActiveRef.current = true;

      const closePrompt = () => {
        promptedForErrorRef.current = null;
        promptActiveRef.current = false;
        onPromptClosedRef.current?.();
      };

      void (async () => {
        let credentialScope: CodexCredentialScope = 'unknown';
        try {
          const state = (await window.electronAPI.maker.auth.getState('codex')) as CodexLoginResult;
          if (!mountedRef.current) return;
          if (state.authenticated) {
            const verification = await verifyCodexAuthRecovery(state);
            if (!mountedRef.current) return;
            if (verification.status === 'verified') {
              onAuthenticatedRef.current?.(error);
              toast.success(t('logic.toasts.codexConnected'));
              closePrompt();
              return;
            }
            if (verification.status === 'stale') {
              closePrompt();
              return;
            }
            if (verification.status === 'invalid') {
              credentialScope = verification.state.credentialScope ?? 'unknown';
            }
          }
          if (credentialScope === 'unknown') {
            credentialScope = state.credentialScope ?? 'unknown';
          }
        } catch {
          // 无法读取来源时按 unknown 引导，避免误称沿用了系统登录。
        }
        const copy = reconnectCopyForScope(credentialScope);
        if (options?.confirmBeforeLogin !== false) {
          const shouldReconnect = await confirm({
            title: t('chatgptAuthRecovery.title'),
            description: t(copy.description),
            confirmText: t(copy.confirmText),
            cancelText: t('chatgptAuthRecovery.later'),
            autoFocusConfirm: true,
          });
          if (!mountedRef.current) return;
          if (!shouldReconnect) {
            closePrompt();
            return;
          }
        }

        try {
          const result = await triggerOwnedLogin();
          if (!mountedRef.current) return;
          if (result.authenticated) {
            const verification = await verifyCodexAuthRecovery(result);
            if (!mountedRef.current) return;
            if (verification.status === 'verified') {
              onAuthenticatedRef.current?.(error);
              toast.success(t('logic.toasts.codexConnected'));
            } else if (verification.status === 'failed') {
              toast.error(t('chatgptAuthRecovery.verificationFailed'));
            } else if (verification.status === 'invalid') {
              toast.error(t('settings.connections.codex.toast.loginFailed'));
            }
          } else if (result.errorReason !== 'login_cancelled') {
            toast.error(t('settings.connections.codex.toast.loginFailed'));
          }
        } catch {
          if (mountedRef.current) {
            toast.error(t('settings.connections.codex.toast.loginFailed'));
          }
        } finally {
          if (mountedRef.current) closePrompt();
        }
      })();
      return true;
    },
    [confirm, options?.confirmBeforeLogin, t, triggerOwnedLogin],
  );
}
