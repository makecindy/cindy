import { useCallback, useEffect, useRef, useState } from 'react';

export interface ProviderOAuthDeviceCode {
  verificationUrl: string;
  userCode: string;
  expiresAt?: number;
}

/**
 * 订阅某个通用 OAuth 供应商的 Device Grant 短期代码。
 * 代码只在组件内存中保留；切换供应商、取消或卸载都会清空。
 */
export function useProviderOAuthDeviceCode(providerId: string | null) {
  const [deviceCode, setDeviceCode] = useState<ProviderOAuthDeviceCode | null>(null);
  const ownedLoginRef = useRef<{ providerId: string; token: symbol } | null>(null);

  useEffect(() => {
    setDeviceCode(null);
    if (!providerId) return undefined;
    const unsubscribe = window.electronAPI.maker.onProviderOAuthProgress((progress) => {
      if (progress.providerId !== providerId || progress.phase !== 'device-code') return;
      setDeviceCode({
        verificationUrl: progress.verificationUrl,
        userCode: progress.userCode,
        expiresAt: progress.expiresAt,
      });
    });
    return () => {
      unsubscribe();
      if (ownedLoginRef.current?.providerId === providerId) {
        ownedLoginRef.current = null;
        void window.electronAPI.maker.providerOAuthCancel(providerId).catch(() => undefined);
      }
    };
  }, [providerId]);

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
