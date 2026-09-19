import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import type { Options as MarkdownOptions } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { describe, expect, it } from 'vitest';

import { normalizeMathDelimiters } from '@cindy/maker-shared/math-markdown';
import { MARKDOWN_REMARK_PLUGINS } from '@/components/chat/markdownPluginPipeline';
import {
  REVIEW_REHYPE_HANDLERS,
  remarkReviewAnnotations,
} from '@/components/chat/remarkReviewAnnotations';

import { buildMarkdownRevision, REVISION_MAX_SOURCE_CHARS } from '../markdownRevision';

/** 镜像审查预览的渲染链（含 remarkMath + KaTeX），用于契约断言。 */
function renderLikePreview(content: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [...MARKDOWN_REMARK_PLUGINS, remarkReviewAnnotations],
      remarkRehypeOptions: {
        handlers: REVIEW_REHYPE_HANDLERS,
      } as unknown as NonNullable<MarkdownOptions['remarkRehypeOptions']>,
      rehypePlugins: [[rehypeKatex, { strict: 'ignore', errorColor: 'inherit' }]],
      children: normalizeMathDelimiters(content, { preserveLineCount: false }),
    }),
  );
}

describe('buildMarkdownRevision', () => {
  it('injects paired insert/delete marks for a word-level edit', () => {
    const revision = buildMarkdownRevision('Beta old', 'Beta new');

    expect(revision).toBe('Beta {--old--}{++new++}');
  });

  it('wraps a whole newly added paragraph as an insert', () => {
    expect(buildMarkdownRevision('', 'New paragraph')).toBe('{++New paragraph++}');
  });

  it('wraps a whole deleted paragraph as a delete', () => {
    expect(buildMarkdownRevision('Old paragraph', '')).toBe('{--Old paragraph--}');
  });

  it('keeps the block prefix outside the marks for a heading edit', () => {
    expect(buildMarkdownRevision('# Title A', '# Title B')).toBe('# Title {--A--}{++B++}');
  });

  it('falls back when a task-list marker changes', () => {
    // 勾选态变化不能词级：标记会插进方括号里，任务列表语法被拆坏。
    expect(buildMarkdownRevision('- [ ] 待办三', '- [x] 待办三')).toBeNull();
    // 大小写写法变化（`[x]` ↔ `[X]`）也是勾选标记变化，同样按原始字符拦住。
    expect(buildMarkdownRevision('- [x] 待办三', '- [X] 待办三')).toBeNull();
    // 原文里字面的 CriticMarkup 定界符：会被折叠器一并消费（同一文档两种表现）→ 整块回退。
    expect(buildMarkdownRevision('keep {--x--} plus OLD', 'keep {--x--} plus NEW')).toBeNull();
    expect(buildMarkdownRevision('- [ ] 甲\n- [x] 乙', '- [x] 甲\n- [x] 乙')).toBeNull();
    // 数量变化（新增 / 删除任务项）同样回退。
    expect(buildMarkdownRevision('- [ ] 甲', '- [ ] 甲\n- [ ] 乙')).toBeNull();
  });

  it('still revises the text of a task item whose checkbox does not change', () => {
    const revised = buildMarkdownRevision('- [ ] 待办（旧）', '- [ ] 待办（新）');
    expect(revised).not.toBeNull();
    expect(revised).toContain('{--旧--}');
    expect(revised).toContain('{++新++}');
  });

  it('falls back when the change spans an inline element', () => {
    expect(buildMarkdownRevision('See `old` here', 'See `new` here')).toBeNull();
  });

  it('falls back when the edit sits inside a math span', () => {
    // `${--A1--}{++A3++}$` 在渲染链（remarkMath）里会被吃成 inlineMath，标记
    // 永远不被消费 —— KaTeX 会把标记当公式渲染。校验链必须与渲染同源才能拦住。
    expect(
      buildMarkdownRevision('cost is $A1$ and $B2$ here', 'cost is $A3$ and $B2$ here'),
    ).toBeNull();
  });

  it('keeps unchanged braces outside the marks', () => {
    // 花括号在未改文本里不影响标记消费：渲染后阅读为 a {x y} b（x 删除、y 新增）。
    expect(buildMarkdownRevision('a {x} b', 'a {y} b')).toBe('a {{--x--}{++y++}} b');
  });

  it('falls back when a changed fragment itself contains braces', () => {
    // `{` 与 `}` 由 diff 切成独立片段时，任一改动片段带花括号就无法安全包裹。
    expect(buildMarkdownRevision('keep x', 'keep {x}')).toBeNull();
  });

  it('falls back for a whole rewrite', () => {
    expect(buildMarkdownRevision('aaaa bbbb cccc', 'xxxx yyyy zzzz')).toBeNull();
  });

  it('falls back when a whole new block prefix would be swallowed by the marks', () => {
    // `{++# New heading++}` 解析成 paragraph，与 heading 结构不一致。
    expect(buildMarkdownRevision('', '# New heading')).toBeNull();
  });

  it('falls back for oversized sources', () => {
    const big = 'x'.repeat(REVISION_MAX_SOURCE_CHARS + 1);
    expect(buildMarkdownRevision(big, `${big}y`)).toBeNull();
  });

  it('falls back when the injected mark would span two block-level nodes', () => {
    // 注入片段含空行 → 标记跨两个段落。保留文本占比很高（> REVISION_MIN_UNCHANGED_RATIO），
    // 能回退的唯一原因是插件在块级容器上不折叠（<ins> 里塞 <p> 会破坏结构）、
    // 标记残留 → 校验失败。
    const body = 'keep one two three four five six seven eight nine';
    expect(buildMarkdownRevision(`${body}\n\nold`, `${body}\n\nnew\n\nmore`)).toBeNull();
  });

  it('is stable across repeated runs on the same input', () => {
    // 校验链复用模块级 unified processor（parse + runSync 跑完整 transformer
    // 链）：任何上游插件引入隐藏状态，都会让第二次调用与第一次不一致。
    const first = buildMarkdownRevision('Beta old', 'Beta new');
    expect(first).not.toBeNull();
    expect(buildMarkdownRevision('Beta old', 'Beta new')).toBe(first);
    expect(buildMarkdownRevision('Beta old', 'Beta new')).toBe(first);
  });

  it('returns null without any real change', () => {
    expect(buildMarkdownRevision('same', 'same')).toBeNull();
    expect(buildMarkdownRevision('', '')).toBeNull();
  });

  it('never leaks literal marks into the render pipeline', () => {
    // 契约：buildMarkdownRevision 返回非 null 时，按**渲染链**重渲染不允许出现
    // 字面标记。校验链漂移（少插件 / 少归一化）会在这里当场报警。
    const cases: Array<[string, string]> = [
      ['Beta old', 'Beta new'],
      ['cost is $A1$ and $B2$ here', 'cost is $A3$ and $B2$ here'],
      ['# Title A', '# Title B'],
      ['See `old` here', 'See `new` here'],
      ['a {x} b', 'a {y} b'],
      ['- item a\n- item b', '- item a\n- item c'],
    ];
    for (const [before, after] of cases) {
      const revision = buildMarkdownRevision(before, after);
      if (revision === null) continue;
      expect(renderLikePreview(revision)).not.toMatch(/\{\+\+|\+\+\}|\{--|--\}/);
    }
  });
});
