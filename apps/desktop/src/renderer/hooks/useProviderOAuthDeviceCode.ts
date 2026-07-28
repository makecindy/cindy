import { useCallback, useEffect, useRef, useState } from 'react';

export interface ProviderOAuthDeviceCode {
  verificationUrl: string;
  userCode: string;
  expiresAt?: number;
}

type OwnedProviderOAuthLogin = {
  providerId: string;
  ownerId: string;
};

let providerOAuthOwnerSequence = 0;
const providerOAuthOwnerPrefix = (() => {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    const entropy = new Uint32Array(4);
    globalThis.crypto?.getRandomValues?.(entropy);
    if (entropy.some((value) => value !== 0)) {
      return `provider-oauth-${[...entropy].map((value) => value.toString(16)).join('-')}`;
    }
  } catch {
    // Older Electron/jsdom may not expose the Web Crypto methods.
  }
  // Main also binds this token to event.sender; fallback uniqueness is not an auth boundary.
  return `provider-oauth-${Date.now().toString(36)}`;
})();

function nextProviderOAuthOwnerId(): string {
  providerOAuthOwnerSequence += 1;
  return `${providerOAuthOwnerPrefix}:${providerOAuthOwnerSequence}`;
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
  const ownedLoginRef = useRef<OwnedProviderOAuthLogin | null>(null);

  const releaseOwnedLogin = useCallback((owned: OwnedProviderOAuthLogin) => {
    if (ownedLoginRef.current !== owned) return;
    ownedLoginRef.current = null;
    try {
      void Promise.resolve(
        window.electronAPI.maker.providerOAuthCancel(owned.providerId, {
          releaseOwner: true,
          ownerId: owned.ownerId,
        }),
      ).catch(() => undefined);
    } catch {
      // Cleanup is best-effort; synchronous bridge failures must not escape effect teardown.
    }
  }, []);

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
      const owned = ownedLoginRef.current;
      if (owned?.providerId === providerId) releaseOwnedLogin(owned);
    };
  }, [observeProgress, providerId, releaseOwnedLogin]);

  const beginOwnedLogin = useCallback(() => {
    if (!providerId) return { ownerId: undefined, finish: () => undefined };
    const previous = ownedLoginRef.current;
    if (previous) releaseOwnedLogin(previous);
    const owned = { providerId, ownerId: nextProviderOAuthOwnerId() };
    ownedLoginRef.current = owned;
    return {
      ownerId: owned.ownerId,
      finish: () => {
        if (ownedLoginRef.current === owned) ownedLoginRef.current = null;
      },
    };
  }, [providerId, releaseOwnedLogin]);
  const cancelOwnedLogin = useCallback(() => {
    const owned = ownedLoginRef.current;
    if (owned) releaseOwnedLogin(owned);
  }, [releaseOwnedLogin]);
  const clearDeviceCode = useCallback(() => setDeviceCode(null), []);
  return { deviceCode, clearDeviceCode, beginOwnedLogin, cancelOwnedLogin };
}
