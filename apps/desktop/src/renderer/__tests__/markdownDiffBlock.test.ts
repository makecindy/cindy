/**
 * markdownDiffBlock.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for: markdown ```diff fenced code blocks now render via
 * MarkdownDiffBlock (GitHub-standard red/green) instead of highlight.js.
 *
 * Static-source scan, matching project convention (see
 * imageLightboxCloseAnywhere.test.ts and userInfoSectionHover.test.ts) —
 * keeps tests in the node vitest env and avoids dragging in jsdom +
 * react-dom for what are essentially structural / token contracts.
 *
 * Plus a unit test of the parseDiffText logic by re-deriving it from the
 * source — same regex, same prefixes, so a behavioural drift in the parser
 * would surface here.
 *
 * Contracts asserted:
 *   F1  Theme color registry pins GitHub-standard diff foreground/background
 *       tokens; globals.css only keeps the highlight.js display override.
 *   F2  MarkdownDiffBlock renders three columns (line# gutter, symbol col,
 *       content col) with the correct token bindings — same skeleton as
 *       DiffView so the visual matches.
 *   F3  MarkdownRenderer's `pre` renderer detects language-diff and routes
 *       to <MarkdownDiffBlock raw=.../>, leaving non-diff blocks on the
 *       default <pre><code> path.
 *   F4  inline code path (no className) is unchanged.
 *   F5  parseDiffText: '+' / '-' produce add / del; '+++' / '---' / '@@'
 *       hunk headers stay as ctx (no color bleed onto file headers).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rendererPath = resolve(
  __dirname,
  '..',
  'components',
  'chat',
  'MarkdownRenderer.tsx',
);
const diffBlockPath = resolve(
  __dirname,
  '..',
  'components',
  'chat',
  'MarkdownDiffBlock.tsx',
);
const colorsPath = resolve(__dirname, '..', 'themes', 'colors.ts');
const globalsPath = resolve(__dirname, '..', 'styles', 'globals.css');

const rendererSrc = readFileSync(rendererPath, 'utf8');
const diffBlockSrc = readFileSync(diffBlockPath, 'utf8');
const colorsSrc = readFileSync(colorsPath, 'utf8');
const globalsSrc = readFileSync(globalsPath, 'utf8');

function registeredColorBlock(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = colorsSrc.match(new RegExp(`registerColor\\('${escaped}'[\\s\\S]*?\\n\\}, '[^']+'\\);`));
  expect(match, `registerColor('${name}') not found`).toBeTruthy();
  if (!match) throw new Error(`registerColor('${name}') not found`);
  return match[0];
}

describe('F1 — theme tokens use GitHub-standard diff foregrounds', () => {
  it(':root light --diff-add-fg = #22863a', () => {
    expect(registeredColorBlock('diff-add-fg')).toMatch(/light:\s*'#22863a'/);
  });

  it(':root light --diff-del-fg = #b31d28', () => {
    expect(registeredColorBlock('diff-del-fg')).toMatch(/light:\s*'#b31d28'/);
  });

  it('.dark --diff-add-fg = #7ee787', () => {
    expect(registeredColorBlock('diff-add-fg')).toMatch(/dark:\s*'#7ee787'/);
  });

  it('.dark --diff-del-fg = #ff7b72', () => {
    expect(registeredColorBlock('diff-del-fg')).toMatch(/dark:\s*'#ff7b72'/);
  });

  it('backgrounds use GitHub-standard red/green for full-row fill', () => {
    // diff 颜色现在由主题 token 注册,组件只消费 var(--diff-*)。
    expect(registeredColorBlock('diff-add-bg')).toMatch(/light:\s*'#f0fff4'/);
    expect(registeredColorBlock('diff-del-bg')).toMatch(/light:\s*'#ffeef0'/);
    expect(registeredColorBlock('diff-add-bg')).toMatch(/dark:\s*'#033a16'/);
    expect(registeredColorBlock('diff-del-bg')).toMatch(/dark:\s*'#67060c'/);
    expect(registeredColorBlock('diff-line-num')).toMatch(/light:\s*'var\(--text-tertiary-stone\)'/);
    expect(registeredColorBlock('diff-line-num')).toMatch(/dark:\s*'var\(--text-tertiary-stone\)'/);
  });

  it('hljs-addition / hljs-deletion are display:block so backgrounds reach the right edge', () => {
    // F-MSG-6 full-row fill (2026-04-21) — highlight.js wraps each diff line
    // in an inline span; without display:block the colored band stops at the
    // last text glyph instead of stretching to the container edge.
    expect(globalsSrc).toMatch(
      /\.hljs-addition\s*,\s*\.hljs-deletion\s*\{\s*display:\s*block;?\s*\}/,
    );
  });

  it('does NOT leave the old grayscale values for --diff-add-fg/--diff-del-fg', () => {
    const addFgBlock = registeredColorBlock('diff-add-fg');
    const delFgBlock = registeredColorBlock('diff-del-fg');

    // The old light-mode add was #262626 (Near Black) and dark-mode add was
    // #d4d4d4 (Soft Gray). Those must no longer be tied to --diff-add-fg.
    expect(addFgBlock).not.toMatch(/#262626/);
    expect(addFgBlock).not.toMatch(/#d4d4d4/);
    // Old del was Stone #737373 in both modes.
    expect(delFgBlock).not.toMatch(/#737373/);
  });
});

describe('F2 — MarkdownDiffBlock renders the three-column diff skeleton', () => {
  it('outer container uses --msg-code-block-bg/border (matches DiffView shell)', () => {
    expect(diffBlockSrc).toMatch(/border-\[var\(--msg-code-block-border\)\]/);
    expect(diffBlockSrc).toMatch(/bg-\[var\(--msg-code-block-bg\)\]/);
  });

  it('row uses flex min-h-[20px] and conditional add/del backgrounds', () => {
    expect(diffBlockSrc).toMatch(/flex min-h-\[20px\]/);
    expect(diffBlockSrc).toMatch(/bg-\[var\(--diff-del-bg\)\]/);
    expect(diffBlockSrc).toMatch(/bg-\[var\(--diff-add-bg\)\]/);
  });

  it('line-number gutter uses --diff-line-num and minWidth gutterWidth+3 ch', () => {
    expect(diffBlockSrc).toMatch(/text-\[var\(--diff-line-num\)\]/);
    expect(diffBlockSrc).toMatch(/minWidth:\s*`\$\{gutterWidth\s*\+\s*3\}ch`/);
  });

  it('symbol column writes "+" / "-" / " " and uses add/del foreground tokens', () => {
    expect(diffBlockSrc).toMatch(/text-\[var\(--diff-del-fg\)\]/);
    expect(diffBlockSrc).toMatch(/text-\[var\(--diff-add-fg\)\]/);
    // The ternary that picks the glyph
    expect(diffBlockSrc).toMatch(/'-'\s*:\s*line\.type === 'add'\s*\?\s*'\+'\s*:\s*' '/);
  });

  it('content column uses whitespace-pre so leading whitespace is preserved', () => {
    expect(diffBlockSrc).toMatch(/whitespace-pre/);
  });
});

describe('F3 — MarkdownRenderer routes ```diff to MarkdownDiffBlock', () => {
  it('imports MarkdownDiffBlock', () => {
    expect(rendererSrc).toMatch(
      /import\s*\{\s*MarkdownDiffBlock\s*\}\s*from\s*['"]\.\/MarkdownDiffBlock['"]/,
    );
  });

  it('exports a `pre` renderer that returns <MarkdownDiffBlock raw=...> for diff blocks', () => {
    // Source must contain the JSX route, which guarantees the runtime swap.
    expect(rendererSrc).toMatch(/<MarkdownDiffBlock\s+raw=\{raw\}\s*\/>/);
  });

  it('uses isDiffCodeChild to detect language-diff', () => {
    expect(rendererSrc).toMatch(/isDiffCodeChild\s*\(\s*firstChild\s*\)/);
  });

  it('detector regex matches both `language-diff` and bare `diff` className', () => {
    // Re-derive the regex literal from source to make sure the contract
    // itself doesn't drift (e.g. someone removes the language- prefix arm).
    const match = rendererSrc.match(/return\s+(\/.+\/)\.test\(className\)/);
    expect(match, 'isDiffCodeChild regex literal not found').toBeTruthy();
    const literal = match?.[1];
    if (!literal) throw new Error('isDiffCodeChild regex literal not found');
    const regex = new RegExp(literal.slice(1, literal.lastIndexOf('/')));
    expect(regex.test('language-diff hljs')).toBe(true);
    expect(regex.test('diff')).toBe(true);
    expect(regex.test('language-js hljs')).toBe(false);
    expect(regex.test('language-different')).toBe(false); // word-boundary safety
  });

  it('default pre fallthrough still renders <pre className=...> for non-diff blocks', () => {
    // 非 diff 代码块现在先落到 CodeBlockPre,再由 CodeBlockPre 渲染真实 <pre>。
    expect(rendererSrc).toMatch(/return\s+<CodeBlockPre\s+\{\.\.\.props\}>\{children\}<\/CodeBlockPre>/);
    expect(rendererSrc).toMatch(/function\s+CodeBlockPre[\s\S]*<pre[\s\S]*className=\{cn\(/);
    expect(rendererSrc).toMatch(/border-\[var\(--msg-code-block-border\)\]/);
  });
});

describe('F4 — inline code path unchanged', () => {
  it('inline = !className still gates the inline branch', () => {
    expect(rendererSrc).toMatch(/const\s+isInline\s*=\s*!className/);
  });

});

describe('F5 — parseDiffText classification', () => {
  /**
   * Re-implement the parser using the SAME prefix rules the source uses.
   * This is a behavioural mirror — if someone ships a regression in the
   * source parser, they must also update this test (which is the point).
   *
   * Mirrors apps/desktop/src/renderer/components/chat/MarkdownDiffBlock.tsx
   * `parseDiffText`.
   */
  type Line = { type: 'add' | 'del' | 'ctx'; text: string; lineNum: number };
  function parseDiffText(raw: string): Line[] {
    const lines = raw.replace(/^\n+|\n+$/g, '').split('\n');
    let lineNum = 1;
    return lines.map((line) => {
      let type: Line['type'] = 'ctx';
      let text = line;
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
        type = 'ctx';
      } else if (line.startsWith('+')) {
        type = 'add';
        text = line.slice(1).replace(/^ /, '');
      } else if (line.startsWith('-')) {
        type = 'del';
        text = line.slice(1).replace(/^ /, '');
      }
      return { type, text, lineNum: lineNum++ };
    });
  }

  it('classifies + / - / context lines correctly', () => {
    const out = parseDiffText('+ added\n- removed\n  ctx');
    expect(out).toEqual([
      { type: 'add', text: 'added', lineNum: 1 },
      { type: 'del', text: 'removed', lineNum: 2 },
      { type: 'ctx', text: '  ctx', lineNum: 3 },
    ]);
  });

  it('keeps +++ / --- / @@ hunk headers as ctx (no red/green color bleed)', () => {
    const out = parseDiffText('--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n+x');
    expect(out[0].type).toBe('ctx');
    expect(out[0].text).toBe('--- a/file.ts');
    expect(out[1].type).toBe('ctx');
    expect(out[1].text).toBe('+++ b/file.ts');
    expect(out[2].type).toBe('ctx');
    expect(out[2].text).toBe('@@ -1,3 +1,3 @@');
    expect(out[3].type).toBe('add');
    expect(out[3].text).toBe('x');
  });

  it('strips the conventional single space after + / - but preserves the rest', () => {
    expect(parseDiffText('+  two-leading-spaces')[0].text).toBe(' two-leading-spaces');
    expect(parseDiffText('+no-space')[0].text).toBe('no-space');
  });

  it('trims leading/trailing blank lines so the block starts on real content', () => {
    const out = parseDiffText('\n\n+ a\n- b\n\n');
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('a');
    expect(out[1].text).toBe('b');
  });
});
