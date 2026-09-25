import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../../..');

function readNotice(file: string): string {
  const data = JSON.parse(readFileSync(file, 'utf8')) as {
    chat?: { remoteError?: { AUTO_REVIEW_UNAVAILABLE?: string } };
    remoteError?: { AUTO_REVIEW_UNAVAILABLE?: string };
  };
  const notice = data.chat?.remoteError?.AUTO_REVIEW_UNAVAILABLE
    ?? data.remoteError?.AUTO_REVIEW_UNAVAILABLE;
  if (!notice) throw new Error(`missing AUTO_REVIEW_UNAVAILABLE in ${file}`);
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
      ));
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
      ));
      for (const phrase of expected[locale]) expect(notice).toContain(phrase);
      expect(notice).not.toContain('默认权限');
      expect(notice).not.toContain('Default permissions');
    }
  });
});
