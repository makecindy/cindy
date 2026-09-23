import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/env', () => ({
  WECHAT_APP_ID: 'wx-test-mobile',
  WECHAT_UNIVERSAL_LINK: 'https://login.example.com/app/',
}));

import { redirectSystemPath } from '../../app/+native-intent';

describe('mobile native deep-link redirects', () => {
  it.each([true, false])('keeps WeChat SDK callbacks out of navigation (initial=%s)', (initial) => {
    for (const path of [
      'cindycn://oauth?code=test-wechat-code&state=test-state',
      'wx-test-mobile://oauth?code=test-wechat-code&state=test-state',
      '/oauth/?code=test-wechat-code#fragment',
      'wx-test-mobile://refreshToken?wechat_auth_context_id=test-context',
      'https://login.example.com/app/wx-test-mobile/oauth?code=test-wechat-code',
      'https://login.example.com/app/wx-test-mobile/refreshToken/',
      'https://login.example.com/app/oauth?code=test-wechat-code',
      'cindycn://app/wx-test-mobile/oauth?code=test-wechat-code',
      '/app/wx-test-mobile/refreshToken/',
      'https://login.example.com/app/wx-test-mobile/?_wechat_sdk_biz_data=test-payload&_wechat_sdk_biz_data_len=12',
      'cindycn://app/wx-test-mobile/?_wechat_sdk_biz_data=test-payload&_wechat_sdk_biz_data_len=12',
      '/app/wx-test-mobile/?_wechat_sdk_biz_data=test-payload',
    ]) {
      expect(redirectSystemPath({ path, initial })).toBe('/');
    }
  });

  it('does not consume unrelated paths, hosts or app IDs', () => {
    for (const path of [
      'cindycn://oauth/another-route',
      'https://other.example.com/app/oauth?code=test-code',
      'https://login.example.com/elsewhere/oauth',
      'https://login.example.com/app/wx-other/oauth',
      'https://login.example.com/app/article',
      'https://user@login.example.com/app/oauth',
      'https://other.example.com/app/wx-test-mobile/?_wechat_sdk_biz_data=test-payload',
      'cindycn://app/wx-other/?_wechat_sdk_biz_data=test-payload',
      'cindycn://elsewhere/wx-test-mobile/?_wechat_sdk_biz_data=test-payload',
      'cindycn://app/wx-test-mobile/article?_wechat_sdk_biz_data=test-payload',
      'cindycn://app/wx-test-mobile/',
      'cindycn://app/wx-test-mobile/?other=test-payload#_wechat_sdk_biz_data=test-payload',
      'cindycn://app/wx-test-mobile/?_wechat_sdk_biz_data_extra=test-payload',
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
    }
  });

  it('routes the Share Extension handoff into a new conversation', () => {
    expect(redirectSystemPath({
      path: 'cindycn://expo-sharing',
      initial: true,
    })).toBe('/sessions/new');
    expect(redirectSystemPath({
      path: '/expo-sharing?source=share-extension',
      initial: false,
    })).toBe('/sessions/new');
  });

  it('preserves existing auth and ordinary deep-link behavior', () => {
    expect(redirectSystemPath({
      path: 'cindy://auth?code=abc',
      initial: true,
    })).toBe('/');
    expect(redirectSystemPath({
      path: '/sessions/session-1',
      initial: false,
    })).toBe('/sessions/session-1');
  });
});
