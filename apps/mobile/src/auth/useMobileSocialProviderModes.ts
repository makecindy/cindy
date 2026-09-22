import { useEffect, useMemo, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { AuthRegion, SocialProvider } from '@cindy/auth-client';

import {
  isNativeSocialProviderAvailable,
  isNativeSocialProviderSupported,
} from '@/auth/nativeSocial';
import {
  resolveMobileSocialLoginMode,
  type MobileSocialLoginMode,
} from '@/auth/mobileSocialLoginMode';

/** Keeps the rendered social-login set aligned with native device availability. */
export function useMobileSocialProviderModes({
  providers,
  region,
}: {
  providers: readonly SocialProvider[];
  region: AuthRegion;
}): ReadonlyMap<SocialProvider, MobileSocialLoginMode> {
  const [iosWechatAvailable, setIosWechatAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let cancelled = false;
    const refresh = async () => {
      const available = await isNativeSocialProviderAvailable('wechat');
      if (!cancelled) setIosWechatAvailable(available);
    };
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return useMemo(() => {
    const modes = new Map<SocialProvider, MobileSocialLoginMode>();
    for (const provider of providers) {
      const mode = resolveMobileSocialLoginMode({
        provider,
        region,
        platform: Platform.OS,
        nativeSupported:
          provider === 'wechat' && Platform.OS === 'ios'
            ? iosWechatAvailable
            : isNativeSocialProviderSupported(provider),
      });
      if (mode) modes.set(provider, mode);
    }
    return modes;
  }, [iosWechatAvailable, providers, region]);
}
