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

  it('marks a changed inline code span as a whole (regression)', () => {
    // 代码跨度是原子：标记包在整段外面（与 markdownMathRevision 的 markCodePiece
    // 同纪律），不再整行回退。
    expect(buildMarkdownRevision('See `old` here', 'See `new` here')).toBe(
      'See {--`old`--}{++`new`++} here',
    );
  });

  it('revises a bold-wrapped word change without falling back to the block (regression)', () => {
    // 实机反馈：新版给关键词加粗（`（**车辆 / 人员**）`）时，词级 diff 把 `**` 的
    // 开符 / 闭符切成独立改动片段；逐片段注入后 CommonMark 把这半对定界符配对到
    // **标记外**的文本上，开闭标记被拆进不同容器 → 校验残留 → 整段回退成
    // 「整段删除线 + 整段下划线」。区域注入把整段改动折成一对旧 / 新文本，
    // 标记内容覆盖完整结构，定界符不再落进标记内部。
    expect(
      buildMarkdownRevision(
        '目标（建筑 / 车辆 / 人物）面对威胁',
        '目标（**车辆 / 人员**）面对威胁',
      ),
    ).toBe('目标（{--建筑 / 车辆 / 人物--}{++**车辆 / 人员**++}）面对威胁');
  });

  it('keeps a formatting-only change visible as a region revision', () => {
    // 内容没改、只调整行内格式（加粗 / 去粗）：词级路径没有可标记的改动，但变化
    // 不能静默（否则预览直接展示新版格式，看不出这里动过），区域注入整体标出。
    expect(buildMarkdownRevision('见 甲乙 文档', '见 **甲乙** 文档')).toBe(
      '见 {--甲乙--}{++**甲乙**++} 文档',
    );
    expect(buildMarkdownRevision('**a** b', 'a b')).toBe('{--**a**--}{++a++} b');
  });

  it('turns a plain span into a bold span as one region', () => {
    expect(buildMarkdownRevision('a [link](u) b', 'a **link** b')).toBe(
      'a {--[link](u)--}{++**link**++} b',
    );
  });

  it('marks a whole link when only its destination changed', () => {
    // 标记落进 `](...)` 的地址里既不会被折叠，又会以字面量漏进 href（链接文字
    // 看起来没标、地址还被写坏）。区域注入对齐到完整链接跨度，整段标记。
    expect(buildMarkdownRevision('a [t](https://x/u) b', 'a [t](https://x/v) b')).toBe(
      'a {--[t](https://x/u)--}{++[t](https://x/v)++} b',
    );
    expect(buildMarkdownRevision('a ![alt](p.png) b', 'a ![alt2](p.png) b')).toBe(
      'a {--![alt](p.png)--}{++![alt2](p.png)++} b',
    );
  });

  it('keeps distant word-level changes precise when only one region needs merging', () => {
    // 区域种子只看「含行内语法字符的改动片段」：同一块里与加粗无关的远端词改动
    // 继续走词级，不会被卷进区域标记。
    expect(
      buildMarkdownRevision(
        '目标（建筑 / 车辆 / 人物）说明，尾部有一个旧词。',
        '目标（**车辆 / 人员**）说明，尾部有一个新词。',
      ),
    ).toBe(
      '目标（{--建筑 / 车辆 / 人物--}{++**车辆 / 人员**++}）说明，尾部有一个{--旧--}{++新++}词。',
    );
  });

  it('renders the region revision as ins/del around the preserved bold span', () => {
    const revision = buildMarkdownRevision(
      '目标（建筑 / 车辆 / 人物）面对威胁',
      '目标（**车辆 / 人员**）面对威胁',
    );
    expect(revision).not.toBeNull();
    const html = renderLikePreview(revision as string);
    // 删除 / 新增标记被完整消费，加粗结构照旧渲染。
    expect(html).toContain('cindy-md-diff-del');
    expect(html).toContain('cindy-md-diff-ins');
    expect(html).toContain('<strong>车辆 / 人员</strong>');
    expect(html).not.toMatch(/\{\+\+|\+\+\}|\{--|--\}/);
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
      ['目标（建筑 / 车辆 / 人物）面对威胁', '目标（**车辆 / 人员**）面对威胁'],
      ['见 甲乙 文档', '见 **甲乙** 文档'],
      ['a [t](https://x/u) b', 'a [t](https://x/v) b'],
      ['a ![alt](p.png) b', 'a ![alt2](p.png) b'],
    ];
    for (const [before, after] of cases) {
      const revision = buildMarkdownRevision(before, after);
      if (revision === null) continue;
      expect(renderLikePreview(revision)).not.toMatch(/\{\+\+|\+\+\}|\{--|--\}/);
    }
  });
});
