import { describe, expect, it } from 'vitest';

import en from '@/i18n/locales/en/models.json';
import ja from '@/i18n/locales/ja/models.json';
import ko from '@/i18n/locales/ko/models.json';
import zhCN from '@/i18n/locales/zh-CN/models.json';
import zhTW from '@/i18n/locales/zh-TW/models.json';

const nonEnglishCatalogs = { ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW } as const;

describe('mobile model-picker translations', () => {
  it('uses Sub in the English list and keeps the full English option labels', () => {
    expect(en.picker.subscriptionBadgeCompact).toBe('Sub');
    expect(en.options.effortLevels.xhigh).toBe('Extra High');
  });

  it.each(Object.entries(nonEnglishCatalogs))(
    '%s keeps localized list metadata within four characters',
    (_locale, catalog) => {
      expect(
        Array.from(catalog.picker.subscriptionBadgeCompact).length,
      ).toBeLessThanOrEqual(4);
      for (const label of Object.values(catalog.options.effortLevels)) {
        expect(Array.from(label).length).toBeLessThanOrEqual(4);
      }
    },
  );
});
