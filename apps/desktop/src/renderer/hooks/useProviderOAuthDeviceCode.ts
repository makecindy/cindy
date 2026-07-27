import { useCallback, useEffect, useRef, useState } from 'react';

export interface ProviderOAuthDeviceCode {
  verificationUrl: string;
  userCode: string;
  expiresAt?: number;
}

/**
 * 管理某个通用 OAuth 登录的组件 ownership；Device Grant 流可同时订阅短期代码。
 * 代码只在组件内存中保留；切换供应商、取消或卸载都会清空。
 */
export function useProviderOAuthDeviceCode(
  providerId: string | null,
  options?: { observeProgress?: boolean },
) {
  const observeProgress = options?.observeProgress ?? true;
  const [deviceCode, setDeviceCode] = useState<ProviderOAuthDeviceCode | null>(null);
  const ownedLoginRef = useRef<{ providerId: string; token: symbol } | null>(null);

  useEffect(() => {
    setDeviceCode(null);
    if (!providerId) return undefined;
    const unsubscribe = observeProgress
      ? window.electronAPI.maker.onProviderOAuthProgress((progress) => {
          if (progress.providerId !== providerId || progress.phase !== 'device-code') return;
          setDeviceCode({
            verificationUrl: progress.verificationUrl,
            userCode: progress.userCode,
            expiresAt: progress.expiresAt,
          });
        })
      : undefined;
    return () => {
      unsubscribe?.();
      if (ownedLoginRef.current?.providerId === providerId) {
        ownedLoginRef.current = null;
        try {
          void Promise.resolve(window.electronAPI.maker.providerOAuthCancel(providerId)).catch(
            () => undefined,
          );
        } catch {
          // Cleanup is best-effort; synchronous bridge failures must not escape effect teardown.
        }
      }
    };
  }, [observeProgress, providerId]);

  const beginOwnedLogin = useCallback(() => {
    if (!providerId) return () => undefined;
    const owned = { providerId, token: Symbol(providerId) };
    ownedLoginRef.current = owned;
    return () => {
      if (ownedLoginRef.current === owned) ownedLoginRef.current = null;
    };
  }, [providerId]);
  const clearDeviceCode = useCallback(() => setDeviceCode(null), []);
  return { deviceCode, clearDeviceCode, beginOwnedLogin };
}
