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

  it('keeps a formatting-only change visible when the same block also has text edits (regression)', () => {
    // Greptile P2：同一段里既新增加粗又在别处改文字时，新增的 `**` 留作上下文会让
    // 加粗这处完全不可见（文字标记让候选过了校验）。此时把该跨度折成「旧内容删除 +
    // 新跨度新增」，格式变化就能看见。
    expect(buildMarkdownRevision('见 甲乙 文档 尾部旧', '见 **甲乙** 文档 尾部新')).toBe(
      '见 {--甲乙--}{++**甲乙**++} 文档 尾部{--旧--}{++新++}',
    );
  });

  it('handles a fine content change and a pure formatting addition in the same block (regression)', () => {
    // 同一段里两种「新增格式」跨度的写法互相独立：有内容改动的跨度留白定界符、只标内容，
    // 纯格式新增的跨度折成旧/新一对 —— 粗粒度不会拖累细粒度那一处（实机文档里两处
    // 改动的段落同时出现时踩到过）。
    expect(
      buildMarkdownRevision(
        '目标（建筑 / 车辆 / 人物）面对威胁，尾部甲乙丙。',
        '目标（**车辆 / 人员**）面对威胁，尾部**甲乙丙**。',
      ),
    ).toBe('目标（{--建筑 / --}**车辆 / 人{--物--}{++员++}**）面对威胁，尾部{--甲乙丙--}{++**甲乙丙**++}。');
  });

  it('marks only the added line of a loose list (regression)', () => {
    // 实机 `docs/progress.md`：整份进度日志是一个 **loose list**（项间有空行），列表
    // 路径按设计不接手；通用路径把标记插在行首会把 `- ` 变成普通文本（项结构消失 /
    // 变成上一项的懒续行），折叠器消费不到标记 → 校验残留 → 整块回退。
    // 现在项符号拆成原样输出的片段，标记只包住项正文。
    expect(
      buildMarkdownRevision(
        '- 2026-09-15：**批次 1**：xxx\n\n- 2026-09-16：**批次 2**：yyy\n',
        '- 2026-09-15：**批次 1**：xxx\n\n- 2026-09-16：**批次 2**：yyy\n\n- 2026-09-28：**新**：zzz（`abc`）。\n',
      ),
    ).toBe(
      '- 2026-09-15：**批次 1**：xxx\n\n- 2026-09-16：**批次 2**：yyy\n\n- {++2026-09-28：**新**：zzz（`abc`）。\n++}',
    );
    // 删除项同理：项符号留在标记外。
    expect(
      buildMarkdownRevision(
        '- 2026-09-15：**批次 1**：xxx\n\n- 2026-09-16：**批次 2**：yyy\n',
        '- 2026-09-15：**批次 1**：xxx\n',
      ),
    ).toBe('- 2026-09-15：**批次 1**：xxx\n\n- {--2026-09-16：**批次 2**：yyy\n--}');
  });

  it('revises a bold-wrapped word change without falling back to the block (regression)', () => {
    // 实机反馈：新版给关键词加粗（`（**车辆 / 人员**）`）时，词级 diff 把 `**` 的
    // 开符 / 闭符切成独立改动片段；逐片段注入后 CommonMark 把这半对定界符配对到
    // **标记外**的文本上，开闭标记被拆进不同容器 → 校验残留 → 整段回退成
    // 「整段删除线 + 整段下划线」。跨度语法感知候选把**新增的 `**` 留在标记外**，
    // 只标真正变动的文本 —— 中间没动的 `车辆 / 人` 不再被卷进标记。
    expect(
      buildMarkdownRevision(
        '目标（建筑 / 车辆 / 人物）面对威胁',
        '目标（**车辆 / 人员**）面对威胁',
      ),
    ).toBe('目标（{--建筑 / --}**车辆 / 人{--物--}{++员++}**）面对威胁');
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

  it('keeps distant structural changes in separate regions (regression)', () => {
    // Greptile P2：同一段落里两处相距较远的结构类改动（各自只拿到 `**` 的一半）不该
    // 被合成一个大区域——那会把两处之间完全没变的正文也标成修订。逐簇区域候先把它们
    // 分开；只有定界符配对跨簇时才退回合并区域（见 buildRegionRevisions）。
    expect(
      buildMarkdownRevision(
        '开头（甲 / 乙）中间一段完全不变的正文，末尾（丙 / 丁）。',
        '开头（**甲 / 乙**）中间一段完全不变的正文，末尾（**丙 / 丁**）。',
      ),
    ).toBe(
      '开头（{--甲 / 乙--}{++**甲 / 乙**++}）中间一段完全不变的正文，末尾（{--丙 / 丁--}{++**丙 / 丁**++}）。',
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
    // 结构候选只在需要的局部生效：加粗那段走跨度语法感知（只标 `建筑 / `、`物`、`员`），
    // 远端的普通词改动继续词级，不会被卷进区域标记。
    expect(
      buildMarkdownRevision(
        '目标（建筑 / 车辆 / 人物）说明，尾部有一个旧词。',
        '目标（**车辆 / 人员**）说明，尾部有一个新词。',
      ),
    ).toBe(
      '目标（{--建筑 / --}**车辆 / 人{--物--}{++员++}**）说明，尾部有一个{--旧--}{++新++}词。',
    );
  });

  it('renders the bold-wrapped revision as ins/del inside the preserved strong span', () => {
    const revision = buildMarkdownRevision(
      '目标（建筑 / 车辆 / 人物）面对威胁',
      '目标（**车辆 / 人员**）面对威胁',
    );
    expect(revision).not.toBeNull();
    const html = renderLikePreview(revision as string);
    // 删除 / 新增标记被完整消费，加粗结构照旧渲染（标记在 strong 内部，不是整段替换）。
    expect(html).toContain('cindy-md-diff-del');
    expect(html).toContain('cindy-md-diff-ins');
    expect(html).toContain('<strong>车辆 / 人<del');
    expect(html).toContain('员</ins></strong>');
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
