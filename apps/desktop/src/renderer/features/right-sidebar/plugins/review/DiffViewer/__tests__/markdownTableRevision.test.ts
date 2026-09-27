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
  /** 按 GFM 的奇偶规则数一行表格的列数（独立实现，用于交叉验证）。 */
  function countRowCells(line: string): number {
    const trimmed = line.trim();
    const withoutLeading = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
    const body = withoutLeading.endsWith('|') ? withoutLeading.slice(0, -1) : withoutLeading;
    let cells = 1;
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] !== '|') continue;
      let backslashes = 0;
      for (let scan = index - 1; scan >= 0 && body[scan] === '\\'; scan -= 1) backslashes += 1;
      if (backslashes % 2 === 0) cells += 1;
    }
    return cells;
  }
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

  it('revises a cell whose change adds bold around changed words (regression)', () => {
    // 实机案例（FR 任务表）：`（建筑/车辆/人物，**无 HP**）` → `（**车辆/人员**，**无 HP**）`。
    // 改动只拿到 `**` 的一半，逐片段注入会被 CommonMark 拆坏；单元格级先过局部校验，
    // 失败后走通用两段式（区域注入），不再把整张表拖回块级装饰。
    const before = ['| 编号 | 需求 |', '| --- | --- |', '| FR-002 | （建筑/车辆/人物，**无 HP**）保留 |'].join(
      '\n',
    );
    const after = ['| 编号 | 需求 |', '| --- | --- |', '| FR-002 | （**车辆/人员**，**无 HP**）保留 |'].join(
      '\n',
    );
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    // 加粗新增的 `**` 留在标记外，只标真正变动的文本（中间 `车辆/人` 不动）。
    expect(injected).toContain('（{--建筑/--}**车辆/人{--物--}{++员++}**，**无 HP**）保留');
    // 未改动的行保持原样，且渲染后无字面标记残留。
    const html = render(injected as string);
    expect(html).toContain('cindy-md-diff-del');
    expect(html).toContain('cindy-md-diff-ins');
    expect(html).not.toMatch(/\{\+\+|\+\+\}|\{--|--\}/);
  });

  it('revises a cell that drops GFM strikethrough from every row (regression)', () => {
    // 实机案例（待确认表）：整表把 `~~Q1~~` 的删除线去掉。`~~` 半对定界符跨标记配对同样
    // 会留下残留；区域注入把整段折成一对旧 / 新文本。
    const before = ['| 编号 | 问题 |', '| --- | --- |', '| ~~Q1~~ | ~~v1 联机范围~~ |'].join('\n');
    const after = ['| 编号 | 问题 |', '| --- | --- |', '| Q1 | v1 联机范围 |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    expect(injected).toContain('{--~~Q1~~--}{++Q1++}');
    expect(injected).toContain('{--~~v1 联机范围~~--}{++v1 联机范围++}');
    const html = render(injected as string);
    expect(html).not.toMatch(/\{\+\+|\+\+\}|\{--|--\}/);
  });

  it('falls back to a whole-cell replace when the cell cannot be word-revised', () => {
    // 两段式也失败时整格替换：旧格删除线 + 新格下划线（不再把新版原文当未改动）。
    const before = ['| 名称 | 说明 |', '| --- | --- |', '| a | 旧文案 |'].join('\n');
    const after = ['| 名称 | 说明 |', '| --- | --- |', '| a | {新文案} |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    const dataRow = injected?.split('\n')[2] ?? '';
    // 花括号吃不下标记：这一格保持新版本原文（旧行为），但表格本身仍走逐格修订。
    expect(dataRow).toContain('{新文案}');
    expect(dataRow).not.toContain('{--旧文案--}');
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
      '$\\textcolor{currentColor}{\\sout{m \\le 30}}\\textcolor{inherit}{\\underline{m \\le 40}}$',
    );
    expect(injected).not.toContain('htmlClass');
  });

  it('still marks a whole cell that contains a formula (inside the math)', () => {
    const injected = buildMarkdownTableRevision('', '| 名称 | 取值 |\n| --- | --- |\n| 上限 | $m \\le 40$ |');
    expect(injected).toContain('$\\textcolor{inherit}{\\underline{m \\le 40}}$');
    expect(injected).not.toContain('htmlClass');
    const html = render(injected as string);
    expect(html).toContain('<ins');
    expect(html).toContain('underline');
  });

  it('treats a pipe after an even backslash run as a column separator (regression)', () => {    // `\\|`：两个反斜杠本身就是字面量，管道**仍然是**分隔符（GFM 按连续反斜杠的奇偶判定）。
    // 旧实现见到 `\` 紧跟 `|` 就当转义，把两格并成一格 → 列边界被静默改写，而校验只看
    // 行数 / 列数，看不出来。四列表：`x \\` 是第三格（一个反斜杠），`y` 是第四格。
    const before = ['| a | b | c | d |', '| --- | --- | --- | --- |', '| 1 | 旧 | x \\\\| y |'].join('\n');
    const after = ['| a | b | c | d |', '| --- | --- | --- | --- |', '| 1 | 新 | x \\\\| y |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    const dataRow = injected?.split('\n')[2] ?? '';
    // 列数没变：偶数反斜杠后的管道依旧拆格（否则会变成 3 格而被静默吞掉一列）。
    expect(countRowCells(dataRow)).toBe(4);
  });

  it('does not re-escape an already escaped pipe in an untouched cell (regression)', () => {
    // 同一张表里另一个格子改动时，未改动的 `\|` 必须原样输出；
    // 无条件 `replace(/\|/g, '\\|')` 会把它变成 `\\|`，反而把字面管道还原成列分隔符。
    const before = ['| 名称 | 说明 |', '| --- | --- |', '| a \\| b | 旧 |'].join('\n');
    const after = ['| 名称 | 说明 |', '| --- | --- |', '| a \\| b | 新 |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    const dataRow = injected?.split('\n')[2] ?? '';
    expect(dataRow).toContain('a \\| b');
    expect(dataRow).not.toContain('a \\\\| b');
    expect(countRowCells(dataRow)).toBe(2);
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

  it('replaces a cell as a whole when the rewrite is near-total (regression)', () => {
    // 实机反馈：文档「状态」栏几乎整格重写，逐词切只剩碎片（中文被切在词中间、
    // 还会出现 `{+++++}` 这类噪声）。这里与段落 / 列表路径同一条占比纪律：
    // 保留文本 < 30% → 整格「旧删除 + 新新增」，不再逐词。
    const before = [
      '| 项 | 内容 |',
      '| --- | --- |',
      '| 状态 | ✅ **已冻结为需求基线**（首次冻结 2026-09-12（v1.8）；v1.9~v1.15 为冻结后修订，v1.15 为当前基线）；后续变更走版本修订（见修订记录） |',
    ].join('\n');
    const after = [
      '| 项 | 内容 |',
      '| --- | --- |',
      '| 状态 | ⚠️ **待确认修订**（依据用户澄清：光纤机禁入建筑密集区 + 建筑实体化碰撞）——经用户确认后并入需求基线 |',
    ].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    expect(injected).toContain(
      '{--✅ **已冻结为需求基线**（首次冻结 2026-09-12（v1.8）；v1.9~v1.15 为冻结后修订，v1.15 为当前基线）；后续变更走版本修订（见修订记录）--}',
    );
    expect(injected).toContain(
      '{++⚠️ **待确认修订**（依据用户澄清：光纤机禁入建筑密集区 + 建筑实体化碰撞）——经用户确认后并入需求基线++}',
    );
  });

  it('keeps formula marks even when the cell rewrite is near-total', () => {
    // 例外：单元格含公式时不能整格替换 —— 外层 <del>/<ins> 画不到 KaTeX 原子盒上，
    // 公式改动只有公式内标记能看见，这类格必须保留逐格结果。
    const before = ['| 名称 | 公式 |', '| --- | --- |', '| 甲乙丙 | $a+b$ |'].join('\n');
    const after = ['| 名称 | 公式 |', '| --- | --- |', '| 戊己庚 | $c+d$ |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    expect(injected).toContain('\\textcolor{currentColor}{\\sout{a+b}}');
    expect(injected).toContain('\\textcolor{inherit}{\\underline{c+d}}');
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
    expect(injected).toContain('$\\textcolor{currentColor}{\\sout{m \\le 30}}$');
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
    expect(injected).toContain('$\\textcolor{inherit}{\\underline{m \\le 40}}$');
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

  it('marks a formula cell whose latex contains an escaped brace (regression)', () => {
    // `\{` / `\}` 是被转义的字面花括号（如 `$\{$`）：花括号配对扫描必须跳过转义序列，
    // 否则深度算错 → 注入包装剥不干净 → 内容校验不过 → 整张表退回块级装饰。
    const before = ['| 名称 | 值 |', '| --- | --- |', '| 集合 | $\\{$ |'].join('\n');
    const after = ['| 名称 | 值 |', '| --- | --- |', '| 集合 | $\\{x$ |'].join('\n');
    const injected = buildMarkdownTableRevision(before, after);
    expect(injected).not.toBeNull();
    expect(injected).toContain('\\textcolor{currentColor}{\\sout{\\{}}');
  });

  it('never leaks sentinel LaTeX when a cell formula would sit next to a digit (regression)', () => {
    // 单元格 `$5和$10` 改 `$6和$10`：注入后的公式闭合 `$` 紧跟数字，渲染链的
    // remarkStrictInlineMath 会把整条公式降级回字面文本（哨兵 LaTeX 直接给用户看到）。
    // 拼装阶段拒绝这种相邻，宁可这一格不带标记也不能泄漏。
    const before = '| 名称 | 值 |\n| --- | --- |\n| 价格 | $5和$10 |\n';
    const after = '| 名称 | 值 |\n| --- | --- |\n| 价格 | $6和$10 |\n';
    const revised = buildMarkdownTableRevision(before, after);
    expect(revised ?? '').not.toMatch(/\\textcolor\{(?:currentColor|inherit)\}/);
    if (revised !== null) {
      // 落回表格路径时至少要是干净的新内容（无字面哨兵命令）。
      expect(revised).not.toContain('\\textcolor{');
      expect(revised).not.toContain('\\sout{');
      expect(revised).not.toContain('\\underline{');
    }
  });
});
