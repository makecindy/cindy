import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const aboutSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/settings/AboutSection.tsx'),
  'utf8',
);
const themeColorsSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/themes/colors.ts'),
  'utf8',
);
const expectedXiaohongshuDescriptions: Record<string, string> = {
  'zh-CN': '关注中文内容',
  'zh-TW': '關注中文內容',
  en: 'Follow Chinese content',
  ja: '中国語コンテンツをフォロー',
  ko: '중국어 콘텐츠 팔로우',
};

describe('Settings About social links', () => {
  it('uses the official destinations and prioritizes the Discord community', () => {
    const discordIndex = aboutSource.indexOf('https://discord.gg/V4yKguac7K');
    const xIndex = aboutSource.indexOf('https://x.com/making_cindy');
    const xiaohongshuIndex = aboutSource.indexOf('https://xhslink.com/m/XmfveHjLlL');

    expect(discordIndex).toBeGreaterThan(-1);
    expect(xIndex).toBeGreaterThan(discordIndex);
    expect(xiaohongshuIndex).toBeGreaterThan(xIndex);
  });

  it('renders a desktop three-column action card and opens links externally', () => {
    expect(aboutSource).toContain('grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5');
    expect(aboutSource).toContain(
      'min-h-[68px] min-w-0 select-none items-center gap-3 rounded-full px-6 py-2.5',
    );
    expect(aboutSource).toContain('window.electronAPI.openExternal(url)');
    expect(aboutSource).toContain('if (!result.success)');
    expect(aboutSource).toContain("toast.error(t('settings.about.social.openFailed'))");
    expect(aboutSource).toContain('hover:bg-[var(--surface-hover)]');
    expect(aboutSource).toContain('active:scale-[0.98]');
    expect(aboutSource).toContain('active:bg-[var(--settings-social-card-pressed-bg)]');
    expect(aboutSource).toContain(
      'transition-opacity duration-[var(--motion-fast,150ms)] group-hover:opacity-100',
    );
    expect(themeColorsSource).toContain("'settings-social-card-pressed-bg'");
    expect(themeColorsSource).toContain(
      'color-mix(in srgb, var(--surface-hover) 88%, var(--text-primary) 12%)',
    );
    expect(aboutSource).toContain('focus-visible:ring-[var(--focus-ring-soft)]');
    expect(aboutSource).not.toContain('aria-label={t(link.labelKey)}');
    expect(aboutSource).toContain('{t(link.descriptionKey)}');
    expect(aboutSource).toContain('fillRule="evenodd"');
    expect(aboutSource).not.toContain('fill="var(--settings-theme-card-bg)"');
  });

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
