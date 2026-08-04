import { describe, expect, it } from 'vitest';
import {
  buildPushTokenRegistrationBody,
  parseNotificationDeepLink,
  parseNotificationResponseDeepLink,
  resolvePushAppVariant,
} from '@/notifications/pushRegistrationModel';

describe('resolvePushAppVariant', () => {
  it('cn / global 直通,dev 身份归 cn 推送构建线', () => {
    expect(resolvePushAppVariant('cn')).toBe('cn');
    expect(resolvePushAppVariant('global')).toBe('global');
    expect(resolvePushAppVariant('dev')).toBe('cn');
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
    expect(
      buildPushTokenRegistrationBody({ token: 'dev-token', region: 'dev', isDevBuild: true }),
    ).toMatchObject({ appVariant: 'cn', apnsEnv: 'sandbox' });
  });

  it('空 token 返回 null', () => {
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

describe('parseNotificationResponseDeepLink', () => {
  it('读取 Expo content.data 中的深链', () => {
    expect(
      parseNotificationResponseDeepLink({
        notification: {
          request: {
            content: { data: { deepLink: '/sessions/s-1?deviceId=d-1' } },
            trigger: { type: 'push', payload: {} },
          },
        },
      }),
    ).toBe('/sessions/s-1?deviceId=d-1');
  });

  it('兼容 iOS APNs trigger.payload 顶层深链', () => {
    expect(
      parseNotificationResponseDeepLink({
        notification: {
          request: {
            content: { data: {} },
            trigger: {
              type: 'push',
              payload: { deepLink: '/sessions/s-2?deviceId=d-2' },
            },
          },
        },
      }),
    ).toBe('/sessions/s-2?deviceId=d-2');
  });

  it('兼容 relay 将自定义字段包在 payload.body / payload.data 中', () => {
    expect(
      parseNotificationResponseDeepLink({
        notification: {
          request: {
            content: { data: {} },
            trigger: {
              type: 'push',
              payload: { body: { deepLink: '/sessions/s-3?deviceId=d-3' } },
            },
          },
        },
      }),
    ).toBe('/sessions/s-3?deviceId=d-3');
    expect(
      parseNotificationResponseDeepLink({
        notification: {
          request: {
            content: { data: {} },
            trigger: {
              type: 'push',
              payload: { data: { deepLink: '/sessions/s-4?deviceId=d-4' } },
            },
          },
        },
      }),
    ).toBe('/sessions/s-4?deviceId=d-4');
  });

  it('非对象响应返回 null', () => {
    expect(parseNotificationResponseDeepLink(null)).toBeNull();
  });
});
