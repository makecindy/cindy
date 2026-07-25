/**
 * 原生应用菜单四语标签的术语门禁。
 *
 * 为什么需要单独一个测试:`scripts/check-i18n-glossary.mjs` 只读 renderer 的 locale
 * JSON,扫不到这份手写 TS catalog。引入术语表那轮它就整个漏掉了——zh-CN 的 `issues`
 * 还写着「议题」(Issue 的禁用译法),三语的 `settings` / `checkForUpdates` 还带着
 * ASCII 三点省略号,而这是 macOS 上常驻屏幕顶端的菜单栏,比大多数界面文案更显眼。
 *
 * 判定逻辑复用 scripts/shared/glossary-rules.mjs,与根门禁、mobile 影子 catalog 同一套,
 * 避免三处各写一份规则后悄悄漂移。
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

import { APPLICATION_MENU_LABELS } from '../applicationMenuLabels';

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
 * 摊平成 (locale, key, value)。
 *
 * 前缀必须是 `desktop:`——glossary.json 的 exempt 用 `^(desktop|mobile/xxx):` 校验格式,
 * 也按这个前缀匹配。用 `desktop-menu:` 之类的自造前缀会让 exempt 对这份 catalog 完全
 * 失效(而 note 里还写着"可复用同一套写法"),将来给某个菜单项加豁免时会白写一条。
 * 用 `menu.` 子命名空间区分来源。
 */
const entries = Object.entries(APPLICATION_MENU_LABELS).flatMap(([locale, labels]) =>
  Object.entries(labels).map(([key, value]) => ({
    locale,
    key: `desktop:menu.${key}`,
    value: value as string,
  })),
);

/** 标点豁免:与根门禁同源,只作用于半角标点检查(不含省略号)。 */
const isHalfWidthExempt = makeExemptChecker(glossary.punctuationExempt);

/** key → 英文源文案,供条件禁用按英文源判断。 */
const sourceByKey = new Map(
  entries.filter((e) => e.locale === glossary.sourceLocale).map((e) => [e.key, e.value]),
);

describe('原生应用菜单标签符合术语表', () => {
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
            // 复用共享匹配器:词边界与真实复数形态(Proxy → proxies)都由它统一处理。
            // 这里原先抄了一份正则,与根门禁各自演进早晚失配。
            const source = sourceByKey.get(key);
            if (!source || !sourceMentions(stripNonProse(source), whenEn)) continue;
          }
          const line = `${locale} ${key}: 「${bad}」（${term.en}）— ${value}`;
          // proposed 只提示不阻断,与根门禁的分级一致:那些术语还没拍板,
          // 但它们在本 catalog 的命中数同样该出现在讨论材料里。
          if (term.status === 'decided') violations.push(line);
          else notes.push(line);
        }
      }
    }
    if (notes.length > 0) console.warn(`[menu-glossary] 待裁决术语命中:\n${notes.join('\n')}`);
    expect(violations, `原生菜单命中禁用译法:\n${violations.join('\n')}`).toEqual([]);
  });

  it('保留英文的术语大小写形态统一', () => {
    const violations: string[] = [];
    // 与 forbidden 用例同一分级:proposed 也扫,只是降级为告警。跳过的话,菜单文案里
    // 「待裁决术语当前命中多少处」的数据就没了,而根门禁是会统计的。
    const notes: string[] = [];
    for (const term of glossary.terms) {
      const isExempt = makeExemptChecker(term.exempt);
      for (const { locale, key, value } of entries) {
        if (isExempt(key)) continue;
        // 触发条件统一由 caseStandardFor 判定(含 alsoAllowed 允许英文原词的情形),
        // 与根门禁同一份逻辑。
        const standard = caseStandardFor(term, locale);
        if (!standard) continue;
        const hit = findCaseMismatch(stripNonProse(value), standard);
        if (!hit) continue;
        const line = `${locale} ${key}: 「${hit}」应为「${standard}」`;
        if (term.status === 'decided') violations.push(line);
        else notes.push(line);
      }
    }
    if (notes.length > 0) console.warn(`[menu-glossary] 待裁决术语大小写:\n${notes.join('\n')}`);
    expect(violations, `原生菜单大小写不统一:\n${violations.join('\n')}`).toEqual([]);
  });

  it('标点风格符合各语言规则', () => {
    const violations: string[] = [];
    for (const { locale, key, value } of entries) {
      const prose = normalizeForPunctuation(value);
      // 与根门禁一致:punctuationExempt 只豁免半角标点、不豁免省略号。
      // 两边不一致的话,加一条豁免会让根门禁放行、而本测试误报阻断 CI。
      if (HALFWIDTH_PUNCT_LOCALES.has(locale) && !isHalfWidthExempt(key)) {
        const mark = findHalfWidthPunct(prose);
        if (mark) violations.push(`${locale} ${key}: 中文后半角「${mark}」— ${value}`);
      }
      if (ELLIPSIS_LOCALES.has(locale) && hasAsciiEllipsis(prose)) {
        violations.push(`${locale} ${key}: 应使用「…」而非三个半角点 — ${value}`);
      }
    }
    expect(violations, `原生菜单标点不符:\n${violations.join('\n')}`).toEqual([]);
  });
});
