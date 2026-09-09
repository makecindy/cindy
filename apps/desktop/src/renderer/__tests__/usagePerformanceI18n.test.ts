import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';

const KEYS = ['timeAndRateValue', 'performanceLine', 'performanceRateLine'] as const;

describe('usage performance units', () => {
  it('keeps TPS in English templates', () => {
    const values = [
      en.quotaCard.timeAndRateValue,
      en.usageDetails.performanceLine,
      en.usageDetails.performanceRateLine,
    ];
    for (const value of values) expect(value).toContain('TPS');
  });

  it.each([
    ['zh-CN', zhCN, 'tokens/秒'],
    ['ja', ja, 'トークン/秒'],
    ['ko', ko, '토큰/초'],
  ] as const)('uses a localized token-per-second unit in %s', (_locale, messages, unit) => {
    const values = [
      messages.quotaCard[KEYS[0]],
      messages.usageDetails[KEYS[1]],
      messages.usageDetails[KEYS[2]],
    ];
    for (const value of values) {
      expect(value).toContain(unit);
      expect(value).not.toContain('TPS');
    }
  });
});
