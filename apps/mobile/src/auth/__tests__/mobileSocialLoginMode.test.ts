import { describe, expect, it } from 'vitest';

import { resolveMobileSocialLoginMode } from '@/auth/mobileSocialLoginMode';

describe('resolveMobileSocialLoginMode', () => {
  it('uses native WeChat only on configured Mainland China iOS builds', () => {
    for (const platform of ['ios', 'android']) {
      for (const region of ['cn', 'global'] as const) {
        for (const nativeSupported of [true, false]) {
          expect(
            resolveMobileSocialLoginMode({
              provider: 'wechat',
              region,
              platform,
              nativeSupported,
            }),
          ).toBe(platform === 'ios' && region === 'cn' && nativeSupported ? 'native' : null);
        }
      }
    }
  });

  it.each(['ios', 'android'])(
    'hides WeChat on %s when explicitly disabled',
    (platform) => {
      expect(
        resolveMobileSocialLoginMode({
          provider: 'wechat',
          region: 'cn',
          platform,
          nativeSupported: true,
          wechatLoginEnabled: false,
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
