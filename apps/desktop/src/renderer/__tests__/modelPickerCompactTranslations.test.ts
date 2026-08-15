import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

const nonEnglishCatalogs = { ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW } as const;

describe('desktop model-picker compact translations', () => {
  it('uses Sub for the English subscription badge', () => {
    expect(en.newChat.modelSelector.meta.subscriptionBadgeCompact).toBe('Sub');
  });

  it.each(Object.entries(nonEnglishCatalogs))(
    '%s keeps subscription and effort labels short enough for a narrow model row',
    (_locale, catalog) => {
      expect(
        Array.from(catalog.newChat.modelSelector.meta.subscriptionBadgeCompact).length,
      ).toBeLessThanOrEqual(4);
      for (const label of Object.values(catalog.effortLevels)) {
        expect(Array.from(label).length).toBeLessThanOrEqual(4);
      }
    },
  );
});
