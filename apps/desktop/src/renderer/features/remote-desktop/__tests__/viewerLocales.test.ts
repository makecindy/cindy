import { describe, expect, it } from 'vitest';
import en from '../../../i18n/locales/en/common.json';
import zhCN from '../../../i18n/locales/zh-CN/common.json';
import zhTW from '../../../i18n/locales/zh-TW/common.json';
import ja from '../../../i18n/locales/ja/common.json';
import ko from '../../../i18n/locales/ko/common.json';

describe('remote desktop settings copy survives file encoding', () => {
  it.each([
    ['en', en, /[A-Za-z]/u],
    ['zh-CN', zhCN, /\p{Script=Han}/u],
    ['zh-TW', zhTW, /\p{Script=Han}/u],
    ['ja', ja, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
    ['ko', ko, /\p{Script=Hangul}/u],
  ] as const)(
    '%s contains readable localized text, not replacement question marks',
    (_locale, catalog, letters) => {
      const entries = {
        ...catalog.remoteDesktop.viewer,
        remoteDisabled: catalog.remoteDesktop.remoteDisabled,
        accessRevoked: catalog.remoteDesktop.accessRevoked,
        directConnection: catalog.remoteDesktop.directConnection,
        videoRelay: catalog.remoteDesktop.videoRelay,
        screenshotRelay: catalog.remoteDesktop.screenshotRelay,
      };
      expect(Object.keys(catalog.remoteDesktop.viewer)).toEqual(
        Object.keys(en.remoteDesktop.viewer),
      );
      for (const [key, value] of Object.entries(entries)) {
        expect(value, key).not.toMatch(/\?{2,}|\uFFFD/u);
        expect(value, key).toMatch(letters);
      }
    },
  );
});
