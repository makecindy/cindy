import { describe, expect, it } from 'vitest';
import {
  buildPushTokenRegistrationBody,
  parseNotificationDeepLink,
  resolvePushAppVariant,
} from '@/notifications/pushRegistrationModel';

describe('resolvePushAppVariant', () => {
  it('cn / global 直通,dev 身份不注册', () => {
    expect(resolvePushAppVariant('cn')).toBe('cn');
    expect(resolvePushAppVariant('global')).toBe('global');
    expect(resolvePushAppVariant('dev')).toBeNull();
  });
});

describe('buildPushTokenRegistrationBody', () => {
  it('组装 iOS APNs 注册 body;dev build 走 sandbox,release 走 prod', () => {
    expect(
      buildPushTokenRegistrationBody({ token: ' abc123 ', region: 'cn', isDevBuild: true }),
    ).toEqual({
      token: 'abc123',
      platform: 'ios',
      provider: 'apns',
      appVariant: 'cn',
      apnsEnv: 'sandbox',
    });
    expect(
      buildPushTokenRegistrationBody({ token: 'abc123', region: 'global', isDevBuild: false }),
    ).toMatchObject({ appVariant: 'global', apnsEnv: 'prod' });
  });

  it('dev 身份 / 空 token 返回 null', () => {
    expect(buildPushTokenRegistrationBody({ token: 'abc', region: 'dev', isDevBuild: true })).toBeNull();
    expect(buildPushTokenRegistrationBody({ token: '   ', region: 'cn', isDevBuild: true })).toBeNull();
  });
});

describe('parseNotificationDeepLink', () => {
  it('只接受 /sessions/ 前缀的应用内路径', () => {
    expect(
      parseNotificationDeepLink({ deepLink: '/sessions/s-1?deviceId=d-1' }),
    ).toBe('/sessions/s-1?deviceId=d-1');
  });

  it.each([
    ['非对象', 'x'],
    ['缺字段', {}],
    ['非字符串', { deepLink: 42 }],
    ['其它路径', { deepLink: '/settings' }],
    ['绝对 URL', { deepLink: 'https://evil.example/sessions/x' }],
    ['嵌入 scheme', { deepLink: '/sessions/x://evil' }],
    ['协议相对', { deepLink: '//evil.example/sessions/x' }],
  ])('拒绝:%s', (_label, input) => {
    expect(parseNotificationDeepLink(input)).toBeNull();
  });
});
