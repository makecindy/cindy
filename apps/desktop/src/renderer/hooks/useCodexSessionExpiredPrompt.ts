import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { useOwnedCodexLogin, verifyCodexAuthRecovery } from './useCodexAuth';
import type { CodexLoginResult } from './codexAuthLogin';
import { isCodexOAuthReconnectRequired, type CodexCredentialScope } from './codexAuthRecovery';

export const isCodexSessionExpiredError = isCodexOAuthReconnectRequired;

function reconnectCopyForScope(scope: CodexCredentialScope): {
  description: string;
  confirmText: string;
} {
  if (scope === 'system-shared') {
    return {
      description: 'chatgptAuthRecovery.systemSharedInvalidated',
      confirmText: 'chatgptAuthRecovery.openApp',
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
  onPromptStarted?: (error: string) => void;
  onPromptClosed?: () => void;
  /** 交给独立入口内联呈现恢复动作，避免在辅助窗口里丢失恢复状态。 */
  onInlineRecoveryRequired?: (error: string, scope: CodexCredentialScope) => void;
  /** 已有内联说明和显式按钮时可跳过二次确认，直接进入浏览器连接流程。 */
  confirmBeforeLogin?: boolean;
}): (error: string) => boolean {
  const { t } = useTranslation();
  const { confirm, confirmThree } = useConfirmDialog();
  const triggerOwnedLogin = useOwnedCodexLogin();
  const promptedForErrorRef = useRef<string | null>(null);
  const promptActiveRef = useRef(false);
  const mountedRef = useRef(true);
  const onAuthenticatedRef = useRef(options?.onAuthenticated);
  const onPromptStartedRef = useRef(options?.onPromptStarted);
  const onPromptClosedRef = useRef(options?.onPromptClosed);
  const onInlineRecoveryRequiredRef = useRef(options?.onInlineRecoveryRequired);
  onAuthenticatedRef.current = options?.onAuthenticated;
  onPromptStartedRef.current = options?.onPromptStarted;
  onPromptClosedRef.current = options?.onPromptClosed;
  onInlineRecoveryRequiredRef.current = options?.onInlineRecoveryRequired;

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
      onPromptStartedRef.current?.(error);

      const closePrompt = () => {
        promptedForErrorRef.current = null;
        promptActiveRef.current = false;
        onPromptClosedRef.current?.();
      };

      void (async () => {
        let credentialScope: CodexCredentialScope = 'unknown';
        let oauthWritesBlocked = false;
        try {
          const state = (await window.electronAPI.maker.auth.getState('codex')) as CodexLoginResult;
          oauthWritesBlocked = state.oauthWritesBlocked === true;
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
        if (credentialScope === 'system-shared' && onInlineRecoveryRequiredRef.current) {
          closePrompt();
          onInlineRecoveryRequiredRef.current(error, credentialScope);
          return;
        }
        const openChatGptAppAndClose = async () => {
          try {
            const opened = await window.electronAPI.openChatGPTApp();
            if (!opened.success) toast.error(t('chatgptAuthRecovery.openAppFailed'));
          } catch {
            toast.error(t('chatgptAuthRecovery.openAppFailed'));
          }
          if (mountedRef.current) closePrompt();
        };
        if (credentialScope === 'system-shared') {
          if (oauthWritesBlocked) {
            const shouldOpenApp = await confirm({
              title: t('chatgptAuthRecovery.title'),
              description: t(copy.description),
              confirmText: t('chatgptAuthRecovery.openApp'),
              cancelText: t('chatgptAuthRecovery.later'),
              autoFocusConfirm: true,
            });
            if (!mountedRef.current) return;
            if (!shouldOpenApp) {
              closePrompt();
              return;
            }
            await openChatGptAppAndClose();
            return;
          }
          const recoveryAction = await confirmThree({
            title: t('chatgptAuthRecovery.title'),
            description: t(copy.description),
            confirmText: t(copy.confirmText),
            tertiaryText: t('chatgptAuthRecovery.relogin'),
            cancelText: t('chatgptAuthRecovery.later'),
            // 三选一恢复操作的中文文案较长;保留默认确认框宽度会把按钮文字逐字折行。
            maxWidth: 520,
            autoFocusConfirm: true,
          });
          if (!mountedRef.current) return;
          if (recoveryAction === 'cancel') {
            closePrompt();
            return;
          }
          if (recoveryAction === 'confirm') {
            await openChatGptAppAndClose();
            return;
          }

          const acceptsSignOutRisk = await confirm({
            title: t('chatgptAuthRecovery.reloginRiskTitle'),
            description: t('chatgptAuthRecovery.reloginRiskDescription'),
            confirmText: t('chatgptAuthRecovery.reloginRiskConfirm'),
            cancelText: t('chatgptAuthRecovery.later'),
            confirmVariant: 'destructive',
          });
          if (!mountedRef.current) return;
          if (!acceptsSignOutRisk) {
            closePrompt();
            return;
          }
        } else if (oauthWritesBlocked) {
          toast.error(t('chatgptAuthRecovery.devWriteBlocked'));
          closePrompt();
          return;
        } else if (onInlineRecoveryRequiredRef.current) {
          closePrompt();
          onInlineRecoveryRequiredRef.current(error, credentialScope);
          return;
        } else if (options?.confirmBeforeLogin !== false) {
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
            toast.error(
              t(
                result.errorReason === 'dev_oauth_write_blocked'
                  ? 'chatgptAuthRecovery.devWriteBlocked'
                  : 'settings.connections.codex.toast.loginFailed',
              ),
            );
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
    [confirm, confirmThree, options?.confirmBeforeLogin, t, triggerOwnedLogin],
  );
}
