import { describe, expect, it } from 'vitest';
import { buildMarkdownListRevision } from '../markdownListRevision';
import { buildMarkdownPreviewPlan } from '../markdownBlockDiff';

describe('buildMarkdownListRevision — 无序列表', () => {
  it('marks only the appended item (regression)', () => {
    // 追加一项曾经整块回退（旧列表整体删除 + 新列表整体新增）—— 现在只标新增那一项。
    const before = '- 甲\n- 乙\n- 丙\n';
    const after = '- 甲\n- 乙\n- 丙\n- 丁\n';
    const revised = buildMarkdownListRevision(before, after);
    expect(revised).not.toBeNull();
    expect(revised).toBe('- 甲\n- 乙\n- 丙\n- {++丁++}');
    // 未改动项原样保留（不能带任何标记）。
    expect(revised?.match(/甲/g)).toHaveLength(1);
    expect(revised).not.toContain('{--');
  });

  it('marks only the removed item', () => {
    const before = '- 甲\n- 乙\n- 丙\n';
    const after = '- 甲\n- 丙\n';
    const revised = buildMarkdownListRevision(before, after);
    expect(revised).toBe('- 甲\n- {--乙--}\n- 丙');
  });

  it('marks only the inserted item at the head', () => {
    const before = '- 乙\n- 丙\n';
    const after = '- 甲\n- 乙\n- 丙\n';
    expect(buildMarkdownListRevision(before, after)).toBe('- {++甲++}\n- 乙\n- 丙');
  });

  it('revises a changed item at word level instead of replacing the whole item', () => {
    const before = '- 质量上限为 30\n- 保持不变\n';
    const after = '- 质量上限为 40\n- 保持不变\n';
    const revised = buildMarkdownListRevision(before, after);
    expect(revised).toBe('- 质量上限为 {--30--}{++40++}\n- 保持不变');
  });

  it('still marks a changed item inside its inline math (formula-level)', () => {
    const before = '- 约束 $m \\le 30$ 长期\n- 其它\n';
    const after = '- 约束 $m \\le 40$ 长期\n- 其它\n';
    const revised = buildMarkdownListRevision(before, after);
    expect(revised).toContain('\\textcolor{currentColor}{\\sout{m \\le 30}}');
    expect(revised).toContain('\\textcolor{inherit}{\\underline{m \\le 40}}');
    expect(revised).toContain('- 其它');
  });

  it('refuses a loose list instead of silently tightening it (regression)', () => {
    // 项间有空行的 loose list：逐项重建会把空行吃掉（loose → tight，结构与间距静默变化），
    // 所以这一形态一律返回 null 交回块级装饰（宁可少标，不可标错）。
    const before = '- 甲\n\n- 乙\n\n- 丙\n';
    const after = '- 甲\n\n- 乙\n\n- 丙\n\n- 丁\n';
    expect(buildMarkdownListRevision(before, after)).toBeNull();
    // 计划层依旧不会静默丢结构：它走块级 removed + added。
    const plan = buildMarkdownPreviewPlan(after, before);
    expect(plan.segments.map((segment) => segment.kind)).toContain('removed');
  });

  it('keeps the ordered-list numbering intact', () => {
    const before = '1. 甲\n2. 乙\n';
    const after = '1. 甲\n2. 乙\n3. 丙\n';
    const revised = buildMarkdownListRevision(before, after);
    expect(revised).toBe('1. 甲\n2. 乙\n3. {++丙++}');
  });

  it('refuses a bullet-style change from unordered to ordered', () => {
    expect(buildMarkdownListRevision('- 甲\n- 乙\n', '1. 甲\n2. 乙\n')).toBeNull();
  });
});

describe('buildMarkdownListRevision — 不接手的形态', () => {
  it('refuses task lists so the checkboxes stay intact', () => {
    const before = '- [x] 甲\n- [ ] 乙\n';
    const after = '- [x] 甲\n- [ ] 乙\n- [ ] 丙\n';
    expect(buildMarkdownListRevision(before, after)).toBeNull();
  });

  it('refuses nested lists and multi-line items', () => {
    expect(buildMarkdownListRevision('- 甲\n  - 子\n', '- 甲\n  - 子\n  - 子二\n')).toBeNull();
    expect(
      buildMarkdownListRevision('- 甲\n  续行\n', '- 甲\n  续行改\n'),
    ).toBeNull();
  });
});

describe('buildMarkdownListRevision — 经计划层', () => {
  it('plan emits a single revision segment for an appended item (regression)', () => {
    const before = '- 甲\n- 乙\n- 丙\n\n正文段落。\n';
    const after = '- 甲\n- 乙\n- 丙\n- 丁\n\n正文段落。\n';
    const plan = buildMarkdownPreviewPlan(after, before);

    // 不再出现「整块删除 + 整块新增」两个段：列表是一个 revision 段。
    const kinds = plan.segments.map((segment) => segment.kind);
    expect(kinds).not.toContain('removed');
    expect(plan.segments.some((segment) => segment.content.includes('- {++丁++}'))).toBe(true);
  });
});
