import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../../..');

function readNotice(file: string, key: 'AUTO_REVIEW_UNAVAILABLE' | 'AUTO_REVIEW_UNAVAILABLE_WECHAT'): string {
  const data = JSON.parse(readFileSync(file, 'utf8')) as {
    chat?: { remoteError?: Record<string, string> };
    remoteError?: Record<string, string>;
  };
  const notice = data.chat?.remoteError?.[key] ?? data.remoteError?.[key];
  if (!notice) throw new Error(`missing ${key} in ${file}`);
  return notice;
}

const desktopLocales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;
const mobileLocales = desktopLocales;

describe('auto-review unavailable copy', () => {
  it('desktop and mobile locales suggest Full access and name the risk', () => {
    const expected = {
      'zh-CN': ['完全访问', '风险更高'],
      'zh-TW': ['完全訪問', '風險更高'],
      en: ['Full access', 'higher risk'],
      ja: ['フルアクセス', 'リスク'],
      ko: ['전체 접근', '위험'],
    } as const;
    for (const locale of desktopLocales) {
      const notice = readNotice(path.join(
        repoRoot,
        'apps/desktop/src/renderer/i18n/locales',
        locale,
        'common.json',
      ), 'AUTO_REVIEW_UNAVAILABLE');
      for (const phrase of expected[locale]) expect(notice).toContain(phrase);
      expect(notice).not.toContain('默认权限');
      expect(notice).not.toContain('Default permissions');
    }
    for (const locale of mobileLocales) {
      const notice = readNotice(path.join(
        repoRoot,
        'apps/mobile/src/i18n/locales',
        locale,
        'session.json',
      ), 'AUTO_REVIEW_UNAVAILABLE');
      for (const phrase of expected[locale]) expect(notice).toContain(phrase);
      expect(notice).not.toContain('默认权限');
      expect(notice).not.toContain('Default permissions');
    }
  });

  it('personal WeChat task views ask for direct confirmation instead of Full access', () => {
    const expected = {
      'zh-CN': ['个人微信', '完全访问', '直接确认'],
      'zh-TW': ['個人微信', '完全訪問', '直接確認'],
      en: ['Personal WeChat', 'Full access', 'Confirm this action directly'],
      ja: ['個人 WeChat', 'フルアクセス', '直接確認'],
      ko: ['개인 WeChat', '전체 접근', '직접 확인'],
    } as const;
    const forbidden = ['想少被打断', 'Switch this task', '中断を減らしたい', '중단을 줄이려면', '想少被打斷'];
    for (const locale of desktopLocales) {
      const notice = readNotice(path.join(
        repoRoot, 'apps/desktop/src/renderer/i18n/locales', locale, 'common.json',
      ), 'AUTO_REVIEW_UNAVAILABLE_WECHAT');
      for (const phrase of expected[locale]) expect(notice).toContain(phrase);
      for (const phrase of forbidden) expect(notice).not.toContain(phrase);
    }
    for (const locale of mobileLocales) {
      const notice = readNotice(path.join(
        repoRoot, 'apps/mobile/src/i18n/locales', locale, 'session.json',
      ), 'AUTO_REVIEW_UNAVAILABLE_WECHAT');
      for (const phrase of expected[locale]) expect(notice).toContain(phrase);
      for (const phrase of forbidden) expect(notice).not.toContain(phrase);
    }
  });
});
