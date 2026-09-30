import type { AuthRegion, SocialProvider } from '@cindy/auth-client';

export type MobileSocialLoginMode = 'native' | 'browser';

export const MOBILE_WECHAT_LOGIN_ENABLED = true;

/**
 * Chooses the credential path for a provider advertised by auth-server.
 * Native support remains the default; Global Android falls back to the
 * existing browser PKCE flow for Apple instead of hiding the provider.
 */
export function resolveMobileSocialLoginMode(input: {
  provider: SocialProvider;
  region: AuthRegion;
  platform: string;
  nativeSupported: boolean;
  wechatLoginEnabled?: boolean;
}): MobileSocialLoginMode | null {
  if (
    input.provider === 'wechat' &&
    (!(input.wechatLoginEnabled ?? MOBILE_WECHAT_LOGIN_ENABLED) ||
      input.region !== 'cn' ||
      input.platform !== 'ios')
  ) {
    return null;
  }
  if (input.nativeSupported) return 'native';
  if (
    input.provider === 'apple' &&
    input.region === 'global' &&
    input.platform === 'android'
  ) {
    return 'browser';
  }
  return null;
}
