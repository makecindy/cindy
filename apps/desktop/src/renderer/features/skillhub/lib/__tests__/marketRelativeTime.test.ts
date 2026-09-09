import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { formatMarketRelativeTime } from '../../hooks/useMarketList';
import zhCNCommon from '@/i18n/locales/zh-CN/common.json';
import enCommon from '@/i18n/locales/en/common.json';
import jaCommon from '@/i18n/locales/ja/common.json';
import koCommon from '@/i18n/locales/ko/common.json';

const NOW = Date.parse('2026-06-11T12:00:00.000Z');

describe('market relative time i18n', () => {
  it('formats market card relative time through the active locale', async () => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage('zh-CN');

      expect(formatMarketRelativeTime('2026-06-11T09:00:00.000Z', i18n.t, NOW)).toBe('3 小时前');
      expect(formatMarketRelativeTime('2026-06-10T09:00:00.000Z', i18n.t, NOW)).toBe('昨天');
      expect(formatMarketRelativeTime('2026-06-11T11:59:45.000Z', i18n.t, NOW)).toBe('刚刚');

      await i18n.changeLanguage('en');
      expect(formatMarketRelativeTime('2026-06-11T09:00:00.000Z', i18n.t, NOW)).toBe('3 hours ago');
      expect(formatMarketRelativeTime('2026-06-10T09:00:00.000Z', i18n.t, NOW)).toBe('yesterday');
      expect(formatMarketRelativeTime('2026-06-11T11:59:45.000Z', i18n.t, NOW)).toBe('just now');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it('keeps market card keys aligned across supported locales', () => {
    const referenceKeys = Object.keys(zhCNCommon.skillhub.marketCard.relativeTime).sort();
    for (const common of [zhCNCommon, enCommon, jaCommon, koCommon]) {
      const relativeTime = common.skillhub.marketCard.relativeTime as Record<string, string>;
      expect(Object.keys(relativeTime).sort()).toEqual(referenceKeys);
      expect(common.skillhub.marketCard.clone).toBeTruthy();
      expect(common.skillhub.marketCard.timeLabel).toBeTruthy();
      expect(common.skillhub.marketCard.downloadsLabel).toBeTruthy();
      expect(relativeTime.justNow).toBeTruthy();
      expect(relativeTime.minutes_one).toBeTruthy();
      expect(relativeTime.minutes_other).toBeTruthy();
      expect(relativeTime.hours_one).toBeTruthy();
      expect(relativeTime.hours_other).toBeTruthy();
      expect(relativeTime.yesterday).toBeTruthy();
      expect(relativeTime.days_one).toBeTruthy();
      expect(relativeTime.days_other).toBeTruthy();
      expect(relativeTime.weeks_one).toBeTruthy();
      expect(relativeTime.weeks_other).toBeTruthy();
      expect(relativeTime.months_one).toBeTruthy();
      expect(relativeTime.months_other).toBeTruthy();
      expect(relativeTime.years_one).toBeTruthy();
      expect(relativeTime.years_other).toBeTruthy();
    }
  });
});
