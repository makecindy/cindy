
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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

  afterEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('labels every supported platform with the shared zh-CN wording', () => {
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
      'Cindy · 来自 iMessage',
    ]);
  });

  it('fails closed on unknown platforms', () => {
    expect(isMobileImPlatform('feishu')).toBe(true);
    expect(isMobileImPlatform('imessage')).toBe(true);
    expect(isMobileImPlatform('myspace')).toBe(false);
    expect(isMobileImPlatform(undefined)).toBe(false);
  });

  it('localizes existing platform names', async () => {
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
  });

  // #9266 unit regression: the real header helper must resolve iMessage in each
  // locale; the old Feishu-only cases missed the absent platform translation.
  it.each([
    ['en', 'Cindy · from iMessage'],
    ['es', 'Cindy · de iMessage'],
    ['fr', 'Cindy · depuis iMessage'],
    ['de', 'Cindy · von iMessage'],
    ['pt-PT', 'Cindy · de iMessage'],
    ['pt-BR', 'Cindy · de iMessage'],
    ['zh-CN', 'Cindy · 来自 iMessage'],
    ['zh-TW', 'Cindy · 來自 iMessage'],
    ['zh-Hant-x-lzh', 'Cindy · 自 iMessage 來'],
    ['zh-Hans-x-lzh', 'Cindy · 自 iMessage 来'],
    ['ja', 'Cindy · iMessage から'],
    ['ko', 'Cindy · iMessage에서'],
  ])('localizes the iMessage header in %s', async (locale, text) => {
    await i18n.changeLanguage(locale);
    expect(imSourceHeaderTitle('imessage')).toBe(text);
  });
});
