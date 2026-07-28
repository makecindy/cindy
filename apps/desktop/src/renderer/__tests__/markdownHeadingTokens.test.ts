/**
 * markdownHeadingTokens.test.ts
 * ---------------------------------------------------------------------------
 * Markdown 标题 / 加粗接入颜色 token 后的「字体与观感零影响」守卫。
 *
 * 为支持外部主题导入（Obsidian `--hN-color` / VSCode `markup.heading`），
 * `baseComponents` 的 h1–h6 与 strong 接上了 `--md-*-fg` token。风险是有人顺手
 * 在这些 renderer 上加字号 / 字重 / 间距，或把 h1–h3 原有的排版 class 改掉 ——
 * 那会静默改变现有全部主题下的正文观感，typecheck 与 lint 都拦不住。
 *
 * 因此这里做 source-contract 锚定（与 markdownStrikethrough.test.ts 同思路）：
 *   1. h1–h3 的排版 class 逐字冻结（只允许追加颜色 token）
 *   2. h4–h6 与 strong 只允许带颜色 class —— 不得出现任何 text-<n> / font-* /
 *      my-* / leading-* 排版类
 *
 * 与 `themes/__tests__/markdownColorTokens.test.ts`（token 默认值恒为 `inherit`、
 * 无内置主题 override）合起来即完整证明：默认主题下这些元素的渲染结果与引入
 * token 之前等价。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../components/chat/MarkdownRenderer.tsx'),
  'utf8',
);

/** 取 `<tag className="...">` 里的 class 串（baseComponents 里每个 tag 只出现一次）。 */
function classNameFor(tag: string): string {
  const match = new RegExp(`<${tag} className="([^"]*)"`).exec(SOURCE);
  if (!match) throw new Error(`no <${tag} className="..."> found in MarkdownRenderer.tsx`);
  return match[1];
}

/** 排版相关的 class（字号 / 字重 / 行高 / 外边距）。 */
const TYPOGRAPHY_CLASS = /^(text-\d|text-\[\d|font-|leading-|my-|mt-|mb-|tracking-)/;

describe('Markdown 标题 · h1–h3 排版 class 冻结', () => {
  it.each([
    ['h1', 'my-3 text-20 leading-[1.4] font-medium', '--md-h1-fg'],
    ['h2', 'my-3 text-18 leading-[1.556] font-medium', '--md-h2-fg'],
    ['h3', 'my-2 text-16 leading-[1.5] font-medium', '--md-h3-fg'],
  ])('%s 保持原排版并只追加颜色 token', (tag, typography, token) => {
    expect(classNameFor(tag)).toBe(`${typography} text-[var(${token})]`);
  });
});

describe('Markdown 标题 · h4–h6 与 strong 只带颜色', () => {
  it.each([
    ['h4', '--md-h4-fg'],
    ['h5', '--md-h5-fg'],
    ['h6', '--md-h6-fg'],
    ['strong', '--md-strong-fg'],
  ])('%s 的 class 只有颜色 token', (tag, token) => {
    expect(classNameFor(tag)).toBe(`text-[var(${token})]`);
  });

  it.each(['h4', 'h5', 'h6', 'strong'])(
    '%s 不引入任何字号 / 字重 / 行高 / 间距 class（引入前它们走原生继承）',
    (tag) => {
      const offenders = classNameFor(tag)
        .split(/\s+/)
        .filter((c) => TYPOGRAPHY_CLASS.test(c));
      expect(offenders).toEqual([]);
    },
  );
});

describe('Markdown 标题 · 颜色一律走 token,不出现硬编码色值', () => {
  it.each(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong'])(
    '%s 不出现 hex / rgb 硬编码（DESIGN.md §10 token 规则）',
    (tag) => {
      expect(classNameFor(tag)).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
    },
  );

  it('doc-mode 包装仍覆盖 h1–h6（h4–h6 现在有 base renderer 了）', () => {
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(SOURCE).toContain(`${tag}: wrapWithSourceLine('${tag}', baseComponents.${tag})`);
    }
  });
});
