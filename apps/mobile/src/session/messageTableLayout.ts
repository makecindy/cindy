import type {
  MobileMarkdownBlock,
  MobileMarkdownInline,
  MobileMarkdownTableRow,
} from '@/session/messageMarkdown';

export interface MobileMarkdownTableColumnWidthInput {
  header: readonly MobileMarkdownInline[][];
  rows: readonly MobileMarkdownTableRow[];
  /** 表格所在消息正文的可用宽度；短表会扩展到这里，宽表继续横向滚动。 */
  availableWidth?: number;
  minWidth: number;
  maxWidth?: number;
}

const DEFAULT_MAX_COLUMN_WIDTH = 220;
const CELL_HORIZONTAL_PADDING = 20;
const TEXT_UNIT_WIDTH = 7.4;
// 图片 inline 没有声明 width 时按缩略图常见宽度估列宽(最终仍被 maxWidth clamp)。
const DEFAULT_IMAGE_INLINE_WIDTH = 150;

export function buildMobileMarkdownTableColumnWidths({
  header,
  rows,
  availableWidth,
  minWidth,
  maxWidth = DEFAULT_MAX_COLUMN_WIDTH,
}: MobileMarkdownTableColumnWidthInput): number[] {
  const columnCount = Math.max(
    header.length,
    ...rows.map((row) => row.cells.length),
  );
  if (columnCount <= 0) return [];
  const normalizedMaxWidth = Math.max(minWidth, maxWidth);
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const contentWidth = Math.max(
      estimateInlineWidth(header[columnIndex] ?? []),
      ...rows.map((row) => estimateInlineWidth(row.cells[columnIndex] ?? [])),
    );
    return clampWidth(
      Math.ceil(contentWidth + CELL_HORIZONTAL_PADDING),
      minWidth,
      normalizedMaxWidth,
    );
  });
  return expandColumnWidthsToAvailableSpace(widths, availableWidth);
}

/**
 * 内容较短时把正文里的剩余空间平均分给仍可扩展的列，避免表格缩在左侧；
 * 内容已经更宽时保持估算宽度，由外层横向 ScrollView 承担溢出。
 */
function expandColumnWidthsToAvailableSpace(
  widths: readonly number[],
  availableWidth: number | undefined,
): number[] {
  if (availableWidth === undefined || !Number.isFinite(availableWidth) || availableWidth <= 0) {
    return [...widths];
  }
  const remaining = Math.max(0, Math.floor(availableWidth) - sum(widths));
  if (remaining <= 0) return [...widths];
  const share = Math.floor(remaining / widths.length);
  const remainder = remaining % widths.length;
  return widths.map((width, index) => width + share + (index < remainder ? 1 : 0));
}

function estimateInlineWidth(inlines: readonly MobileMarkdownInline[]): number {
  return inlines.reduce((total, inline) => (
    inline.type === 'image'
      ? total + (inline.width ?? DEFAULT_IMAGE_INLINE_WIDTH)
      : total + estimateTextWidth(inline.text)
  ), 0);
}

function estimateTextWidth(text: string): number {
  let units = 0;
  for (const char of Array.from(text)) {
    if (/\s/.test(char)) {
      units += 0.5;
    } else if (isWideGlyph(char)) {
      units += 1.9;
    } else {
      units += 1;
    }
  }
  return units * TEXT_UNIT_WIDTH;
}

function isWideGlyph(char: string): boolean {
  return /[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(char);
}

function clampWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * 一条消息里表格单元格超过这个数时，单元格改用轻量文本：iOS 不再逐格创建 UITextView，
 * Android 不再逐格注册「添加到对话」菜单。数百个原生可选文本视图会让长表格消息滑动卡顿。
 */
export const MOBILE_HEAVY_TABLE_CELL_THRESHOLD = 120;

export function mobileMarkdownTableCellCount(blocks: readonly MobileMarkdownBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type !== 'table') continue;
    // Rendering pads every row to the widest row, so count the grid, not the source cells.
    const columns = Math.max(block.header.length, ...block.rows.map((row) => row.cells.length));
    count += columns * (block.rows.length + 1);
  }
  return count;
}
