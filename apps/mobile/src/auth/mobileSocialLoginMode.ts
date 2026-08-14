import type { AuthRegion, SocialProvider } from '@cindy/auth-client';

export type MobileSocialLoginMode = 'native' | 'browser';

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
}): MobileSocialLoginMode | null {
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
