/**
 * 影子 catalog 的术语门禁断言(供多个 catalog 复用,本身不是测试文件)。
 *
 * 为什么需要它:`scripts/check-i18n-glossary.mjs` 只读 renderer 的 locale JSON,扫不到
 * main 侧手写的四语 TS catalog。引入术语表那轮 applicationMenuLabels 就整个漏掉了——
 * zh-CN 的 `issues` 还写着「议题」(Issue 的禁用译法),三语的 `settings` /
 * `checkForUpdates` 还带着 ASCII 三点省略号,而那是 macOS 上常驻屏幕顶端的菜单栏。
 *
 * 判定逻辑复用 scripts/shared/glossary-rules.mjs,与根门禁、mobile 影子 catalog 同一套,
 * 避免各写一份规则后悄悄漂移。第二份 catalog(可编辑控件右键菜单)进来时抽成本模块,
 * 免得同一批断言被复制两份、日后只改一处。
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

export interface ShadowCatalogEntry {
  locale: string;
  key: string;
  value: string;
}

/**
 * 把 `Record<locale, Record<key, string>>` 摊平成 (locale, key, value)。
 *
 * `keyPrefix` 必须以 `desktop:` 开头——glossary.json 的 exempt 用
 * `^(desktop|mobile/xxx):` 校验格式,也按这个前缀匹配。用 `desktop-menu:` 之类的自造
 * 前缀会让 exempt 对这份 catalog 完全失效,将来给某个菜单项加豁免时会白写一条。
 * 前缀后面用子命名空间(`menu.` / `editMenu.`)区分来源。
 */
export function flattenShadowCatalog(
  // 各 catalog 的值是 interface,没有 index signature,结构上匹配不了
  // Record<string, string>;这里收 unknown 再断言,免得每个 catalog 都得为测试
  // 改成带索引签名的类型。
  catalog: Readonly<Record<string, unknown>>,
  keyPrefix: string,
): ShadowCatalogEntry[] {
  if (!keyPrefix.startsWith('desktop:')) {
    throw new Error(`影子 catalog 的 key 前缀必须以 desktop: 开头,收到 ${keyPrefix}`);
  }
  return Object.entries(catalog).flatMap(([locale, labels]) =>
    Object.entries(labels as Record<string, string>).map(([key, value]) => ({
      locale,
      key: `${keyPrefix}${key}`,
      value,
    })));
}

/**
 * 对一份摊平后的影子 catalog 跑完整术语门禁。
 *
 * `surface` 只进断言与告警文案,用来在失败输出里区分是哪份 catalog 出的问题。
 */
export function describeShadowCatalogGlossary(
  title: string,
  entries: readonly ShadowCatalogEntry[],
  surface: string,
): void {
  /** 标点豁免:与根门禁同源,只作用于半角标点检查(不含省略号)。 */
  const isHalfWidthExempt = makeExemptChecker(glossary.punctuationExempt);

  /** key → 英文源文案,供条件禁用按英文源判断。 */
  const sourceByKey = new Map(
    entries.filter((e) => e.locale === glossary.sourceLocale).map((e) => [e.key, e.value]),
  );

  describe(title, () => {
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
      expect(violations, `${surface}命中禁用译法:\n${violations.join('\n')}`).toEqual([]);
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
      expect(violations, `${surface}大小写不统一:\n${violations.join('\n')}`).toEqual([]);
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
      expect(violations, `${surface}标点不符:\n${violations.join('\n')}`).toEqual([]);
    });
  });
}
