import type { AuthRegion, SocialProvider } from '@cindy/auth-client';

export type MobileSocialLoginMode = 'native' | 'browser';

export const MOBILE_WECHAT_LOGIN_ENABLED = true;

/**
 * Chooses the credential path for a provider advertised by auth-server.
 * Native support remains the default. On Global, providers without a usable
 * native path fall back to the existing browser PKCE flow instead of being
 * hidden: Apple on Android, and Google when the build carries no Google
 * client IDs (local and self-built packages).
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
  if (
    input.provider === 'google' &&
    input.region === 'global' &&
    (input.platform === 'android' || input.platform === 'ios')
  ) {
    return 'browser';
  }
  return null;
}
