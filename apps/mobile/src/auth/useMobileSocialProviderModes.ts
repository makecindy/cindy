import { useEffect, useMemo, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { AuthRegion, SocialProvider } from '@cindy/auth-client';

import {
  isNativeSocialProviderAvailable,
  isNativeSocialProviderSupported,
} from '@/auth/nativeSocial';
import {
  MOBILE_WECHAT_LOGIN_ENABLED,
  resolveMobileSocialLoginMode,
  type MobileSocialLoginMode,
} from '@/auth/mobileSocialLoginMode';

/** Keeps the rendered social-login set aligned with native device availability. */
export function useMobileSocialProviderModes({
  providers,
  region,
  wechatLoginEnabled = MOBILE_WECHAT_LOGIN_ENABLED,
}: {
  providers: readonly SocialProvider[];
  region: AuthRegion;
  wechatLoginEnabled?: boolean;
}): ReadonlyMap<SocialProvider, MobileSocialLoginMode> {
  const [iosWechatAvailable, setIosWechatAvailable] = useState(false);
  const hasWechatProvider = providers.includes('wechat');

  useEffect(() => {
    if (
      !wechatLoginEnabled ||
      region !== 'cn' ||
      !hasWechatProvider ||
      Platform.OS !== 'ios'
    ) {
      setIosWechatAvailable(false);
      return;
    }
    let cancelled = false;
    let latestRequest = 0;
    const refresh = async () => {
      const request = ++latestRequest;
      setIosWechatAvailable(false);
      const available = await isNativeSocialProviderAvailable('wechat');
      if (!cancelled && request === latestRequest)
        setIosWechatAvailable(available);
    };
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [wechatLoginEnabled, region, hasWechatProvider]);

  return useMemo(() => {
    const modes = new Map<SocialProvider, MobileSocialLoginMode>();
    for (const provider of providers) {
      const mode = resolveMobileSocialLoginMode({
        provider,
        region,
        platform: Platform.OS,
        wechatLoginEnabled,
        nativeSupported:
          provider === 'wechat' && Platform.OS === 'ios'
            ? iosWechatAvailable
            : isNativeSocialProviderSupported(provider),
      });
      if (mode) modes.set(provider, mode);
    }
    return modes;
  }, [iosWechatAvailable, providers, region, wechatLoginEnabled]);
}
