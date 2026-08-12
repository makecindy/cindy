import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const design = readFileSync(
  fileURLToPath(new URL('../../../../../docs/design-rules/DESIGN.md', import.meta.url)),
  'utf8',
);
const css = readFileSync(
  fileURLToPath(new URL('../styles/globals.css', import.meta.url)),
  'utf8',
);
const component = readFileSync(
  fileURLToPath(new URL('../components/branding/BrandLoadingMark.tsx', import.meta.url)),
  'utf8',
);
const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'].map((locale) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../i18n/locales/${locale}/common.json`, import.meta.url)),
      'utf8',
    ),
  ),
);

describe('BrandLoadingMark design exception contract', () => {
  it('registers the session loader in motion, brand, and gradient rules', () => {
    expect(design).toContain('Session-loading wordmark sheen');
    expect(design).toContain('session-switch deferred-loading overlay');
    expect(design).toContain('Session-loading wordmark sheen — narrow functional exception');
  });

  it('keeps the exception bounded to delayed session switching', () => {
    expect(design).toContain('after a 200ms delayed-reveal threshold');
    expect(design).toContain('session-switch deferred-loading overlay only');
    expect(design).toContain('The standard `animate-spinner` remains the default loader everywhere else');
  });

  it('uses compositor-only motion and both motion gates', () => {
    expect(css).toMatch(/\.brand-loading-mark-sheen::before[\s\S]*?animation:\s*brand-loading-sheen[\s\S]*?infinite/);
    expect(css).toContain("[data-app-hidden='true'] .brand-loading-mark-sheen::before");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.brand-loading-mark-sheen::before[\s\S]*?animation:\s*none/,
    );
    expect(css).toMatch(/@keyframes brand-loading-sheen[\s\S]*?transform:\s*translateX\(350%\)/);
  });

  it('exposes a localized accessible status name', () => {
    expect(component).toContain("t('chat.sessionLoading', '正在加载任务')");
    expect(component).toContain('aria-label={loadingLabel}');
    expect(component).toContain('role="status"');
    expect(locales.every((locale) => typeof locale.chat.sessionLoading === 'string')).toBe(true);
    expect(locales.every((locale) => locale.chat.sessionLoading.length > 0)).toBe(true);
  });

  it('uses the session term in Japanese and Korean', () => {
    expect(locales[3].chat.sessionLoading).toContain('セッション');
    expect(locales[3].chat.sessionLoading).not.toContain('タスク');
    expect(locales[4].chat.sessionLoading).toContain('세션');
    expect(locales[4].chat.sessionLoading).not.toContain('작업');
  });
});
