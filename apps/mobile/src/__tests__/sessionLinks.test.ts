import { describe, expect, it } from 'vitest';
import {
  buildMobileSessionDeepLink,
  buildMobileSessionMessageDeepLink,
  extractSessionLinkIds,
  parseSessionDeepLinkUrl,
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

  it('shortens long session ids for display', () => {
    expect(shortSessionId('03e0c22d-19db-4ac5-814f-1ea04040b471')).toBe('03e0c22d…b471');
    expect(shortSessionId('short-id')).toBe('short-id');
  });
});
