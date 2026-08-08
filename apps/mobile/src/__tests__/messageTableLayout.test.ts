import { describe, expect, it } from 'vitest';
import { buildMobileMarkdownTableColumnWidths } from '@/session/messageTableLayout';
import type { MobileMarkdownInline, MobileMarkdownTableRow } from '@/session/messageMarkdown';

describe('messageTableLayout', () => {
  it('builds stable shared column widths for compact assistant tables', () => {
    const header = inlineCells(['项目', '大小', '处理']);
    const rows: MobileMarkdownTableRow[] = [
      row('r1', ['用户临时文件 Temp', '~529MB', '现在直接清']),
      row('r2', ['Windows 更新缓存', '~621MB', '现在直接清']),
      row('r3', ['Downloads\\RJ406835.zip', '8.42GB', '删除前再跟你确认一次']),
    ];

    const widths = buildMobileMarkdownTableColumnWidths({
      header,
      rows,
      minWidth: 96,
    });

    expect(widths).toHaveLength(3);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[2]).toBeGreaterThan(widths[1]);
    expect(widths.every((width) => width >= 96)).toBe(true);
  });

  it('includes missing cells in the shared column count', () => {
    const widths = buildMobileMarkdownTableColumnWidths({
      header: inlineCells(['Name']),
      rows: [
        row('r1', ['Item', 'Status']),
      ],
      minWidth: 96,
    });

    expect(widths).toHaveLength(2);
  });

  it('expands a compact table to the available message width', () => {
    const widths = buildMobileMarkdownTableColumnWidths({
      header: inlineCells(['年份', 'GDP']),
      rows: [
        row('r1', ['2025', '30.77 万亿美元']),
        row('r2', ['2024', '29.30 万亿美元']),
      ],
      availableWidth: 329,
      minWidth: 112,
    });

    expect(widths.reduce((total, width) => total + width, 0)).toBe(329);
    expect(widths.every((width) => width >= 112)).toBe(true);
  });

  it('keeps wide tables wider than the viewport for horizontal scrolling', () => {
    const widths = buildMobileMarkdownTableColumnWidths({
      header: inlineCells(['第一列', '第二列', '第三列']),
      rows: [row('r1', [
        '一段明显超过单列最大宽度的内容',
        '另一段明显超过单列最大宽度的内容',
        '第三段明显超过单列最大宽度的内容',
      ])],
      availableWidth: 329,
      minWidth: 112,
    });

    expect(widths.reduce((total, width) => total + width, 0)).toBeGreaterThan(329);
  });

  it('fills wide mobile layouts beyond the intrinsic column width cap', () => {
    const widths = buildMobileMarkdownTableColumnWidths({
      header: inlineCells(['年份', 'GDP']),
      rows: [row('r1', ['2025', '30.77 万亿美元'])],
      availableWidth: 768,
      minWidth: 112,
    });

    expect(widths.reduce((total, width) => total + width, 0)).toBe(768);
    expect(widths.some((width) => width > 220)).toBe(true);
  });

  it('never expands past a fractional available width', () => {
    const availableWidth = 329.5;
    const widths = buildMobileMarkdownTableColumnWidths({
      header: inlineCells(['年份', 'GDP']),
      rows: [row('r1', ['2025', '30.77 万亿美元'])],
      availableWidth,
      minWidth: 112,
    });

    expect(widths.reduce((total, width) => total + width, 0)).toBeLessThanOrEqual(availableWidth);
  });
});

function row(key: string, cells: string[]): MobileMarkdownTableRow {
  return {
    key,
    cells: inlineCells(cells),
  };
}

function inlineCells(cells: string[]): MobileMarkdownInline[][] {
  return cells.map((text) => [{ type: 'text', text }]);
}
