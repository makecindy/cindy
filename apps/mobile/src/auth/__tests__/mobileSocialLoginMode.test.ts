import { describe, expect, it } from 'vitest';

import { resolveMobileSocialLoginMode } from '@/auth/mobileSocialLoginMode';

describe('resolveMobileSocialLoginMode', () => {
  it.each(['ios', 'android'])(
    'temporarily hides WeChat on %s even when configured',
    (platform) => {
      for (const region of ['cn', 'global'] as const) {
        for (const nativeSupported of [true, false]) {
          expect(
            resolveMobileSocialLoginMode({
              provider: 'wechat',
              region,
              platform,
              nativeSupported,
            }),
          ).toBeNull();
        }
      }
    },
  );

  it.each(['ios', 'android'])(
    'restores the configured CN WeChat path on %s when re-enabled',
    (platform) => {
      expect(
        resolveMobileSocialLoginMode({
          provider: 'wechat',
          region: 'cn',
          platform,
          nativeSupported: true,
          wechatLoginEnabled: true,
        }),
      ).toBe('native');
      expect(
        resolveMobileSocialLoginMode({
          provider: 'wechat',
          region: 'cn',
          platform,
          nativeSupported: false,
          wechatLoginEnabled: true,
        }),
      ).toBeNull();
      expect(
        resolveMobileSocialLoginMode({
          provider: 'wechat',
          region: 'global',
          platform,
          nativeSupported: true,
          wechatLoginEnabled: true,
        }),
      ).toBeNull();
    },
  );

  it('uses browser PKCE for Apple on Global Android', () => {
    expect(
      resolveMobileSocialLoginMode({
        provider: 'apple',
        region: 'global',
        platform: 'android',
        nativeSupported: false,
      }),
    ).toBe('browser');
  });

  it('keeps Apple native on iOS', () => {
    expect(
      resolveMobileSocialLoginMode({
        provider: 'apple',
        region: 'global',
        platform: 'ios',
        nativeSupported: true,
      }),
    ).toBe('native');
  });

  it('does not change Mainland China Android provider behavior', () => {
    expect(
      resolveMobileSocialLoginMode({
        provider: 'apple',
        region: 'cn',
        platform: 'android',
        nativeSupported: false,
      }),
    ).toBeNull();
  });

  it('keeps other configured providers on their native path', () => {
    expect(
      resolveMobileSocialLoginMode({
        provider: 'google',
        region: 'global',
        platform: 'android',
        nativeSupported: true,
      }),
    ).toBe('native');
  });
});
