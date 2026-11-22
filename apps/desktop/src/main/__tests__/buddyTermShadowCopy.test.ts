/**
 * 主进程手写多语 catalog 的 Buddy 术语守卫。
 *
 * 为什么需要它：根门禁只扫 renderer / mobile 的 locale JSON，
 * apps/desktop/src/main 下还有一批「字符串直接写在 TS 里」的 catalog
 * （editorCopy、菜单项、OAuth 结果页等）。术语表改判时，这些地方
 * 不会被门禁发现，「Teammate avatar」这一类就是这么漏过一轮的。
 *
 * 为什么读运行时对象而不是正则扫源码：editorCopy 用 text(fallback, zh-CN, zh-TW, ja, ko, {...})
 * 传参，en / ja / ko 根本不出现在「locale: value」这种字面量里，正则扫不到。
 * 这里直接取求值后的 fallback 与 translations，位置参数也一并覆盖。
 *
 * 判定数据来自 i18n/glossary.json 的 forbidden 列表。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- 共享规则是 .mjs，没有类型声明；这里只借它做断言
import { occursIn, stripNonProse } from '../../../../../scripts/shared/glossary-rules.mjs';

import { editorCopy } from '../localDb/ipc/botRemoteEditors';

const REPO_ROOT = resolve(__dirname, '../../../../..');

interface GlossaryTerm {
  en: string;
  status: 'decided' | 'proposed';
  forbidden?: Record<string, (string | { text: string; whenEn: string })[]>;
}

const glossary = JSON.parse(readFileSync(resolve(REPO_ROOT, 'i18n/glossary.json'), 'utf8')) as {
  terms: GlossaryTerm[];
};

interface LocalizedEntry {
  locale: string;
  key: string;
  value: string;
}

/** 展开 RemoteLocalizedText：fallback 是英文，translations 覆盖其余语种。 */
export function flattenLocalizedCatalog(catalog: Readonly<Record<string, unknown>>): LocalizedEntry[] {
  const out: LocalizedEntry[] = [];
  for (const [key, entry] of Object.entries(catalog)) {
    if (!entry || typeof entry !== 'object') continue;
    const localized = entry as { fallback?: unknown; translations?: unknown };
    if (typeof localized.fallback === 'string') out.push({ locale: 'en', key, value: localized.fallback });
    if (localized.translations && typeof localized.translations === 'object') {
      for (const [locale, value] of Object.entries(localized.translations as Record<string, unknown>)) {
        if (typeof value === 'string') out.push({ locale, key, value });
      }
    }
  }
  return out;
}

function buddyForbidden(): Record<string, string[]> {
  const term = glossary.terms.find((t) => t.en.toLowerCase() === 'buddy');
  if (!term) throw new Error('glossary.json 里找不到 Buddy 条目');
  const out: Record<string, string[]> = {};
  for (const [locale, entries] of Object.entries(term.forbidden ?? {})) {
    out[locale] = entries.map((e) => (typeof e === 'string' ? e : e.text));
  }
  return out;
}

function violationsIn(entries: readonly LocalizedEntry[]): string[] {
  const forbidden = buddyForbidden();
  const out: string[] = [];
  for (const { locale, key, value } of entries) {
    const prose = stripNonProse(value);
    for (const bad of forbidden[locale] ?? []) {
      if (!bad || !occursIn(prose, bad)) continue;
      out.push(String(key) + ' [' + locale + '] "' + bad + '" -> ' + value.slice(0, 120));
    }
  }
  return out;
}

describe('主进程手写 catalog 的 Buddy 术语', () => {
  it('editorCopy 的 13 个语种都不使用 Buddy 禁用译法', () => {
    const entries = flattenLocalizedCatalog(editorCopy as unknown as Record<string, unknown>);
    // 位置参数也要覆盖：en / zh / ja / ko 都在，缺一个说明展开逻辑漏了。
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      expect(entries.some((e) => e.locale === locale), '缺少 ' + locale).toBe(true);
    }
    expect(violationsIn(entries), 'editorCopy 命中 Buddy 禁用译法:\n' + violationsIn(entries).join('\n')).toEqual([]);
  });

  // 证明位置参数那几种语言真的会被抓到：把英文 fallback 换成旧叫法就应当报红。
  it('英文 fallback 命中时会被判出（位置参数覆盖）', () => {
    const sample = flattenLocalizedCatalog({
      create: { fallback: 'New teammate', translations: { ja: 'チームメイト作成', 'zh-CN': '创建伙伴' } },
    });
    const hits = violationsIn(sample);
    expect(hits.length).toBe(2);
    expect(hits.join('\n')).toContain('en');
    expect(hits.join('\n')).toContain('ja');
  });
});

