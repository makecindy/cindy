/**
 * OAuth 回调结果页四语文案的术语门禁。
 *
 * 又一处扫描盲区:`check-i18n-glossary.mjs` 只读 locale JSON,而这些文案是
 * `oauthResultPage.ts` 里的手写四语 catalog。它们渲染在**系统浏览器**里——用户完成
 * 第三方授权后看到的第一屏,失败时还要靠它说清下一步该做什么,可见度不低。
 * 既有的 oauthResultPage.test.ts 只校验完整性与渲染结果,不校验术语与标点。
 *
 * 判定逻辑复用 scripts/shared/glossary-rules.mjs,与根门禁、mobile 影子 catalog、
 * 原生菜单 catalog 同一套,避免各处规则悄悄漂移。
 *
 * 文案取值方式:这个模块的四语文案分散在若干函数与常量里,且部分需要传入
 * providerName / brandName,所以下面用固定的占位实参把它们全部求值出来再扫。
 * 占位值刻意不含 CJK 与标点,免得实参本身影响判定。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ELLIPSIS_LOCALES,
  HALFWIDTH_PUNCT_LOCALES,
  countOccurrences,
  findCaseMismatch,
  findHalfWidthPunct,
  hasAsciiEllipsis,
  makeExemptChecker,
  normalizeForPunctuation,
  stripNonProse,
  caseStandardFor,
  sourceMentions,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- 共享规则是 .mjs,没有类型声明;这里只用它做断言
} from '../../../../../scripts/shared/glossary-rules.mjs';

import {
  buildOAuthReturnAction,
  getGhostOAuthResultCopy,
  getOAuthNeutralResultCopy,
  getProviderOAuthResultCopy,
  type OAuthResultPageLang,
} from '../oauthResultPage';

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

/** 该模块用 'zh' 作语言键,术语表用 'zh-CN';不映射的话 zh 分支整段扫不到。 */
const LANGS: OAuthResultPageLang[] = ['zh', 'en', 'ja', 'ko'];
const toLocale = (lang: OAuthResultPageLang) => (lang === 'zh' ? 'zh-CN' : lang);

/** 占位实参:不含 CJK 与标点,避免实参本身影响判定。 */
const PROVIDER = 'Notion';
const BRAND = 'Cindy';

function collectEntries(): { locale: string; key: string; value: string }[] {
  const out: { locale: string; key: string; value: string }[] = [];
  const push = (lang: OAuthResultPageLang, key: string, value: string) => {
    out.push({ locale: toLocale(lang), key: `desktop:oauthResultPage.${key}`, value });
  };

  for (const lang of LANGS) {
    const provider = getProviderOAuthResultCopy(lang, PROVIDER, BRAND);
    for (const [k, v] of Object.entries(provider)) {
      if (typeof v === 'string') push(lang, `provider.${k}`, v);
    }

    const ghost = getGhostOAuthResultCopy(lang);
    for (const [kind, copy] of Object.entries(ghost)) {
      if (typeof copy === 'string') {
        push(lang, `ghost.${kind}`, copy);
      } else if (copy && typeof copy === 'object') {
        for (const [k, v] of Object.entries(copy as Record<string, unknown>)) {
          if (typeof v === 'string') push(lang, `ghost.${kind}.${k}`, v);
        }
      }
    }

    const neutral = getOAuthNeutralResultCopy(lang, BRAND);
    for (const [k, v] of Object.entries(neutral)) {
      if (typeof v === 'string') push(lang, `neutral.${k}`, v);
    }

    // 签名是 (lang, source, brandName);只扫 label,href 是 deep link 不是文案。
    const action = buildOAuthReturnAction(lang, 'login', BRAND);
    push(lang, 'returnAction.label', action.label);
  }

  return out;
}

const entries = collectEntries();
const sourceByKey = new Map(
  entries.filter((e) => e.locale === glossary.sourceLocale).map((e) => [e.key, e.value]),
);
const isHalfWidthExempt = makeExemptChecker(glossary.punctuationExempt);

describe('OAuth 结果页文案符合术语表', () => {
  it('摊平后覆盖四种语言且非空（防止 import 失效后测试静默通过）', () => {
    expect(entries.length).toBeGreaterThan(0);
    const seen = new Set(entries.map((e) => e.locale));
    for (const locale of glossary.locales) {
      expect(seen.has(locale), `OAuth 文案缺 ${locale}`).toBe(true);
    }
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
          if (countOccurrences(stripNonProse(value), bad) === 0) continue;
          if (whenEn) {
            // 复用共享匹配器:词边界与真实复数形态(Proxy → proxies)都由它统一处理。
            // 这里原先抄了一份正则,与根门禁各自演进早晚失配。
            const source = sourceByKey.get(key);
            if (!source || !sourceMentions(stripNonProse(source), whenEn)) continue;
          }
          // 与根门禁一致:只报事实与英文源,不给替换目标
          const source = sourceByKey.get(key);
          const line =
            `${locale} ${key}: 「${bad}」是 ${term.en} 条目下的禁用译法` +
            `\n    译文: ${value.slice(0, 60)}` +
            (source ? `\n    英文源: ${source.slice(0, 60)}` : '');
          if (term.status === 'decided') violations.push(line);
          else notes.push(line);
        }
      }
    }
    if (notes.length > 0) console.warn(`[oauth-glossary] 待裁决术语命中:\n${notes.join('\n')}`);
    expect(violations, `OAuth 文案命中禁用译法:\n${violations.join('\n')}`).toEqual([]);
  });

  it('保留英文的术语大小写形态统一', () => {
    const violations: string[] = [];
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
    if (notes.length > 0) console.warn(`[oauth-glossary] 待裁决术语大小写:\n${notes.join('\n')}`);
    expect(violations, `OAuth 文案大小写不统一:\n${violations.join('\n')}`).toEqual([]);
  });

  it('标点风格符合各语言规则', () => {
    const violations: string[] = [];
    for (const { locale, key, value } of entries) {
      const prose = normalizeForPunctuation(value);
      if (HALFWIDTH_PUNCT_LOCALES.has(locale) && !isHalfWidthExempt(key)) {
        const mark = findHalfWidthPunct(prose);
        if (mark) violations.push(`${locale} ${key}: 中文后半角「${mark}」— ${value.slice(0, 60)}`);
      }
      if (ELLIPSIS_LOCALES.has(locale) && hasAsciiEllipsis(prose)) {
        violations.push(`${locale} ${key}: 应使用「…」而非三个半角点 — ${value.slice(0, 60)}`);
      }
    }
    expect(violations, `OAuth 文案标点不符:\n${violations.join('\n')}`).toEqual([]);
  });
});
