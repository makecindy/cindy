import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const expectedXiaohongshuDescriptions: Record<string, string> = {
  'zh-CN': '关注中文内容',
  'zh-TW': '關注中文內容',
  en: 'Follow Chinese content',
  ja: '中国語コンテンツをフォロー',
  ko: '중국어 콘텐츠 팔로우',
};

describe('Settings About social links', () => {
  it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])('provides social copy for %s', (locale) => {
    const messages = JSON.parse(
      readFileSync(
        resolve(process.cwd(), `src/renderer/i18n/locales/${locale}/common.json`),
        'utf8',
      ),
    ) as {
      settings: {
        about: {
          social?: Record<string, string>;
        };
      };
    };

    expect(messages.settings.about.social).toMatchObject({
      title: expect.any(String),
      discordLabel: expect.any(String),
      discordDescription: expect.any(String),
      xLabel: expect.any(String),
      xDescription: expect.any(String),
      xiaohongshuLabel: expect.any(String),
      xiaohongshuDescription: expect.any(String),
      openFailed: expect.any(String),
    });
    expect(messages.settings.about.social?.xiaohongshuDescription).toBe(
      expectedXiaohongshuDescriptions[locale],
    );
  });
});
