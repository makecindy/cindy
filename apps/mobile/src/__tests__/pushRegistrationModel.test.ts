import { describe, expect, it } from 'vitest';
import {
  buildPushTokenRegistrationBody,
  notificationRecoveryRoute,
  notificationConversationIsReading,
  parseNotificationDeepLink,
  parseNotificationResponseDeepLink,
  resolvePushAppVariant,
  resolveNotificationDestination,
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
    ['群聊缺 deviceId', { deepLink: '/companions/groups/g-1' }],
    ['群聊 deviceId 为空', { deepLink: '/companions/groups/g-1?deviceId=' }],
    ['群聊多余参数', { deepLink: '/companions/groups/g-1?deviceId=d-1&next=/settings' }],
    ['群聊重复 deviceId', { deepLink: '/companions/groups/g-1?deviceId=d-1&deviceId=d-2' }],
    ['群聊多段路径', { deepLink: '/companions/groups/g-1/x?deviceId=d-1' }],
    ['群聊片段', { deepLink: '/companions/groups/g-1?deviceId=d-1#x' }],
    ['群聊未编码 id', { deepLink: '/companions/groups/g 1?deviceId=d-1' }],
    ['群聊坏编码', { deepLink: '/companions/groups/%E0%A4%A?deviceId=d-1' }],
    ['群聊控制字符', { deepLink: '/companions/groups/g%0A1?deviceId=d-1' }],
    ['群聊嵌入 scheme', { deepLink: '/companions/groups/g-1?deviceId=https://evil' }],
    ['群聊空 id', { deepLink: '/companions/groups/?deviceId=d-1' }],
    ['其它伙伴路径', { deepLink: '/companions/direct/t-1?deviceId=d-1' }],
  ])('拒绝:%s', (_label, input) => {
    expect(parseNotificationDeepLink(input)).toBeNull();
  });

  it('接受分工提醒的群聊深链,并按规范编码重建', () => {
    expect(parseNotificationDeepLink({ deepLink: '/companions/groups/g-1?deviceId=d-1' }))
      .toBe('/companions/groups/g-1?deviceId=d-1');
    expect(parseNotificationDeepLink({ deepLink: `/companions/groups/${encodeURIComponent('群 1')}?deviceId=${encodeURIComponent('mac:1')}` }))
      .toBe(`/companions/groups/${encodeURIComponent('群 1')}?deviceId=${encodeURIComponent('mac:1')}`);
  });

  it('群聊深链经通知点击恢复路由后仍带着 deviceId', () => {
    const link = parseNotificationDeepLink({ deepLink: '/companions/groups/g-1?deviceId=d-1' })!;
    expect(notificationRecoveryRoute(link, 'id:n-1')).toBe('/companions/groups/g-1?deviceId=d-1&notificationResponse=id%3An-1');
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

// Unit: the real bridge uses this predicate at delivery time, not when it mounts.
// bot-group-chat.md §10 suppresses only an actively read conversation. Existing
// deep-link tests never covered a retained route after AppState becomes background.
// Minimal failure: matching group/thread + background, while native dispatch still uses foreground.
describe('notificationConversationIsReading', () => {
  it('matches the canonical task device as well as its session, and never suppresses background delivery', () => {
    const route = '/sessions/same-session?deviceId=desktop-1';
    const visible = { pathname: '/sessions/same-session', deviceId: 'desktop-1' };
    expect(notificationConversationIsReading(route, visible, 'active')).toBe(true);
    expect(notificationConversationIsReading(route, { ...visible, deviceId: 'desktop-2' }, 'active')).toBe(false);
    expect(notificationConversationIsReading(route, visible, 'background')).toBe(false);
  });
  const path = '/companions/groups/30000000-0000-4000-8000-000000000003';
  it.each([['active', true], ['background', false], ['inactive', false], [null, false]] as const)(
    'suppresses a matching visible route only with active AppState (%s)', (state, expected) => {
      expect(notificationConversationIsReading(path, { pathname: path }, state)).toBe(expected);
    });
  it('keeps another group or another thread eligible while active', () => {
    expect(notificationConversationIsReading(`${path}?threadRootId=50000000-0000-4000-8000-000000000005`, { pathname: path }, 'active')).toBe(false);
    expect(notificationConversationIsReading(path, { pathname: '/companions' }, 'active')).toBe(false);
  });
});

// Unit: the notification click resolver preserves canonical source identity and only
// uses the existing read-only cloud route when current roster/home evidence agrees.
it('opens an offline companion cloud conversation without redirecting ordinary tasks or changed homes', async () => {
  const route = '/sessions/main?deviceId=desktop&resourceCollectionId=teammates&resourceId=bot&resourceKind=bot';
  const deps = { computer: async () => ({ online: false, name: 'Home computer' }),
    companion: async () => ({ id: 'cloud-actor', homeDeviceId: 'desktop', name: 'Ztw' }) };
  const resolved = await resolveNotificationDestination(route, deps);
  expect(resolved).toBe('/companions/cloud/cloud-actor?botId=bot&deviceId=desktop&deviceName=Home+computer&title=Ztw');
  expect(await resolveNotificationDestination('/sessions/task?deviceId=desktop', deps)).toBe('/sessions/task?deviceId=desktop');
  expect(await resolveNotificationDestination(route, { ...deps, computer: async () => ({ online: true, name: 'Home' }) })).toBe(route);
  expect(await resolveNotificationDestination(route, { ...deps, computer: async () => ({ online: undefined as unknown as boolean, name: 'Old host' }) })).toBe(route);
  expect(await resolveNotificationDestination(route, { ...deps, companion: async () => ({ id: 'other', homeDeviceId: 'new-home', name: 'Ztw' }) })).toBe(route);
  expect(await resolveNotificationDestination(route, { ...deps, computer: async () => { throw new Error('offline'); } })).toBe(route);
});
