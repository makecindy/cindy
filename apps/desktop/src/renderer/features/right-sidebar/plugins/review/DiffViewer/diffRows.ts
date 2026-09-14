import type { DiffLine, Hunk } from '@/lib/gitReview.types';

export type DiffViewMode = 'unified' | 'split';

export type HunkRenderRow =
  { type: 'separator'; key: string; count: number } | { type: 'hunk'; key: string; hunk: Hunk };

export type UnifiedDiffRow =
  | { type: 'separator'; key: string; count: number }
  | {
      type: 'line';
      key: string;
      hunk: Hunk;
      line: DiffLine;
      originalLineIndex: number;
      hunkActionAnchor?: HunkActionAnchor;
    };

export interface SplitDiffCell {
  line: DiffLine;
  originalLineIndex: number;
}

export interface PairedChangedLines {
  deleteLine: DiffLine | null;
  addLine: DiffLine | null;
}

export type SplitDiffRow =
  | { type: 'separator'; key: string; count: number }
  | {
      type: 'split-line';
      key: string;
      hunk: Hunk;
      left: SplitDiffCell | null;
      right: SplitDiffCell | null;
      hunkActionAnchor?: HunkActionAnchor;
    };

export type DiffRenderRow = UnifiedDiffRow | SplitDiffRow;

export interface HunkActionAnchor {
  hunk: Hunk;
}

// Keep medium-sized files off the eager DOM path. Two files just below the old
// 500-row cutoff could otherwise mount roughly a thousand diff rows at once.
export const DIFF_ROW_VIRTUAL_THRESHOLD = 200;
export const FILE_LIST_VIRTUAL_THRESHOLD = 100;
export const EAGER_EXPANDED_DIFF_ROW_THRESHOLD = 200;

function oldEndLine(hunk: Hunk): number {
  return hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines - 1 : hunk.oldStart;
}

function hiddenLineCountBeforeHunk(hunks: readonly Hunk[], index: number): number {
  const hunk = hunks[index];
  return index === 0
    ? hunk.oldStart > 1
      ? hunk.oldStart - 1
      : 0
    : hunk.oldStart - oldEndLine(hunks[index - 1]) - 1;
}

function lastChangedLineIndex(hunk: Hunk): number {
  for (let i = hunk.lines.length - 1; i >= 0; i -= 1) {
    if (hunk.lines[i].type !== 'context') return i;
  }
  return hunk.lines.length - 1;
}

function isChangedCell(cell: SplitDiffCell | null): boolean {
  return cell !== null && cell.line.type !== 'context';
}

// split 配对后 delete/add 同行,行序与 unified 行序不一致(如 3删1增时
// add 配在第一行),锚点必须按 split 行序倒查,不能借道 unified 的
// lastChangedLineIndex。
function lastChangedSplitRowIndex(rows: readonly SplitDiffRow[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.type === 'split-line' && (isChangedCell(row.left) || isChangedCell(row.right)))
      return i;
  }
  return rows.length - 1;
}

export function buildHunkRows(hunks: readonly Hunk[]): HunkRenderRow[] {
  const rows: HunkRenderRow[] = [];
  for (let i = 0; i < hunks.length; i += 1) {
    const hunk = hunks[i];
    const hiddenCount = hiddenLineCountBeforeHunk(hunks, i);
    if (hiddenCount > 0) {
      rows.push({ type: 'separator', key: `sep-${hunk.index}`, count: hiddenCount });
    }
    rows.push({ type: 'hunk', key: `hunk-${hunk.index}`, hunk });
  }
  return rows;
}

export function buildUnifiedRows(hunks: readonly Hunk[]): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  for (const row of buildHunkRows(hunks)) {
    if (row.type === 'separator') {
      rows.push(row);
      continue;
    }
    const anchorLineIndex = lastChangedLineIndex(row.hunk);
    for (let i = 0; i < row.hunk.lines.length; i += 1) {
      const line = row.hunk.lines[i];
      rows.push({
        type: 'line',
        key: `line-${row.hunk.index}-${line.index}`,
        hunk: row.hunk,
        line,
        originalLineIndex: line.index,
        hunkActionAnchor: i === anchorLineIndex ? { hunk: row.hunk } : undefined,
      });
    }
  }
  return rows;
}

export function buildSplitRows(hunks: readonly Hunk[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  for (const row of buildHunkRows(hunks)) {
    if (row.type === 'separator') {
      rows.push(row);
      continue;
    }
    const hunkRows = buildSplitRowsForHunk(row.hunk);
    const targetRowIndex = lastChangedSplitRowIndex(hunkRows);
    if (hunkRows[targetRowIndex]?.type === 'split-line') {
      hunkRows[targetRowIndex] = {
        ...hunkRows[targetRowIndex],
        hunkActionAnchor: { hunk: row.hunk },
      };
    }
    rows.push(...hunkRows);
  }
  return rows;
}

export function buildDiffRows(hunks: readonly Hunk[], mode: DiffViewMode): DiffRenderRow[] {
  return mode === 'split' ? buildSplitRows(hunks) : buildUnifiedRows(hunks);
}

/** Counts rendered rows without allocating the row objects used by the diff viewer. */
export function countDiffRows(
  hunks: readonly Hunk[],
  mode: DiffViewMode,
  stopAfter = Number.POSITIVE_INFINITY,
): number {
  let count = 0;
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    if (hiddenLineCountBeforeHunk(hunks, hunkIndex) > 0) count += 1;
    if (count > stopAfter) return count;
    const hunk = hunks[hunkIndex];
    if (mode === 'unified') {
      count += hunk.lines.length;
      if (count > stopAfter) return count;
      continue;
    }
    let lineIndex = 0;
    while (lineIndex < hunk.lines.length) {
      if (hunk.lines[lineIndex].type === 'context') {
        count += 1;
        lineIndex += 1;
        if (count > stopAfter) return count;
        continue;
      }
      let deletes = 0;
      let adds = 0;
      while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].type !== 'context') {
        if (hunk.lines[lineIndex].type === 'delete') deletes += 1;
        else adds += 1;
        lineIndex += 1;
      }
      count += Math.max(deletes, adds);
      if (count > stopAfter) return count;
    }
  }
  return count;
}

export function shouldVirtualizeDiffRows(rowCount: number): boolean {
  return rowCount > DIFF_ROW_VIRTUAL_THRESHOLD;
}

export function shouldVirtualizeFileList(
  fileCount: number,
  eagerExpandedDiffRowCount = 0,
): boolean {
  return (
    fileCount > FILE_LIST_VIRTUAL_THRESHOLD ||
    eagerExpandedDiffRowCount > EAGER_EXPANDED_DIFF_ROW_THRESHOLD
  );
}

export function estimateDiffRowsMinWidthCh(
  rows: readonly DiffRenderRow[],
  mode: DiffViewMode,
): number {
  let max = mode === 'split' ? 88 : 40;
  for (const row of rows) {
    if (row.type === 'line') {
      max = Math.max(max, row.line.content.length + 18);
    } else if (row.type === 'split-line') {
      const left = row.left?.line.content.length ?? 0;
      const right = row.right?.line.content.length ?? 0;
      max = Math.max(max, left + right + 32);
    }
  }
  return max;
}

function buildSplitRowsForHunk(hunk: Hunk): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let i = 0;
  while (i < hunk.lines.length) {
    const line = hunk.lines[i];
    if (line.type === 'context') {
      rows.push({
        type: 'split-line',
        key: `split-context-${hunk.index}-${line.index}`,
        hunk,
        left: cell(line),
        right: cell(line),
      });
      i += 1;
      continue;
    }

    const changedRun = collectChangedRun(hunk, i);
    i = changedRun.nextIndex;

    for (let j = 0; j < changedRun.pairs.length; j += 1) {
      const pair = changedRun.pairs[j];
      const left = pair.deleteLine ? cell(pair.deleteLine) : null;
      const right = pair.addLine ? cell(pair.addLine) : null;
      rows.push({
        type: 'split-line',
        key: `split-change-${hunk.index}-${left?.originalLineIndex ?? 'x'}-${right?.originalLineIndex ?? 'x'}-${j}`,
        hunk,
        left,
        right,
      });
    }
  }
  return rows;
}

export function buildPairedChangedLinesForHunk(hunk: Hunk): PairedChangedLines[] {
  const pairs: PairedChangedLines[] = [];
  let i = 0;
  while (i < hunk.lines.length) {
    if (hunk.lines[i].type === 'context') {
      i += 1;
      continue;
    }
    const changedRun = collectChangedRun(hunk, i);
    pairs.push(...changedRun.pairs);
    i = changedRun.nextIndex;
  }
  return pairs;
}

function collectChangedRun(
  hunk: Hunk,
  startIndex: number,
): { pairs: PairedChangedLines[]; nextIndex: number } {
  const deletes: DiffLine[] = [];
  const adds: DiffLine[] = [];
  let i = startIndex;
  while (i < hunk.lines.length && hunk.lines[i].type !== 'context') {
    const changed = hunk.lines[i];
    if (changed.type === 'delete') deletes.push(changed);
    else adds.push(changed);
    i += 1;
  }
  return { pairs: pairChangedLines(deletes, adds), nextIndex: i };
}

function pairChangedLines(
  deletes: readonly DiffLine[],
  adds: readonly DiffLine[],
): PairedChangedLines[] {
  const count = Math.max(deletes.length, adds.length);
  const pairs: PairedChangedLines[] = [];
  for (let i = 0; i < count; i += 1) {
    pairs.push({
      deleteLine: deletes[i] ?? null,
      addLine: adds[i] ?? null,
    });
  }
  return pairs;
}

function cell(line: DiffLine): SplitDiffCell {
  return {
    line,
    originalLineIndex: line.index,
  };
}
