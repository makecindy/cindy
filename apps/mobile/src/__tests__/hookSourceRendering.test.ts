
import { beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import {
  MOBILE_IM_PLATFORMS,
  imSourceHeaderTitle,
  isMobileImPlatform,
} from '@/session/messageSourceLabels';

describe('IM source header text', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('covers the same nine platforms as desktop with the shared zh-CN wording', () => {
    expect(MOBILE_IM_PLATFORMS.map((im) => imSourceHeaderTitle(im))).toEqual([
      'Cindy · 来自 Slack',
      'Cindy · 来自 Telegram',
      'Cindy · 来自 X',
      'Cindy · 来自 飞书',
      'Cindy · 来自 Lark',
      'Cindy · 来自 Discord',
      'Cindy · 来自 微信',
      'Cindy · 来自 企业微信',
      'Cindy · 来自 钉钉',
    ]);
  });

  it('fails closed on unknown platforms', () => {
    expect(isMobileImPlatform('feishu')).toBe(true);
    expect(isMobileImPlatform('myspace')).toBe(false);
    expect(isMobileImPlatform(undefined)).toBe(false);
  });

  it('localizes the header in every mobile locale', async () => {
    const expected: Record<string, string> = {
      en: 'Cindy · from Feishu',
      'zh-TW': 'Cindy · 來自 飛書',
      ja: 'Cindy · Feishu から',
      ko: 'Cindy · Feishu에서',
    };
    for (const [locale, text] of Object.entries(expected)) {
      await i18n.changeLanguage(locale);
      expect(imSourceHeaderTitle('feishu')).toBe(text);
    }
    await i18n.changeLanguage('zh-CN');
  });
});
