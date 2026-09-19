import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import type { Options as MarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';

import {
  REVIEW_REHYPE_HANDLERS,
  remarkReviewAnnotations,
} from '@/components/chat/remarkReviewAnnotations';
import { buildMarkdownPreviewPlan, MARKDOWN_PREVIEW_MAX_SEGMENTS } from '../markdownBlockDiff';

/** 与 MarkdownRenderer（打开 reviewAnnotations）相同的核心解析链。 */
function renderSegment(content: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkReviewAnnotations],
      remarkRehypeOptions: {
        handlers: REVIEW_REHYPE_HANDLERS,
      } as unknown as NonNullable<MarkdownOptions['remarkRehypeOptions']>,
      children: content,
    }),
  );
}

function kinds(plan: ReturnType<typeof buildMarkdownPreviewPlan>): string[] {
  return plan.segments.map((segment) => segment.kind);
}

describe('buildMarkdownPreviewPlan', () => {
  it('degrades to a single context segment without a baseline', () => {
    const after = '# Title\n\nBody\n';
    const plan = buildMarkdownPreviewPlan(after, null);

    expect(plan.blockAligned).toBe(false);
    expect(plan.hasChanges).toBe(false);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]).toMatchObject({ kind: 'context', content: after });
  });

  it('keeps unchanged documents as one merged context segment', () => {
    const content = '# Title\n\nFirst paragraph\n\n- item one\n- item two\n';
    const plan = buildMarkdownPreviewPlan(content, content);

    expect(plan.blockAligned).toBe(true);
    expect(plan.hasChanges).toBe(false);
    expect(plan.segments).toHaveLength(1);
    // 切片按块范围取源码，末尾空行不属于任何块，因此与原文的差异只在行尾空白。
    expect(plan.segments[0].content).toBe(content.trimEnd());
  });

  it('turns an appended paragraph into a revision segment', () => {
    const before = '# Title\n\nFirst paragraph\n';
    const after = '# Title\n\nFirst paragraph\n\nNew tail paragraph\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['context', 'revision']);
    expect(plan.segments[0].content).toBe('# Title\n\nFirst paragraph');
    expect(plan.segments[1].content).toBe('{++New tail paragraph++}');
    expect(plan.hasChanges).toBe(true);
  });

  it('falls back to block-level added when a whole new block cannot be revised', () => {
    // 新增一个标题：`{++# New heading++}` 会把块前缀卷进标记，结构校验拦住。
    const before = '# Title\n';
    const after = '# Title\n\n# New heading\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['context', 'added']);
    expect(plan.segments[1].content).toBe('# New heading');
  });

  it('pairs a replaced block into a single word-level revision segment', () => {
    const before = 'Alpha\n\nBeta old\n\nGamma\n';
    const after = 'Alpha\n\nBeta new\n\nGamma\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['context', 'revision', 'context']);
    expect(plan.segments[0].content).toBe('Alpha');
    expect(plan.segments[1].content).toBe('Beta {--old--}{++new++}');
    expect(plan.segments[2].content).toBe('Gamma');
  });

  it('keeps a deleted block visible as a revision segment at its original position', () => {
    const before = 'Alpha\n\nRemoved paragraph\n\nGamma\n';
    const after = 'Alpha\n\nGamma\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['context', 'revision', 'context']);
    expect(plan.segments[1].content).toBe('{--Removed paragraph--}');
    expect(plan.segments[0].content).toBe('Alpha');
    expect(plan.segments[2].content).toBe('Gamma');
  });

  it('revises the paired part of a one-to-many run and keeps the tail separate', () => {
    // 同一改动 run 里：列表块被修改（1:1 可词级）+ 后面新增一个引用块
    // （无法整块词级）——贪心配对后分别呈现，而不是整组退回块级。
    const before = '- item a\n- item b\n';
    const after = '- item a\n- item c\n\n> new quote\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['revision', 'added']);
    expect(plan.segments[0].content).toContain('{--b--}{++c++}');
    expect(plan.segments[1].content).toBe('> new quote');
  });

  it('marks an inline code span as a whole without falling back to the block (regression)', () => {
    // 代码跨度是原子：标记包在整段外面（`{--`old`--}{++`new`++}`），不再整行回退。
    const before = 'Run `old` now\n';
    const after = 'Run `new` now\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['revision']);
    expect(plan.segments[0].content).toContain('{--`old`--}{++`new`++}');
  });

  it('falls back to block-level removed/added when a pair cannot be revised', () => {
    // 源码里已经含 CriticMarkup 定界符（字面 `{--旧--}`）：再插标记会让折叠器错乱，
    // 这种情况仍回退整块装饰。
    const before = '{--旧--} 字面标记\n';
    const after = '{--新--} 字面标记\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['removed', 'added']);
  });

  it('keeps segment keys unique across removed and added anchors', () => {
    // 纯删除块用 before 行号、新增/配对块用 after 行号，两套计数器独立时旧
    // key 方案会撞重复；key 现在用全局段序号。
    const before = 'P one\n\nQ two\n\nA three\n';
    const after = 'A three\n\nS four\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    const keys = plan.segments.map((segment) => segment.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.segments.filter((segment) => segment.kind === 'revision')).toHaveLength(3);
  });

  it('treats whitespace-only block edits as unchanged', () => {
    const before = 'Alpha   \n\nBeta\n';
    const after = 'Alpha\n\nBeta\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(plan.hasChanges).toBe(false);
    expect(plan.segments).toHaveLength(1);
  });

  it('appends link reference definitions to every segment so references survive slicing', () => {
    const before = 'See [docs][ref].\n\n[ref]: https://example.com\n';
    const after = 'See [docs][ref] and more.\n\n[ref]: https://example.com\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(plan.blockAligned).toBe(true);
    const changed = plan.segments.filter((segment) => segment.kind !== 'context');
    expect(changed.length).toBeGreaterThan(0);
    for (const segment of plan.segments) {
      expect(segment.content).toContain('[ref]: https://example.com');
    }
  });

  it('keeps every segment self-contained enough to render on its own', () => {
    const before =
      '# Title\n\nOld paragraph\n\n- item a\n- item b\n\n```ts\nconst before = 1;\n```\n';
    const after =
      '# Title\n\nNew paragraph\n\n- item a\n- item b\n\n```ts\nconst after = 1;\n```\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(plan.blockAligned).toBe(true);
    const html = plan.segments.map((segment) => renderSegment(segment.content)).join('');
    // 分片后每段单独渲染仍保持块结构（标题 / 列表 / 代码块不因切片丢几何）；
    // 改动段落走词级修订，只有被改的词分别带 <del> / <ins> 标记。
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>item a</li>');
    expect(html).toContain('<li>item b</li>');
    expect(html).toMatch(/<del[^>]*>Old<\/del><ins[^>]*>New<\/ins> paragraph/);
    expect(html).toContain('const before = 1;');
    expect(html).toContain('const after = 1;');
  });

  it('degrades when the document uses footnote definitions', () => {
    const after = 'Text[^1]\n\n[^1]: note\n';
    const before = 'Text without note\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(plan.blockAligned).toBe(false);
    expect(plan.segments).toHaveLength(1);
  });

  it('degrades instead of exploding into unbounded segments', () => {
    const pairs = MARKDOWN_PREVIEW_MAX_SEGMENTS / 2 + 5;
    const before = Array.from(
      { length: pairs },
      (_, index) => `old ${index}\n\nshared ${index}`,
    ).join('\n\n');
    const after = Array.from(
      { length: pairs },
      (_, index) => `new ${index}\n\nshared ${index}`,
    ).join('\n\n');
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(plan.blockAligned).toBe(false);
    expect(plan.hasChanges).toBe(false);
    expect(plan.segments).toHaveLength(1);
  });

  it('keeps task-list checkboxes intact even when the item has inline code (regression)', () => {
    // 原子路径在 tryRevisionSegment 里先于通用路径尝试；两条路径都必须带任务守卫，
    // 否则 `- [x]` 会被标成 `- [{--x--} ]`，remark-gfm 不再认任务项 → 复选框消失。
    const before = '- [x] update `config.json`\n';
    const after = '- [ ] update `config.json`\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['removed', 'added']);
    for (const segment of plan.segments) {
      expect(segment.content).not.toContain('[{--');
    }
  });

  it('falls back when the source literally contains CriticMarkup delimiters (regression)', () => {
    // 作者原文里字面的 `{--x--}`：会被修订折叠器一并消费，于是同一份预览里含改动的块
    // 把它渲染成删除线、未改动块却按字面量渲染；保守回退整块，两版表现一致。
    const before = 'keep {--x--} plus OLD tail\n';
    const after = 'keep {--x--} plus NEW tail\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['removed', 'added']);
  });

  it('keeps unpaired removed blocks inside their own gap (order lock)', () => {
    // 两个未配对删除块夹一个配对段落（两个不同 gap）：插值 key 必须保序，
    // 不能因跨 gap 撞车退化成其他顺序。
    const before = '---\n\n段落旧内容。\n\n***\n';
    const after = '段落新内容。\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(kinds(plan)).toEqual(['removed', 'revision', 'removed']);
    expect(plan.segments[0].content.trim()).toBe('---');
    expect(plan.segments[1].content).toContain('段落');
    expect(plan.segments[2].content.trim()).toBe('***');
  });

  it('orders revision segments by the new document order when blocks moved (regression)', () => {
    // 交叉类型 2×2：配对按类型找对了，但早期实现按 removed 侧顺序输出，块在新版里
    // 上移 / 下移时修订内容会落在新文档里不属于它的位置（实机目检过）。
    const before = '段落一旧内容。\n\n## 旧标题\n\n段落二旧内容。\n';
    const after = '## 新标题\n\n段落一新内容。\n\n段落二新内容。\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(plan.segments.map((segment) => segment.kind)).toEqual([
      'revision',
      'revision',
      'revision',
    ]);
    // 新文档顺序是 标题 → 段落一 → 段落二，分段必须跟它一致。
    expect(plan.segments[0].content).toContain('## ');
    expect(plan.segments[1].content).toContain('段落一');
    expect(plan.segments[2].content).toContain('段落二');
  });

  it('keeps a deleted block at its deletion point in the new document order (regression)', () => {
    const before = '## 会被删的标题\n\n段落一旧内容。\n\n段落二旧内容。\n';
    const after = '段落一新内容。\n\n段落二新内容。\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    expect(plan.segments.map((segment) => segment.kind)).toEqual([
      'removed',
      'revision',
      'revision',
    ]);
    expect(plan.segments[0].content).toContain('会被删的标题');
  });

  it('pairs blocks by type so a deleted heading cannot shift later pairs (regression)', () => {
    // 实际踩过：removed/added 数量不等（两侧都有改动、中间还删了一个标题）时，位置式配对
    // 从删除点起整体错位 —— 表格被配到后面的段落上，词级 diff 产出跳块乱标记与重复内容。
    const before = [
      '## 旧标题',
      '### 会被删掉的标题',
      '| 场景 | 取值 |',
      '| --- | --- |',
      '| 质量上限 | 30 |',
      '| 待删除行 | 1 |',
      '',
      '行内公式：约束为 $m \\le 30$ 且 $\\alpha = 0.05$。',
    ].join('\n');
    const after = [
      '## 新标题',
      '| 场景 | 取值 |',
      '| --- | --- |',
      '| 质量上限 | 40 |',
      '| 新增行 | 2 |',
      '',
      '行内公式：约束为 $m \\le 40$ 且 $\\alpha = 0.05$。',
    ].join('\n');
    const plan = buildMarkdownPreviewPlan(after, before);

    // 表格与段落必须各自成段：绝不能出现在同一个修改段里。
    for (const segment of plan.segments) {
      const mixesTableAndParagraph =
        segment.content.includes('| 场景 | 取值 |') && segment.content.includes('行内公式：约束为');
      expect(mixesTableAndParagraph, `${segment.kind} 段把表格和段落配到了一起`).toBe(false);
    }
    const contents = plan.segments.map((segment) => segment.content);
    // 表格仍然逐格词级（单元格里的 30 → 40）。
    expect(contents.some((text) => text.includes('{--30--}{++40++}'))).toBe(true);
    // 段落仍然走公式级标记。
    expect(contents.some((text) => text.includes('\\textcolor{currentColor}'))).toBe(true);
  });

  it('appends the before-side definitions to removed segments (regression)', () => {
    // 删除段的内容来自 before，配上 after 侧的定义就会把旧段落里的 `[text][ref]` 指到
    // 新地址（定义被删时还会退化成字面文本），删除内容就不再忠实呈现基线版本。
    const before = [
      '旧段落见 [docs][ref]。',
      '',
      '保留段落。',
      '',
      '[ref]: https://old.example.com',
    ].join('\n');
    const after = [
      '保留段落。',
      '',
      '[ref]: https://new.example.com',
    ].join('\n');
    const plan = buildMarkdownPreviewPlan(after, before);

    // 旧段落可能以 removed 段或整块删除的 revision 段出现（内容都是 before 侧），
    // 两种情形都必须只看到旧定义。
    const oldSegments = plan.segments.filter((segment) => segment.content.includes('旧段落'));
    expect(oldSegments.length).toBeGreaterThan(0);
    expect(oldSegments.every((segment) => segment.content.includes('old.example.com'))).toBe(true);
    expect(oldSegments.every((segment) => !segment.content.includes('new.example.com'))).toBe(true);
    // 新增 / 未改动侧反过来：只带新定义。
    const keptSegments = plan.segments.filter((segment) => segment.content.includes('保留段落'));
    expect(keptSegments.length).toBeGreaterThan(0);
    expect(keptSegments.every((segment) => segment.content.includes('new.example.com'))).toBe(true);
    expect(keptSegments.every((segment) => !segment.content.includes('old.example.com'))).toBe(true);
  });

  it('keeps removed content readable when the definition was deleted (regression)', () => {
    // 定义在新版里被整体删除：删除段必须仍然带上 before 侧定义，
    // 否则旧段落里的 `[text][ref]` 会退化成字面文本。
    const before = [
      '旧段落见 [docs][ref]。',
      '',
      '保留段落。',
      '',
      '[ref]: https://old.example.com',
    ].join('\n');
    const after = ['保留段落。', ''].join('\n');
    const plan = buildMarkdownPreviewPlan(after, before);

    const oldSegments = plan.segments.filter((segment) => segment.content.includes('旧段落'));
    expect(oldSegments.length).toBeGreaterThan(0);
    expect(oldSegments.every((segment) => segment.content.includes('[ref]: https://old.example.com'))).toBe(
      true,
    );
  });

  it('assigns whole-document heading ids across segments (regression)', () => {
    // 重复标题被改动拆到不同片段：每段各跑一次 rehype-slug（每次 `slugs.reset()`），
    // 两个本该是 `用法` / `用法-1` 的标题会被都写成 `用法`——非法 HTML，页内链只能命中第一个。
    const before = ['## 用法', '', '旧内容 A', '', '## 用法', '', '旧内容 B'].join('\n');
    const after = ['## 用法', '', '新内容 A', '', '## 用法', '', '新内容 B'].join('\n');
    const plan = buildMarkdownPreviewPlan(after, before);

    // id 按**全篇**顺序分配，且不重复。
    const ids = plan.segments.flatMap((segment) => segment.headingIds);
    expect(ids).toEqual(['用法', '用法-1']);
    expect(new Set(ids).size).toBe(ids.length);
    // 页内链接重写表：作者写的原始 slug 与已定稿 id 都能落到正确标题。
    expect(plan.anchorIds['用法']).toBe('用法');
    expect(plan.anchorIds['用法-1']).toBe('用法-1');
  });

  it('flags only injected math nodes so an author formula of the same shape stays alone (regression)', () => {
    // 作者可以写出与注入**完全同形**的公式（关键字颜色 + 画线命令）—— 形态永远分不出谁写的。
    // 计划阶段按“注入后 vs 原文”的公式集合比对判定来源：未改动的作者公式必须为 false。
    const before = '作者公式 $\\textcolor{currentColor}{\\sout{k}}$ 与旧值 $m \\le 30$';
    const after = '作者公式 $\\textcolor{currentColor}{\\sout{k}}$ 与旧值 $m \\le 40$';
    const plan = buildMarkdownPreviewPlan(after, before);

    const revision = plan.segments.find((segment) => segment.kind === 'revision');
    // 第一个（作者未改动的同形公式）false，第二个（真正注入的修订公式）true。
    expect(revision?.mathMarks).toEqual([false, true]);
  });

  it('never lends after-side heading ids to removed segments', () => {
    // 删除段的内容来自 before，那些标题不在新版里，不能占用 after 侧 id。
    const before = ['## 旧标题', '', '旧段落内容。', '', '## 保留标题', ''].join('\n');
    const after = ['## 保留标题', ''].join('\n');
    const plan = buildMarkdownPreviewPlan(after, before);

    const oldHeadingSegment = plan.segments.find((segment) => segment.content.includes('旧标题'));
    expect(oldHeadingSegment).toBeDefined();
    expect(oldHeadingSegment?.headingIds).toEqual([]);
    // after 侧唯一标题拿到未去重的 id（列表里只有它一个）。
    expect(plan.segments.flatMap((segment) => segment.headingIds)).toEqual(['保留标题']);
  });
});
