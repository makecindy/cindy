/**
 * 端点清单阻断框四语文案的术语门禁(影子 catalog 第四处)。
 *
 * 为什么需要:`scripts/check-i18n-glossary.mjs` 只读 renderer 的 locale JSON,而这个框
 * 弹在 createWindow 之前——renderer 与 i18next 都还不存在,文案只能手写在 main 侧的
 * `endpointManifestDialogCopy.ts` 里,根门禁扫不到。它还是**启动失败时用户看到的唯一
 * 一屏**,措辞与标点出错的代价不比应用内文案小。
 *
 * 判定逻辑复用 scripts/shared/glossary-rules.mjs,与根门禁、mobile 影子 catalog、
 * 原生菜单与 OAuth 结果页 catalog 同一套,避免各处规则悄悄漂移。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ELLIPSIS_LOCALES,
  HALFWIDTH_PUNCT_LOCALES,
  findCaseMismatch,
  findHalfWidthPunct,
  hasAsciiEllipsis,
  makeExemptChecker,
  normalizeForPunctuation,
  occursIn,
  stripNonProse,
  caseStandardFor,
  sourceMentions,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- 共享规则是 .mjs,没有类型声明;这里只用它做断言
} from '../../../../../scripts/shared/glossary-rules.mjs';

import { ENDPOINT_MANIFEST_DIALOG_COPY } from '../endpointManifestDialogCopy';

const REPO_ROOT = resolve(__dirname, '../../../../..');

interface GlossaryTerm {
  id: string;
  status: 'decided' | 'proposed';
  en: string;
  translations?: Record<string, string>;
  forbidden?: Record<string, (string | { text: string; whenEn: string })[]>;
  exempt?: string[];
  checkCase?: boolean;
}

const glossary = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'i18n/glossary.json'), 'utf8'),
) as {
  locales: string[];
  sourceLocale: string;
  punctuationExempt?: string[];
  terms: GlossaryTerm[];
};

/**
 * 摊平成 (locale, key, value)。前缀必须是 `desktop:`——glossary.json 的 exempt 按
 * `^(desktop|mobile/xxx):` 校验并匹配,自造前缀会让豁免对本 catalog 静默失效
 * (同 applicationMenuLabels.test.ts 的注释)。用 `endpointDialog.` 子命名空间区分来源。
 */
const entries = Object.entries(ENDPOINT_MANIFEST_DIALOG_COPY).flatMap(([locale, copy]) =>
  Object.entries(copy).map(([key, value]) => ({
    locale,
    key: `desktop:endpointDialog.${key}`,
    value: value as string,
  })),
);

/** 标点豁免:与根门禁同源,只作用于半角标点检查(不含省略号)。 */
const isHalfWidthExempt = makeExemptChecker(glossary.punctuationExempt);

/** key → 英文源文案,供条件禁用按英文源判断。 */
const sourceByKey = new Map(
  entries.filter((e) => e.locale === glossary.sourceLocale).map((e) => [e.key, e.value]),
);

describe('端点清单弹框文案符合术语表', () => {
  it('摊平后覆盖四种语言', () => {
    const locales = new Set(entries.map((e) => e.locale));
    expect([...locales].sort()).toEqual([...glossary.locales].sort());
    expect(entries.length).toBeGreaterThan(0);
  });

  it('不使用术语表的禁用译法', () => {
    const violations: string[] = [];
    const notes: string[] = [];
    for (const term of glossary.terms) {
      const isExempt = makeExemptChecker(term.exempt);
      for (const { locale, key, value } of entries) {
        if (isExempt(key)) continue;
        for (const entry of term.forbidden?.[locale] ?? []) {
          const bad = typeof entry === 'string' ? entry : entry.text;
          const whenEn = typeof entry === 'string' ? null : entry.whenEn;
          if (!occursIn(stripNonProse(value), bad)) continue;
          if (whenEn) {
            const source = sourceByKey.get(key);
            if (!source || !sourceMentions(stripNonProse(source), whenEn)) continue;
          }
          const line = `${locale} ${key}: 「${bad}」（${term.en}）— ${value}`;
          if (term.status === 'decided') violations.push(line);
          else notes.push(line);
        }
      }
    }
    if (notes.length > 0) {
      console.warn(`[endpoint-dialog-glossary] 待裁决术语命中:\n${notes.join('\n')}`);
    }
    expect(violations, `端点弹框命中禁用译法:\n${violations.join('\n')}`).toEqual([]);
  });

  it('保留英文的术语大小写形态统一', () => {
    const violations: string[] = [];
    const notes: string[] = [];
    for (const term of glossary.terms) {
      const isExempt = makeExemptChecker(term.exempt);
      for (const { locale, key, value } of entries) {
        if (isExempt(key)) continue;
        const standard = caseStandardFor(term, locale);
        if (!standard) continue;
        const hit = findCaseMismatch(stripNonProse(value), standard);
        if (!hit) continue;
        const line = `${locale} ${key}: 「${hit}」应为「${standard}」`;
        if (term.status === 'decided') violations.push(line);
        else notes.push(line);
      }
    }
    if (notes.length > 0) {
      console.warn(`[endpoint-dialog-glossary] 待裁决术语大小写:\n${notes.join('\n')}`);
    }
    expect(violations, `端点弹框大小写不统一:\n${violations.join('\n')}`).toEqual([]);
  });

  it('标点风格符合各语言规则', () => {
    const violations: string[] = [];
    for (const { locale, key, value } of entries) {
      const prose = normalizeForPunctuation(value);
      if (HALFWIDTH_PUNCT_LOCALES.has(locale) && !isHalfWidthExempt(key)) {
        const mark = findHalfWidthPunct(prose);
        if (mark) violations.push(`${locale} ${key}: 中文后半角「${mark}」— ${value}`);
      }
      if (ELLIPSIS_LOCALES.has(locale) && hasAsciiEllipsis(prose)) {
        violations.push(`${locale} ${key}: 应使用「…」而非三个半角点 — ${value}`);
      }
    }
    expect(violations, `端点弹框标点不符:\n${violations.join('\n')}`).toEqual([]);
  });
});
