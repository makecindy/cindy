// @vitest-environment jsdom

import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${options.count} unmodified lines`,
  }),
}));

import { buildHunkRows, hunkActionRevealClass, PlainUnifiedDiff } from '../PlainUnifiedDiff';
import type { FileDiff, Hunk } from '@/lib/gitReview.types';
import {
  buildSplitRows,
  buildUnifiedRows,
  countDiffRows,
  shouldVirtualizeDiffRows,
  shouldVirtualizeFileList,
} from '../diffRows';
import {
  collectHighlightLines,
  HIGHLIGHT_MAX_DIFF_LINES,
  HIGHLIGHT_MAX_LINE_LENGTH,
  highlightLineKey,
  LruCache,
  shouldSkipHighlightDiff,
  shouldSkipHighlightLine,
} from '../highlight';
import {
  collectInlineDiffRanges,
  computeInlineDiffRanges,
  computeInlineDiffRangesUncached,
  INLINE_DIFF_MAX_PAIR_COUNT,
  mergeInlineDiffRanges,
  renderInlineDiffHtml,
  shouldSkipInlineDiffCollection,
} from '../inlineDiff';
import { isPreviewableImageDiff } from '../ImageDiffPreview';

function hunk(index: number, oldStart: number, oldLines: number): Hunk {
  return {
    index,
    header: `@@ -${oldStart},${oldLines} +${oldStart},${oldLines} @@`,
    oldStart,
    oldLines,
    newStart: oldStart,
    newLines: oldLines,
    section: '',
    lines: [],
    selectableLines: [],
    raw: '',
  };
}

function line(
  index: number,
  type: 'context' | 'add' | 'delete',
  content: string,
  oldLineNumber: number | null,
  newLineNumber: number | null,
) {
  return {
    index,
    type,
    content,
    raw: `${type === 'add' ? '+' : type === 'delete' ? '-' : ' '}${content}`,
    oldLineNumber,
    newLineNumber,
    originalLineNumber: oldLineNumber ?? newLineNumber,
    selectable: type !== 'context',
    noTrailingNewLine: false,
  };
}

function fileDiff(overrides: Partial<FileDiff>): FileDiff {
  return {
    id: 'unstaged:file.txt',
    source: 'unstaged',
    path: 'file.txt',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: null,
    additions: 0,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [],
    error: null,
    ...overrides,
  };
}

describe('PlainUnifiedDiff hunk separators', () => {
  it('renders a too-large file card without diff rows', () => {
    const onOpenFile = vi.fn();
    const diff = fileDiff({
      kind: 'too-large',
      isTooLarge: true,
      size: 3 * 1024 * 1024 + 1,
      error: 'File is too large to render',
    });
    render(createElement(PlainUnifiedDiff, {
      diff,
      onOpenFile,
    }));

    expect(screen.getByText('rightSidebar.review.status.too-large')).toBeTruthy();
    expect(screen.getByText('rightSidebar.review.kindNotice.too-large')).toBeTruthy();
    fireEvent.click(screen.getByText('rightSidebar.review.openFile'));
    expect(onOpenFile).toHaveBeenCalledWith(diff);
  });

  it('renders image previews for non-text raster diffs and remeasures after image load', async () => {
    const diff = fileDiff({
      id: 'unstaged:asset.png',
      path: 'asset.png',
      kind: 'binary',
      isBinary: true,
    });
    const loadImagePreview = vi.fn(async () => ({
      diffId: diff.id,
      maxBytes: 4 * 1024 * 1024,
      old: {
        present: true,
        oid: 'old1234',
        mime: 'image/png',
        size: 4,
        dataUrl: 'data:image/png;base64,b2xk',
      },
      new: {
        present: true,
        oid: null,
        mime: 'image/png',
        size: 4,
        dataUrl: 'data:image/png;base64,bmV3',
      },
    }));
    const onImagePreviewLoad = vi.fn();

    const { container } = render(createElement(PlainUnifiedDiff, {
      diff,
      loadImagePreview,
      onImagePreviewLoad,
    }));

    await waitFor(() => expect(container.querySelector('[data-review-image-preview="true"]')).toBeTruthy());
    expect(loadImagePreview).toHaveBeenCalledWith(diff);
    expect(screen.getByText('rightSidebar.review.imagePreview.old')).toBeTruthy();
    expect(screen.getByText('rightSidebar.review.imagePreview.new')).toBeTruthy();

    const image = screen.getAllByRole('img')[0] as HTMLImageElement;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 16 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 12 });
    fireEvent.load(image);

    expect(onImagePreviewLoad).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/16×12/)).toBeTruthy();
  });

  it('keeps raster-named text files on the text diff path', () => {
    const loadImagePreview = vi.fn();
    const diff = fileDiff({
      id: 'unstaged:asset.png',
      path: 'asset.png',
      kind: 'text',
      additions: 1,
      hunks: [{
        ...hunk(0, 1, 1),
        lines: [line(0, 'add', 'not really an image', null, 1)],
        selectableLines: [0],
      }],
    });

    render(createElement(PlainUnifiedDiff, { diff, loadImagePreview }));

    expect(isPreviewableImageDiff(diff)).toBe(false);
    expect(screen.getByText('not really an image')).toBeTruthy();
    expect(loadImagePreview).not.toHaveBeenCalled();
  });

  it('does not preview svg binary diffs', () => {
    const loadImagePreview = vi.fn();
    const diff = fileDiff({
      id: 'unstaged:icon.svg',
      path: 'icon.svg',
      kind: 'binary',
      isBinary: true,
    });

    const { container } = render(createElement(PlainUnifiedDiff, { diff, loadImagePreview }));

    expect(isPreviewableImageDiff(diff)).toBe(false);
    expect(container.querySelector('[data-review-image-preview="true"]')).toBeNull();
    expect(loadImagePreview).not.toHaveBeenCalled();
  });

  it('inserts a leading separator before the first hunk when file starts later', () => {
    expect(buildHunkRows([hunk(0, 8, 3)]).map((row) =>
      row.type === 'separator' ? { type: row.type, count: row.count } : { type: row.type },
    )).toEqual([
      { type: 'separator', count: 7 },
      { type: 'hunk' },
    ]);
  });

  it('inserts separators between hunks based on old line ranges', () => {
    expect(buildHunkRows([hunk(0, 10, 5), hunk(1, 40, 4)]).map((row) =>
      row.type === 'separator' ? { type: row.type, count: row.count } : { type: row.type },
    )).toEqual([
      { type: 'separator', count: 9 },
      { type: 'hunk' },
      { type: 'separator', count: 25 },
      { type: 'hunk' },
    ]);
  });

  it('does not insert separators for adjacent hunk ranges', () => {
    expect(buildHunkRows([hunk(0, 1, 3), hunk(1, 4, 2)]).map((row) => row.type)).toEqual([
      'hunk',
      'hunk',
    ]);
  });

  it('keeps long lines inside the horizontal scroll container', () => {
    const longLine = 'x'.repeat(600);
    const diff: FileDiff = {
      id: 'unstaged:long.txt',
      source: 'unstaged',
      path: 'long.txt',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 0,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 1),
        lines: [{
          index: 0,
          type: 'add',
          content: longLine,
          raw: `+${longLine}`,
          oldLineNumber: null,
          newLineNumber: 1,
          originalLineNumber: 1,
          selectable: true,
          noTrailingNewLine: false,
        }],
        selectableLines: [0],
      }],
      error: null,
    };

    const { container } = render(createElement(PlainUnifiedDiff, { diff }));

    expect(screen.getByText(longLine)).toBeTruthy();
    expect(container.querySelector('.overflow-x-auto')).toBeTruthy();
    expect(container.querySelector('.w-max.min-w-full')).toBeTruthy();
  });

  it('wraps long lines without the horizontal min-width path when word wrap is enabled', () => {
    const longLine = 'x'.repeat(600);
    const diff: FileDiff = {
      id: 'unstaged:wrapped.txt',
      source: 'unstaged',
      path: 'wrapped.txt',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 0,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 1),
        lines: [line(0, 'add', longLine, null, 1)],
        selectableLines: [0],
      }],
      error: null,
    };

    const { container } = render(createElement(PlainUnifiedDiff, { diff, wordWrap: true }));

    expect(screen.getByText(longLine)).toBeTruthy();
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
    expect(container.querySelector('.overflow-x-hidden')).toBeTruthy();
    expect(container.querySelector('.w-max')).toBeNull();
    expect(container.querySelector('.whitespace-pre-wrap.break-words')).toBeTruthy();
  });

  it('keeps split view at container width and gives long unwrapped cells their own scrollers', () => {
    const longLine = 'x'.repeat(600);
    const diff: FileDiff = {
      id: 'unstaged:split-wide.txt',
      source: 'unstaged',
      path: 'split-wide.txt',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 1,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 1),
        lines: [
          line(0, 'delete', longLine, 1, null),
          line(1, 'add', longLine, null, 1),
        ],
        selectableLines: [0, 1],
      }],
      error: null,
    };

    const { container } = render(createElement(PlainUnifiedDiff, { diff, viewMode: 'split' }));

    expect(container.querySelector('.overflow-x-hidden')).toBeTruthy();
    expect(container.querySelector('.w-max')).toBeNull();
    expect(container.querySelector('.grid-cols-2')).toBeTruthy();
    expect(container.querySelector('.overflow-hidden.border-r')).toBeTruthy();
    expect(container.querySelectorAll('[data-review-split-cell-scroll="true"].overflow-x-auto')).toHaveLength(2);
    expect(container.querySelectorAll('[data-review-split-cell-scroll="true"].scrollbar-hide')).toHaveLength(2);
  });

  it('renders multiple hunk actions for revert plus stage', () => {
    const diff: FileDiff = {
      id: 'unstaged:file.txt',
      source: 'unstaged',
      path: 'file.txt',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 0,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 1),
        lines: [line(0, 'add', 'new', null, 1)],
        selectableLines: [0],
      }],
      error: null,
    };

    const { container } = render(createElement(PlainUnifiedDiff, {
      diff,
      hunkActions: [
        { label: 'Revert', disabled: false, icon: 'revert', isPending: () => false, onClick: vi.fn() },
        { label: 'Stage', disabled: false, icon: 'plus', isPending: () => false, onClick: vi.fn() },
      ],
    }));

    expect(screen.queryByText(diff.hunks[0].header)).toBeNull();
    expect(screen.getByRole('button', { name: /Revert/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stage/ })).toBeTruthy();
    expect(container.querySelector('[data-review-hunk-action-anchor="true"]')).toBeTruthy();
    const reveal = container.querySelector('[data-review-action-reveal="hunk"]');
    expect(reveal?.className).toContain('opacity-0');
    expect(reveal?.className).toContain('group-hover/file:opacity-100');
    expect(reveal?.className).toContain('group-focus-within/file:opacity-100');
    expect(reveal?.className).toContain('sticky');
    expect(reveal?.className).toContain('right-2');
    expect(container.querySelector('[data-review-hunk-action-anchor="true"]')?.className).toContain('bottom-[3px]');
  });

  it('keeps hunk actions visible while an operation is pending', () => {
    const diff: FileDiff = {
      id: 'unstaged:file.txt',
      source: 'unstaged',
      path: 'file.txt',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 0,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 1),
        lines: [line(0, 'add', 'new', null, 1)],
        selectableLines: [0],
      }],
      error: null,
    };

    const { container } = render(createElement(PlainUnifiedDiff, {
      diff,
      hunkActions: [
        { label: 'Stage', disabled: false, icon: 'plus', isPending: () => true, onClick: vi.fn() },
      ],
    }));

    const reveal = container.querySelector('[data-review-action-reveal="hunk"]');
    expect(reveal?.className).toContain('opacity-100');
    expect(reveal?.className).not.toContain('opacity-0');
    expect(hunkActionRevealClass(true)).toContain('opacity-100');
  });
});

describe('PlainUnifiedDiff split rows', () => {
  it('anchors unified hunk actions on the last changed line before trailing context', () => {
    const sourceHunk: Hunk = {
      ...hunk(0, 1, 7),
      lines: [
        line(0, 'context', 'same before', 1, 1),
        line(1, 'delete', 'old', 2, null),
        line(2, 'context', 'same middle', 3, 2),
        line(3, 'add', 'new', null, 3),
        line(4, 'context', 'same after 1', 4, 4),
        line(5, 'context', 'same after 2', 5, 5),
        line(6, 'context', 'same after 3', 6, 6),
      ],
      selectableLines: [1, 3],
    };

    const rows = buildUnifiedRows([sourceHunk]);
    const lineRows = rows.filter((row) => row.type === 'line');

    expect(lineRows.map((row) => row.hunkActionAnchor ? row.originalLineIndex : null)).toEqual([
      null,
      null,
      null,
      3,
      null,
      null,
      null,
    ]);
  });

  it('anchors split hunk actions on the row containing the last changed cell before trailing context', () => {
    const sourceHunk: Hunk = {
      ...hunk(0, 10, 7),
      lines: [
        line(0, 'context', 'same before', 10, 10),
        line(1, 'delete', 'old one', 11, null),
        line(2, 'delete', 'old two', 12, null),
        line(3, 'add', 'new one', null, 11),
        line(4, 'context', 'same after 1', 13, 12),
        line(5, 'context', 'same after 2', 14, 13),
        line(6, 'context', 'same after 3', 15, 14),
      ],
      selectableLines: [1, 2, 3],
    };

    const rows = buildSplitRows([sourceHunk]);
    const splitRows = rows.filter((row) => row.type === 'split-line');

    expect(splitRows.map((row) => ({
      left: row.left?.originalLineIndex ?? null,
      right: row.right?.originalLineIndex ?? null,
      anchor: row.hunkActionAnchor?.hunk.index ?? null,
    }))).toEqual([
      { left: 0, right: 0, anchor: null },
      { left: 1, right: 3, anchor: null },
      { left: 2, right: null, anchor: 0 },
      { left: 4, right: 4, anchor: null },
      { left: 5, right: 5, anchor: null },
      { left: 6, right: 6, anchor: null },
    ]);
  });

  it('anchors split hunk actions on the last add row when adds outnumber deletes', () => {
    const sourceHunk: Hunk = {
      ...hunk(0, 10, 5),
      lines: [
        line(0, 'context', 'same before', 10, 10),
        line(1, 'delete', 'old one', 11, null),
        line(2, 'add', 'new one', null, 11),
        line(3, 'add', 'new two', null, 12),
        line(4, 'context', 'same after', 12, 13),
      ],
      selectableLines: [1, 2, 3],
    };

    const rows = buildSplitRows([sourceHunk]);
    const splitRows = rows.filter((row) => row.type === 'split-line');

    expect(splitRows.map((row) => ({
      left: row.left?.originalLineIndex ?? null,
      right: row.right?.originalLineIndex ?? null,
      anchor: row.hunkActionAnchor?.hunk.index ?? null,
    }))).toEqual([
      { left: 0, right: 0, anchor: null },
      { left: 1, right: 2, anchor: null },
      { left: null, right: 3, anchor: 0 },
      { left: 4, right: 4, anchor: null },
    ]);
  });
});

describe('PlainUnifiedDiff performance helpers', () => {
  it('uses explicit thresholds for diff and file-list virtualization', () => {
    expect(shouldVirtualizeDiffRows(200)).toBe(false);
    expect(shouldVirtualizeDiffRows(201)).toBe(true);
    expect(shouldVirtualizeFileList(100)).toBe(false);
    expect(shouldVirtualizeFileList(101)).toBe(true);
    expect(shouldVirtualizeFileList(13, 200)).toBe(false);
    expect(shouldVirtualizeFileList(13, 201)).toBe(true);
  });

  it('virtualizes a small file list when its expanded eager rows exceed the shared budget', () => {
    expect(shouldVirtualizeFileList(13, 13 * 172)).toBe(true);
  });

  it('counts unified and paired split rows without building render rows', () => {
    const sourceHunk = {
      ...hunk(0, 8, 3),
      lines: [
        line(0, 'context', 'before', 8, 8),
        line(1, 'delete', 'old', 9, null),
        line(2, 'add', 'new', null, 9),
        line(3, 'context', 'after', 10, 10),
      ],
    };

    expect(countDiffRows([sourceHunk], 'unified')).toBe(5);
    expect(countDiffRows([sourceHunk], 'split')).toBe(4);
  });

  it('virtualizes files shaped like the two-file whole-file rewrite regression', () => {
    expect(shouldVirtualizeDiffRows(487)).toBe(true);
    expect(shouldVirtualizeDiffRows(478)).toBe(true);
  });

  it('marks the virtualized diff branch for a file from the two-file regression', () => {
    const manyLines = Array.from({ length: 487 }, (_, index) =>
      line(index, 'context', `line ${index}`, index + 1, index + 1),
    );
    const diff: FileDiff = {
      id: 'unstaged:large.txt',
      source: 'unstaged',
      path: 'large.txt',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 0,
      deletions: 0,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: manyLines.map((l) => l.raw).join('\n'),
      hunks: [{
        ...hunk(0, 1, manyLines.length),
        lines: manyLines,
        selectableLines: [],
      }],
      error: null,
    };

    const { container } = render(createElement(PlainUnifiedDiff, { diff }));

    expect(container.querySelector('[data-virtualized-diff="true"]')).toBeTruthy();
  });

  it('resets horizontal scroll when switching between unified and split views', () => {
    const diff: FileDiff = {
      id: 'unstaged:wide.txt',
      source: 'unstaged',
      path: 'wide.txt',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 0,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 1),
        lines: [line(0, 'add', 'x'.repeat(600), null, 1)],
        selectableLines: [0],
      }],
      error: null,
    };

    const { container, rerender } = render(createElement(PlainUnifiedDiff, { diff, viewMode: 'unified' }));
    const scrollContainer = container.querySelector('.overflow-x-auto') as HTMLDivElement;
    scrollContainer.scrollLeft = 240;

    rerender(createElement(PlainUnifiedDiff, { diff, viewMode: 'split' }));

    expect(scrollContainer.scrollLeft).toBe(0);
  });

  it('keeps split columns visible while each side owns horizontal scrolling', () => {
    const longDelete = `old ${'x'.repeat(180)}`;
    const longAdd = `new ${'y'.repeat(180)}`;
    const diff: FileDiff = {
      id: 'unstaged:split-wide.txt',
      source: 'unstaged',
      path: 'split-wide.txt',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 1,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 2),
        lines: [
          line(0, 'delete', longDelete, 1, null),
          line(1, 'add', longAdd, null, 1),
        ],
        selectableLines: [0, 1],
      }],
      error: null,
    };

    const { container } = render(createElement(PlainUnifiedDiff, { diff, viewMode: 'split' }));
    const cellScrollers = container.querySelectorAll('[data-review-split-cell-scroll="true"]');

    expect(cellScrollers).toHaveLength(2);
    cellScrollers.forEach((scroller) => {
      expect(scroller.className).toContain('overflow-x-auto');
      expect(scroller.className).toContain('scrollbar-hide');
    });
    expect(container.querySelector('.grid-cols-2')).toBeTruthy();
    expect(container.querySelector('.w-max.min-w-full')).toBeNull();
  });
});

describe('PlainUnifiedDiff highlighting helpers', () => {
  it('keeps a bounded LRU cache', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('skips empty and oversized lines', () => {
    expect(shouldSkipHighlightLine('')).toBe(true);
    expect(shouldSkipHighlightLine('x'.repeat(HIGHLIGHT_MAX_LINE_LENGTH))).toBe(false);
    expect(shouldSkipHighlightLine('x'.repeat(HIGHLIGHT_MAX_LINE_LENGTH + 1))).toBe(true);
  });

  it('collects highlight lines by hunk-local composite key and skips oversized content', () => {
    const sourceHunk: Hunk = {
      ...hunk(0, 1, 3),
      lines: [
        line(0, 'context', 'const a = 1;', 1, 1),
        line(1, 'delete', 'x'.repeat(HIGHLIGHT_MAX_LINE_LENGTH + 1), 2, null),
        line(2, 'add', 'const b = 2;', null, 2),
      ],
      selectableLines: [1, 2],
    };
    const rows = buildSplitRows([sourceHunk]);

    expect(collectHighlightLines(rows)).toEqual([
      { key: '0:0', content: 'const a = 1;' },
      { key: '0:2', content: 'const b = 2;' },
    ]);
    expect(shouldSkipHighlightDiff(rows)).toBe(false);
  });

  it('skips per-line worker highlighting for medium whole-file rewrites', () => {
    const manyLines = Array.from({ length: HIGHLIGHT_MAX_DIFF_LINES + 1 }, (_, index) =>
      line(index, 'add', `const value${index} = true;`, null, index + 1),
    );
    const rows = buildUnifiedRows([{
      ...hunk(0, 1, manyLines.length),
      lines: manyLines,
      selectableLines: manyLines.map((_, index) => index),
    }]);

    expect(shouldSkipHighlightDiff(rows)).toBe(true);
  });

  it('keeps multi-hunk highlight keys from overwriting same local line indices', () => {
    const firstHunk: Hunk = {
      ...hunk(0, 1, 2),
      lines: [
        line(0, 'context', 'first context', 1, 1),
        line(1, 'add', 'first change', null, 2),
      ],
      selectableLines: [1],
    };
    const secondHunk: Hunk = {
      ...hunk(1, 70, 2),
      lines: [
        line(0, 'context', 'second context', 70, 70),
        line(1, 'add', 'second change', null, 71),
      ],
      selectableLines: [1],
    };
    const lines = collectHighlightLines(buildUnifiedRows([firstHunk, secondHunk]));
    const byKey = new Map(lines.map((item) => [item.key, item.content]));

    expect(byKey.get(highlightLineKey(0, 0))).toBe('first context');
    expect(byKey.get(highlightLineKey(0, 1))).toBe('first change');
    expect(byKey.get(highlightLineKey(1, 0))).toBe('second context');
    expect(byKey.get(highlightLineKey(1, 1))).toBe('second change');
    expect(lines).toHaveLength(4);
  });
});

describe('PlainUnifiedDiff inline diff helpers', () => {
  it('computes changed word ranges for paired delete and add lines', () => {
    const oldText = 'const color = "red";';
    const newText = 'const color = "blue";';

    const result = computeInlineDiffRanges(oldText, newText);

    expect(result?.deleteRanges).toEqual([{ start: oldText.indexOf('red'), end: oldText.indexOf('red') + 3 }]);
    expect(result?.addRanges).toEqual([{ start: newText.indexOf('blue'), end: newText.indexOf('blue') + 4 }]);
  });

  it('merges adjacent ranges and drops invalid ranges', () => {
    expect(mergeInlineDiffRanges([
      { start: 3, end: 4 },
      { start: 0, end: 1 },
      { start: 1, end: 3 },
      { start: 8, end: 8 },
    ], 10)).toEqual([
      { start: 0, end: 4 },
    ]);
  });

  it('skips oversized and low-similarity lines', () => {
    expect(computeInlineDiffRanges('a'.repeat(HIGHLIGHT_MAX_LINE_LENGTH + 1), 'a'.repeat(HIGHLIGHT_MAX_LINE_LENGTH + 1))).toBeNull();
    expect(computeInlineDiffRangesUncached('abc', 'xyz', {
      maxLineLength: HIGHLIGHT_MAX_LINE_LENGTH,
      minCommonRatio: 0.3,
    })).toBeNull();
  });

  it('collects inline ranges only for paired changed lines and leaves surplus rows unhighlighted', () => {
    const sourceHunk: Hunk = {
      ...hunk(0, 1, 5),
      lines: [
        line(0, 'delete', 'const first = "old";', 1, null),
        line(1, 'delete', 'const surplus = "old";', 2, null),
        line(2, 'add', 'const first = "new";', null, 1),
        line(3, 'context', 'same', 3, 2),
        line(4, 'add', 'const onlyAdded = true;', null, 3),
      ],
      selectableLines: [0, 1, 2, 4],
    };

    const ranges = collectInlineDiffRanges([sourceHunk]);

    expect(ranges.has(highlightLineKey(0, 0))).toBe(true);
    expect(ranges.has(highlightLineKey(0, 2))).toBe(true);
    expect(ranges.has(highlightLineKey(0, 1))).toBe(false);
    expect(ranges.has(highlightLineKey(0, 4))).toBe(false);
  });

  it('skips inline diff collection for very large changed-line sets', () => {
    const lines: ReturnType<typeof line>[] = [];
    const selectableLines: number[] = [];
    for (let i = 0; i <= INLINE_DIFF_MAX_PAIR_COUNT; i += 1) {
      const deleteIndex = i * 2;
      const addIndex = deleteIndex + 1;
      lines.push(line(deleteIndex, 'delete', `const value${i} = "old";`, i + 1, null));
      lines.push(line(addIndex, 'add', `const value${i} = "new";`, null, i + 1));
      selectableLines.push(deleteIndex, addIndex);
    }
    const sourceHunk: Hunk = {
      ...hunk(0, 1, lines.length),
      lines,
      selectableLines,
    };

    expect(shouldSkipInlineDiffCollection([sourceHunk])).toBe(true);
    expect(collectInlineDiffRanges([sourceHunk]).size).toBe(0);
  });

  it('renders inline emphasis across nested Shiki span boundaries without losing syntax spans', () => {
    const html = '<span class="token-a">ab</span><span class="token-b">cde</span>';
    const rendered = renderInlineDiffHtml({
      content: 'abcde',
      html,
      ranges: [{ start: 1, end: 4 }],
      side: 'add',
    });
    const container = document.createElement('div');
    container.innerHTML = rendered;

    expect(container.textContent).toBe('abcde');
    expect(container.querySelector('.token-a')).toBeTruthy();
    expect(container.querySelector('.token-b')).toBeTruthy();
    expect(Array.from(container.querySelectorAll('[data-review-inline-diff="add"]')).map((node) => node.textContent).join('')).toBe('bcd');
  });

  it('falls back to escaped plain text when highlighted html does not match the source line', () => {
    const rendered = renderInlineDiffHtml({
      content: '<abc>',
      html: '<span>&lt;ab</span>',
      ranges: [{ start: 1, end: 4 }],
      side: 'delete',
    });
    const container = document.createElement('div');
    container.innerHTML = rendered;

    expect(container.textContent).toBe('<abc>');
    expect(container.querySelector('[data-review-inline-diff="delete"]')?.textContent).toBe('abc');
  });

  it('renders inline diff emphasis in unified and split views', () => {
    const diff: FileDiff = {
      id: 'unstaged:inline.ts',
      source: 'unstaged',
      path: 'inline.ts',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 1,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 2),
        lines: [
          line(0, 'delete', 'const label = "old";', 1, null),
          line(1, 'add', 'const label = "new";', null, 1),
        ],
        selectableLines: [0, 1],
      }],
      error: null,
    };

    const { container, rerender } = render(createElement(PlainUnifiedDiff, { diff, viewMode: 'unified' }));
    expect(container.querySelector('[data-review-inline-diff="delete"]')?.textContent).toBe('old');
    expect(container.querySelector('[data-review-inline-diff="add"]')?.textContent).toBe('new');

    rerender(createElement(PlainUnifiedDiff, { diff, viewMode: 'split' }));
    expect(container.querySelector('[data-review-inline-diff="delete"]')?.textContent).toBe('old');
    expect(container.querySelector('[data-review-inline-diff="add"]')?.textContent).toBe('new');
  });

  it('skips inline emphasis when word diffs are disabled', () => {
    const diff: FileDiff = {
      id: 'unstaged:inline-disabled.ts',
      source: 'unstaged',
      path: 'inline-disabled.ts',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      size: null,
      additions: 1,
      deletions: 1,
      isBinary: false,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [{
        ...hunk(0, 1, 2),
        lines: [
          line(0, 'delete', 'const label = "old";', 1, null),
          line(1, 'add', 'const label = "new";', null, 1),
        ],
        selectableLines: [0, 1],
      }],
      error: null,
    };

    const { container } = render(createElement(PlainUnifiedDiff, { diff, wordDiff: false }));

    expect(container.querySelector('[data-review-inline-diff]')).toBeNull();
    expect(container.textContent).toContain('const label = "old";');
    expect(container.textContent).toContain('const label = "new";');
  });
});
