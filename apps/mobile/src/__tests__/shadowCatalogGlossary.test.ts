/**
 * 影子 catalog 的术语表门禁。
 *
 * mobile 有一批**不走 i18next** 的手写多语 catalog(loginMessages / newSessionMessages),
 * 原因是它们在 React 渲染树之外、更早期被同步调用。根脚本 check-i18n-glossary.mjs 只扫
 * locale JSON,扫不到这些 .ts —— 这是引入术语表时明确记录在案的盲区,本测试把它补上。
 *
 * 走 vitest 而不是扩展根脚本:vitest 本就能解析 TS 与路径别名,直接 import 拿到运行时对象,
 * 比在 node 脚本里正则抠 TS 源码可靠得多(嵌套结构下正则根本判不准 locale 归属)。
 * 规则函数复用 scripts/shared/glossary-rules.mjs,与根门禁同一套判定,不另写一份。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { authErrorMessages, loginMessages } from "@/auth/loginMessages";
import { newSessionMessages } from "@/session/newSessionMessages";
import { FULL_ACCESS_CONFIRMATION_COPY } from "@/session/fullAccessConfirmationCopy";
import {
  ELLIPSIS_LOCALES,
  HALFWIDTH_PUNCT_LOCALES,
  findCaseMismatch,
  findHalfWidthPunct,
  hasAsciiEllipsis,
  makeExemptChecker,
  occursIn,
  normalizeForPunctuation,
  stripNonProse,
  caseStandardFor,
  sourceMentions,
} from "../../../../scripts/shared/glossary-rules.mjs";

const REPO_ROOT = resolve(__dirname, "../../../..");

interface GlossaryTerm {
  id: string;
  status: "decided" | "proposed";
  en: string;
  /** status=proposed 的术语允许还没定译法,与 glossary.schema.json 一致 */
  translations?: Record<string, string>;
  forbidden?: Record<string, (string | { text: string; whenEn: string })[]>;
  exempt?: string[];
  checkCase?: boolean;
}

const glossary = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "i18n/glossary.json"), "utf8"),
) as {
  locales: string[];
  sourceLocale: string;
  punctuationExempt?: string[];
  terms: GlossaryTerm[];
};

/**
 * 把影子 catalog 摊平成 (source, locale, key, value)。
 * source 前缀与根脚本的 `mobile/<ns>:` 保持同一形态,便于 exempt 复用同一套写法。
 */
function collectEntries(): { locale: string; key: string; value: string }[] {
  const out: { locale: string; key: string; value: string }[] = [];

  // loginMessages: locale → key → string
  for (const [locale, table] of Object.entries(loginMessages)) {
    for (const [key, value] of Object.entries(table)) {
      out.push({ locale, key: `mobile/loginMessages:${key}`, value });
    }
  }

  // authErrorMessages: errorCode → locale → string(与上面维度相反)
  for (const [code, table] of Object.entries(authErrorMessages)) {
    for (const [locale, value] of Object.entries(table)) {
      out.push({ locale, key: `mobile/authErrorMessages:${code}`, value });
    }
  }

  // newSessionMessages: locale → key → string
  for (const [locale, table] of Object.entries(newSessionMessages)) {
    for (const [key, value] of Object.entries(table)) {
      out.push({ locale, key: `mobile/newSessionMessages:${key}`, value });
    }
  }

  // fullAccessConfirmation: locale → key → string。
  for (const [locale, table] of Object.entries(FULL_ACCESS_CONFIRMATION_COPY)) {
    for (const [key, value] of Object.entries(table)) {
      out.push({
        locale,
        key: `mobile/fullAccessConfirmation:${key}`,
        value,
      });
    }
  }

  return out;
}

const entries = collectEntries();

/** 标点豁免:与根门禁同源,只作用于半角标点检查(不含省略号)。 */
const isHalfWidthExempt = makeExemptChecker(glossary.punctuationExempt);

/** key → 英文源文案。条件禁用要按 key 查英文源,放进三重循环里线性扫会随 catalog 增长恶化。 */
const sourceByKey = new Map(
  entries
    .filter((e) => e.locale === glossary.sourceLocale)
    .map((e) => [e.key, e.value]),
);

describe("影子 catalog 术语一致性", () => {
  it("catalog 非空且覆盖全部支持语言（防止 import 失效后测试静默通过）", () => {
    expect(entries.length).toBeGreaterThan(0);
    const seen = new Set(entries.map((e) => e.locale));
    for (const locale of glossary.locales) {
      expect(seen.has(locale), `影子 catalog 缺 ${locale}`).toBe(true);
    }
  });

  it("不使用术语表的禁用译法", () => {
    const violations: string[] = [];
    // proposed 术语不能整个跳过:根脚本扫不到这些 TS catalog,一跳过,它们在这份语料里的
    // 命中数就从「待裁决术语现在有多少处」的统计里彻底消失——而那个数字正是裁决讨论的依据。
    // 与根门禁同一分级:decided 阻断,proposed 只提示。
    const notes: string[] = [];
    for (const term of glossary.terms) {
      const isExempt = makeExemptChecker(term.exempt);
      for (const { locale, key, value } of entries) {
        if (isExempt(key)) continue;
        for (const entry of term.forbidden?.[locale] ?? []) {
          // 条件禁用（{ text, whenEn }）依赖英文源判断，而影子 catalog 的 en 表
          // 与 zh 表是同一份对象的不同 locale 分支，这里按 key 取同名英文条目。
          const bad = typeof entry === "string" ? entry : entry.text;
          const whenEn = typeof entry === "string" ? null : entry.whenEn;
          if (!occursIn(stripNonProse(value), bad)) continue;
          if (whenEn) {
            // 复用共享匹配器:词边界与真实复数形态(Proxy → proxies)都由它统一处理。
            // 这里原先抄了一份正则,与根门禁各自演进早晚失配。
            const source = sourceByKey.get(key);
            if (!source || !sourceMentions(stripNonProse(source), whenEn))
              continue;
          }
          // 与根门禁一致:只报事实与英文源,不给替换目标。术语表是参考不是替换表——
          // 该换成什么取决于英文源与这个 key 的用途,得读了语境再定。
          const source = sourceByKey.get(key);
          const line =
            `${locale} ${key}: 「${bad}」是 ${term.en} 条目下的禁用译法` +
            `\n    译文: ${value.slice(0, 60)}` +
            (source ? `\n    英文源: ${source.slice(0, 60)}` : "");
          if (term.status === "decided") violations.push(line);
          else notes.push(line);
        }
      }
    }
    if (notes.length > 0) {
      console.warn(`[shadow-glossary] 待裁决术语命中:\n${notes.join("\n")}`);
    }
    expect(
      violations,
      `影子 catalog 命中禁用译法:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("保留英文的术语大小写形态统一", () => {
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
        // 大小写的正确目标与语境无关、唯一确定,这里给目标是帮忙不是误导(同根门禁)。
        if (!hit) continue;
        const line = `${locale} ${key}: 「${hit}」应为「${standard}」`;
        if (term.status === "decided") violations.push(line);
        else notes.push(line);
      }
    }
    if (notes.length > 0) {
      console.warn(`[shadow-glossary] 待裁决术语大小写:\n${notes.join("\n")}`);
    }
    expect(
      violations,
      `影子 catalog 大小写不统一:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("标点风格符合各语言规则", () => {
    const violations: string[] = [];
    for (const { locale, key, value } of entries) {
      const prose = normalizeForPunctuation(value);
      // 与根门禁一致:punctuationExempt 只豁免半角标点、不豁免省略号。
      // 两边不一致的话,加一条豁免会让根门禁放行、而本测试误报阻断 CI。
      if (HALFWIDTH_PUNCT_LOCALES.has(locale) && !isHalfWidthExempt(key)) {
        const mark = findHalfWidthPunct(prose);
        if (mark)
          violations.push(
            `${locale} ${key}: 中文后半角「${mark}」— ${value.slice(0, 40)}`,
          );
      }
      if (ELLIPSIS_LOCALES.has(locale) && hasAsciiEllipsis(prose)) {
        violations.push(
          `${locale} ${key}: 省略号应为「…」— ${value.slice(0, 40)}`,
        );
      }
    }
    expect(
      violations,
      `影子 catalog 标点不规范:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
