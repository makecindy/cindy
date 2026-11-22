/**
 * 主进程手写多语 catalog 的 Buddy 术语守卫。
 *
 * 为什么需要它：根门禁只扫 renderer / mobile 的 locale JSON，
 * apps/desktop/src/main 下还有一批「字符串直接写在 TS 里」的 catalog
 * （editorCopy、菜单项、OAuth 结果页等）。术语表改判时，这些地方
 * 不会被门禁发现，「Teammate avatar」这一类就是这么漏过一轮的。
 *
 * 判定数据来自 i18n/glossary.json 的 forbidden 列表；这里只做一件事：
 * 任何 locale 键值里出现该语种的 Buddy 禁用译法，测试失败。
 * 新增手写 catalog 时，把文件加进 SCANNED_FILES 即可。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { occursIn, stripNonProse } from '../../../../../scripts/shared/glossary-rules.mjs';

const REPO_ROOT = resolve(__dirname, '../../../../..');

interface GlossaryTerm {
  en: string;
  status: 'decided' | 'proposed';
  forbidden?: Record<string, (string | { text: string; whenEn: string })[]>;
}

const glossary = JSON.parse(readFileSync(resolve(REPO_ROOT, 'i18n/glossary.json'), 'utf8')) as {
  terms: GlossaryTerm[];
};

/** 手写多语 catalog 的源码文件（相对仓库根）。 */
const SCANNED_FILES = [
  'apps/desktop/src/main/localDb/ipc/botRemoteEditors.ts',
  'apps/desktop/src/main/applicationMenuLabels.ts',
  'apps/desktop/src/main/oauthResultPage.ts',
  'apps/desktop/src/main/endpointManifestDialogCopy.ts',
] as const;

const LOCALE_KEY = /(['"])(en|ja|ko|es|fr|de|pt-PT|pt-BR|id|zh-CN|zh-TW|zh-Hant-x-lzh|zh-Hans-x-lzh)\1\s*:\s*(['"])((?:\\.|(?!\3).)*?)\3/g;

function buddyForbidden(): Record<string, string[]> {
  const term = glossary.terms.find((t) => t.en.toLowerCase() === 'buddy');
  if (!term) throw new Error('glossary.json 里找不到 Buddy 条目');
  const out: Record<string, string[]> = {};
  for (const [locale, entries] of Object.entries(term.forbidden ?? {})) {
    out[locale] = entries.map((e) => (typeof e === 'string' ? e : e.text));
  }
  return out;
}

describe('主进程手写 catalog 的 Buddy 术语', () => {
  it('不使用任何语种的 Buddy 禁用译法', () => {
    const forbidden = buddyForbidden();
    const violations: string[] = [];

    for (const file of SCANNED_FILES) {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      for (const match of source.matchAll(LOCALE_KEY)) {
        const locale = match[2];
        const value = match[4].replace(/\\'/g, "'").replace(/\\"/g, '"');
        const prose = stripNonProse(value);
        for (const bad of forbidden[locale] ?? []) {
          if (!bad || !occursIn(prose, bad)) continue;
          violations.push(String(file) + ' [' + locale + '] "' + bad + '" -> ' + value.slice(0, 120));
        }
      }
    }

    expect(violations, '手写 catalog 命中 Buddy 禁用译法:\n' + violations.join('\n')).toEqual([]);
  });
});

