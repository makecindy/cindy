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

import { buildMarkdownTableRevision } from '../markdownTableRevision';

/** 与 MarkdownRenderer 打开 reviewAnnotations 时相同的渲染链。 */
function render(content: string): string {
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

const BEFORE = ['| 名称 | 取值 | 备注 |', '| --- | --- | --- |', '| 质量上限 | 30 | 与旧版一致 |', '| 学习率 | 0.01 | 固定值 |'].join('\n');

const AFTER = ['| 名称 | 取值 | 备注 |', '| --- | --- | --- |', '| 质量上限 | 40 | 与旧版一致 |', '| 学习率 | 0.01 | 固定值 |'].join('\n');

describe('buildMarkdownTableRevision — 单元格级', () => {
  it('marks only the changed cell and leaves the rest untouched', () => {
    const injected = buildMarkdownTableRevision(BEFORE, AFTER);
    expect(injected).not.toBeNull();
    expect(injected).toContain('{--30--}');
    expect(injected).toContain('{++40++}');
    expect(injected).toContain('| 学习率 | 0.01 | 固定值 |');
    expect(injected).toContain('| --- | --- | --- |');
  });

  it('revises the header row in place when its wording changes', () => {
    const before = ['| 名称 | 取值 |', '| --- | --- |', '| a | 1 |'].join('\n');
    const after = ['| 场景 | 取值 |', '| --- | --- |', '| a | 1 |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).toContain('{--名称--}');
    expect(injected).toContain('{++场景++}');
  });

  it('renders each changed cell with underline (insert) and strikethrough (delete)', () => {
    const html = render(buildMarkdownTableRevision(BEFORE, AFTER) as string);
    expect(html).toMatch(/<td><del[^>]*>30<\/del><ins[^>]*>40<\/ins><\/td>/);
    expect(html).toContain('line-through');
    expect(html).toContain('underline');
  });

  it('keeps an unchanged formula cell as-is while marking its siblings', () => {
    const before = ['| 名称 | 公式 |', '| --- | --- |', '| a | $\\frac{1}{2}$ |'].join('\n');
    const after = ['| 名称 | 公式 |', '| --- | --- |', '| b | $\\frac{1}{2}$ |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).toContain('{--a--}');
    expect(injected).toContain('{++b++}');
    // 未改动的公式格原样保留。
    expect(injected).toContain('$\\frac{1}{2}$');
    expect(injected).not.toContain('\\sout{\\frac');
  });

  it('revises text outside the math and marks the change inside it', () => {
    const before = ['| 名称 | 取值 |', '| --- | --- |', '| 上限 | $m \\le 30$ |'].join('\n');
    const after = ['| 名称 | 取值 |', '| --- | --- |', '| 阈值 | $m \\le 40$ |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    expect(injected).toContain('{--上限--}');
    expect(injected).toContain('{++阈值++}');
    // 公式格：公式级粒度 —— 旧公式删除线 + 新公式下划线，合在同一个公式里。
    expect(injected).toContain(
      '$\\textcolor{#c0ffee}{\\sout{m \\le 30}}\\textcolor{#facade}{\\underline{m \\le 40}}$',
    );
    expect(injected).not.toContain('htmlClass');
  });

  it('still marks a whole cell that contains a formula (inside the math)', () => {
    const injected = buildMarkdownTableRevision('', '| 名称 | 取值 |\n| --- | --- |\n| 上限 | $m \\le 40$ |');
    expect(injected).toContain('$\\textcolor{#facade}{\\underline{m \\le 40}}$');
    expect(injected).not.toContain('htmlClass');
    const html = render(injected as string);
    expect(html).toContain('<ins');
    expect(html).toContain('underline');
  });

  it('keeps escaped pipes inside a cell (no extra columns)', () => {
    const before = ['| 名称 | 说明 |', '| --- | --- |', '| a | 旧 \\| 新 |'].join('\n');
    const after = ['| 名称 | 说明 |', '| --- | --- |', '| a | 旧 \\| 更新 |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    // 未转义的 `|` 仍只有 3 个（两列 + 首尾分隔）：转义管道没有把格拆开。
    const dataRow = injected?.split('\n')[2] ?? '';
    expect(dataRow.match(/(?<!\\)\|/g)?.length).toBe(3);
  });

  it('puts strikethrough inside a formula cell of a removed row', () => {
    const before = [
      '| 名称 | 取值 |',
      '| --- | --- |',
      '| 上限 | $m \\le 30$ |',
      '| 下限 | 1 |',
    ].join('\n');
    const after = ['| 名称 | 取值 |', '| --- | --- |', '| 下限 | 1 |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    // 整行删除：公式格里的公式也带删除线。
    expect(injected).toContain('$\\textcolor{#c0ffee}{\\sout{m \\le 30}}$');
    expect(injected).toContain('| {--上限--} |');
  });

  it('puts underline inside a formula cell of an added row', () => {
    const before = ['| 名称 | 取值 |', '| --- | --- |', '| 下限 | 1 |'].join('\n');
    const after = [
      '| 名称 | 取值 |',
      '| --- | --- |',
      '| 下限 | 1 |',
      '| 上限 | $m \\le 40$ |',
    ].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    expect(injected).toContain('$\\textcolor{#facade}{\\underline{m \\le 40}}$');
    expect(injected).toContain('| {++上限++} |');
  });
});

describe('buildMarkdownTableRevision — 整行增删', () => {
  it('marks every cell of a removed row and keeps other rows untouched', () => {
    const before = ['| 名称 | 取值 |', '| --- | --- |', '| a | 1 |', '| b | 2 |'].join('\n');
    const after = ['| 名称 | 取值 |', '| --- | --- |', '| b | 2 |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    expect(injected).toContain('| {--a--} | {--1--} |');
    expect(injected).toContain('| b | 2 |');
    expect(injected).not.toContain('{++');
  });

  it('marks every cell of an added row', () => {
    const before = ['| 名称 | 取值 |', '| --- | --- |', '| a | 1 |'].join('\n');
    const after = ['| 名称 | 取值 |', '| --- | --- |', '| a | 1 |', '| c | 3 |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).toContain('| {++c++} | {++3++} |');
    expect(injected).toContain('| a | 1 |');
    expect(injected).not.toContain('{--');
  });

  it('renders a removed row with strikethrough in every cell and an added row with underline', () => {
    const before = ['| 名称 | 取值 |', '| --- | --- |', '| a | 1 |'].join('\n');
    const after = ['| 名称 | 取值 |', '| --- | --- |', '| b | 2 |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after) as string;
    const html = render(injected);
    // 配对行按单元格词级：旧值删除线 + 新值下划线。
    expect(html).toMatch(/<td><del[^>]*>a<\/del><ins[^>]*>b<\/ins><\/td>/);
    expect(html).toMatch(/<td><del[^>]*>1<\/del><ins[^>]*>2<\/ins><\/td>/);
  });

  it('marks the header too when the whole table is new', () => {
    const injected = buildMarkdownTableRevision('', AFTER);
    expect(injected).toContain('| {++名称++} | {++取值++} | {++备注++} |');
    expect(injected).toContain('| {++质量上限++} | {++40++} | {++与旧版一致++} |');
  });

  it('marks every row when the whole table is deleted', () => {
    const injected = buildMarkdownTableRevision(BEFORE, '');
    expect(injected).toContain('| {--名称--} | {--取值--} | {--备注--} |');
    expect(injected).toContain('| {--学习率--} | {--0.01--} | {--固定值--} |');
    const html = render(injected as string);
    expect(html).toContain('line-through');
  });
});

describe('buildMarkdownTableRevision — 回退边界', () => {
  it('returns null when the column count changes', () => {
    const after = ['| 名称 | 取值 |', '| --- | --- |', '| a | 1 |'].join('\n');
    expect(buildMarkdownTableRevision(BEFORE, after)).toBeNull();
  });

  it('returns null for non-table input', () => {
    expect(buildMarkdownTableRevision('Beta old', 'Beta new')).toBeNull();
    expect(buildMarkdownTableRevision('', 'Beta new')).toBeNull();
  });

  it('returns null when the after block is no longer a table', () => {
    expect(buildMarkdownTableRevision(BEFORE, 'Beta new')).toBeNull();
  });

  it('returns null when header and body disagree on column count', () => {
    const broken = ['| a | b |', '| --- | --- |', '| only-one |'].join('\n');
    expect(buildMarkdownTableRevision(broken, broken)).toBeNull();
  });

  it('never leaks sentinel LaTeX when a cell formula would sit next to a digit (regression)', () => {
    // 单元格 `$5和$10` 改 `$6和$10`：注入后的公式闭合 `$` 紧跟数字，渲染链的
    // remarkStrictInlineMath 会把整条公式降级回字面文本（哨兵 LaTeX 直接给用户看到）。
    // 拼装阶段拒绝这种相邻，宁可这一格不带标记也不能泄漏。
    const before = '| 名称 | 值 |\n| --- | --- |\n| 价格 | $5和$10 |\n';
    const after = '| 名称 | 值 |\n| --- | --- |\n| 价格 | $6和$10 |\n';
    const revised = buildMarkdownTableRevision(before, after);
    expect(revised ?? '').not.toMatch(/#c0ffee|#facade/i);
    if (revised !== null) {
      // 落回表格路径时至少要是干净的新内容（无字面哨兵命令）。
      expect(revised).not.toContain('\\textcolor{#');
    }
  });
});
