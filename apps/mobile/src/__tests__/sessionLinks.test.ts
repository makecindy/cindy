import { describe, expect, it } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import {
  buildMobileSessionDeepLink,
  buildMobileSessionMessageDeepLink,
  extractSessionLinkIds,
  parseSessionDeepLinkUrl,
  resolveSessionLinkDeviceId,
  shortSessionId,
} from '@/session/sessionLinks';

describe('session links', () => {
  it('matches the desktop xdt-maker session deep link format', () => {
    expect(buildMobileSessionDeepLink('session/with space')).toBe(
      'cindy://session/session%2Fwith%20space',
    );
  });

  it('parses session deep links with optional message anchor', () => {
    // 双 scheme:cindy 主 + xdt-maker 兼容存量消息,两种都必须解析。
    expect(parseSessionDeepLinkUrl('cindy://session/abc-123')).toEqual({
      sessionId: 'abc-123',
      messageClientId: null,
      deviceId: null,
    });
    expect(parseSessionDeepLinkUrl('xdt-maker://session/abc-123')).toEqual({
      sessionId: 'abc-123',
      messageClientId: null,
      deviceId: null,
    });
    expect(parseSessionDeepLinkUrl(buildMobileSessionMessageDeepLink('abc', 'client/9'))).toEqual({
      sessionId: 'abc',
      messageClientId: 'client/9',
      deviceId: null,
    });
    expect(parseSessionDeepLinkUrl('xdt-maker://session/abc?message=')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
      deviceId: null,
    });
    expect(parseSessionDeepLinkUrl('xdt-maker://session/abc?message=%ZZ')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
      deviceId: null,
    });
    expect(parseSessionDeepLinkUrl('xdt-maker://project/foo')).toBeNull();
    expect(parseSessionDeepLinkUrl('xdt-maker://session/')).toBeNull();
    expect(parseSessionDeepLinkUrl('xdt-maker://session/%ZZ')).toBeNull();
  });

  it('parses the frozen device parameter emitted by desktop deep links', () => {
    // 桌面端远程会话深链把归属设备冻进 `?device=`;手机端解析同口径,
    // 空值 / 编码非法回退 null,不拖累整条链接。
    expect(parseSessionDeepLinkUrl('cindy://session/abc?device=dev-studio')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
      deviceId: 'dev-studio',
    });
    expect(parseSessionDeepLinkUrl('cindy://session/abc?message=m1&device=dev-1')).toEqual({
      sessionId: 'abc',
      messageClientId: 'm1',
      deviceId: 'dev-1',
    });
    expect(parseSessionDeepLinkUrl('cindy://session/abc?device=')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
      deviceId: null,
    });
    expect(parseSessionDeepLinkUrl('cindy://session/abc?device=%ZZ&message=m1')).toEqual({
      sessionId: 'abc',
      messageClientId: 'm1',
      deviceId: null,
    });
  });

  it('extracts unique session ids from message text', () => {
    const a = 'xdt-maker://session/03e0c22d-19db-4ac5-814f-1ea04040b471';
    const b = 'xdt-maker://session/aaaa1111-2222-3333-4444-555566667777?message=m1';
    expect(extractSessionLinkIds(`看 ${a} 和 ${b},还有重复 ${a}。`)).toEqual([
      '03e0c22d-19db-4ac5-814f-1ea04040b471',
      'aaaa1111-2222-3333-4444-555566667777',
    ]);
    expect(extractSessionLinkIds('没有链接')).toEqual([]);
  });

  it('freezes the owner device into generated links in the desktop query order', () => {
    expect(buildMobileSessionDeepLink('abc', { deviceId: 'device/1' })).toBe(
      'cindy://session/abc?device=device%2F1',
    );
    expect(buildMobileSessionMessageDeepLink('abc', 'client/9', { deviceId: 'device/1' })).toBe(
      'cindy://session/abc?message=client%2F9&device=device%2F1',
    );
    expect(parseSessionDeepLinkUrl(buildMobileSessionMessageDeepLink('abc', 'client/9', { deviceId: 'device/1' }))).toEqual({
      sessionId: 'abc',
      messageClientId: 'client/9',
      deviceId: 'device/1',
    });
    // 缺设备时保持旧格式。
    expect(buildMobileSessionMessageDeepLink('abc', 'c1', { deviceId: null })).toBe('cindy://session/abc?message=c1');
  });

  it.each([
    [{ canonicalDeviceId: 'canonical', deviceLinkDeviceId: 'physical' }, 'canonical'],
    [{ deviceLinkDeviceId: 'physical' }, 'physical'],
    [null, 'route'],
    [{ canonicalDeviceId: sharedTaskHostPeer('shared', 'host'), deviceLinkDeviceId: 'old' }, null],
  ] as const)('uses current session ownership before the retained route: %j', (session, expected) => {
    const options = { session, deviceId: 'route' };
    expect(parseSessionDeepLinkUrl(buildMobileSessionDeepLink('abc', options))?.deviceId).toBe(expected);
    expect(parseSessionDeepLinkUrl(buildMobileSessionMessageDeepLink('abc', 'm1', options))?.deviceId).toBe(expected);
  });

  it('keeps shared-task links device-less instead of exporting an unscoped physical route', () => {
    const deviceId = sharedTaskHostPeer('shared-task', 'host-device');
    expect(buildMobileSessionDeepLink('abc', { deviceId })).toBe(
      'cindy://session/abc',
    );
    expect(buildMobileSessionMessageDeepLink('abc', 'm1', { deviceId })).toBe(
      'cindy://session/abc?message=m1',
    );
    const target = parseSessionDeepLinkUrl(buildMobileSessionDeepLink('abc', { deviceId }))!;
    expect(resolveSessionLinkDeviceId({
      listedDeviceId: deviceId,
      linkedDeviceId: target.deviceId,
      currentDeviceId: 'other-device',
    })).toBe(deviceId);
    // 同一共享任务中的旧格式链接可沿用当前已授权句柄,不转向房主的物理设备。
    expect(resolveSessionLinkDeviceId({
      linkedDeviceId: target.deviceId,
      currentDeviceId: deviceId,
    })).toBe(deviceId);
  });

  it('resolves the device for a session link, falling back when the target is not listed', () => {
    // 已同步列表里的可达设备优先于深链冻结值(re-link 后冻结值可能已过期)。
    expect(resolveSessionLinkDeviceId({
      listedDeviceId: 'listed',
      linkedDeviceId: 'linked',
      currentDeviceId: 'current',
    })).toBe('listed');
    // 已归档 / 未同步的任务不在列表里:先用深链冻结设备,再退回当前任务所在设备。
    expect(resolveSessionLinkDeviceId({
      listedDeviceId: undefined,
      linkedDeviceId: 'linked',
      currentDeviceId: 'current',
    })).toBe('linked');
    expect(resolveSessionLinkDeviceId({
      listedDeviceId: undefined,
      linkedDeviceId: null,
      currentDeviceId: 'current',
    })).toBe('current');
    expect(resolveSessionLinkDeviceId({ linkedDeviceId: null, currentDeviceId: undefined })).toBeNull();
  });

  it('shortens long session ids for display', () => {
    expect(shortSessionId('03e0c22d-19db-4ac5-814f-1ea04040b471')).toBe('03e0c22d…b471');
    expect(shortSessionId('short-id')).toBe('short-id');
  });
});
