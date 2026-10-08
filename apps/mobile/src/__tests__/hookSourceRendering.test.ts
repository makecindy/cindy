import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import {
  MOBILE_IM_PLATFORMS,
  imSourceHeaderTitle,
  isMobileImPlatform,
} from '@/session/messageSourceLabels';

describe('mobile shared Cindy source card wiring', () => {
  it('downgrades only legacy hook rows (stored prompt) and keeps local IM rows as user rows', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).toContain('&& !item.message.hookSource.userTextContent');
    expect(source).toContain("kind: 'system' as const, align: 'agent' as const");
    expect(source).toContain('testID="message.hookSource"');
    // 抬头走 i18n「Cindy · 来自 {{platform}}」,不再硬编码 Slack / Telegram / X。
    expect(source).toContain('{imSourceHeaderTitle(hookSource.im)}');
    expect(source).not.toContain("hookSource.im === 'x' ? 'X' : 'Slack'");
    expect(source).toContain('{hookSource.channelName}');
    // IM 卡片与桌面一样左对齐;长正文仍走有界测量与折叠保护。
    expect(source).toContain('presentation.isUserAligned && !item.message.hookSource');
    expect(source).toContain('(isUser || hookSource !== undefined)');
    expect(source).toContain("(item.message.kind === 'user' || hookSource !== undefined)");
  });
});

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
