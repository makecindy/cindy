import { describe, expect, it } from 'vitest';

import type { FileDiff } from '@/lib/gitReview.types';
import {
  buildFilteredReviewFileTree,
  buildReviewFileTree,
  filterReviewFileJumpResults,
  findReviewFileTreeFileIndex,
  flattenReviewFileTree,
  getReviewDiffExpansionAction,
  getReviewFileTreeVisibility,
  isReviewFileTreeScrollKey,
  moveReviewFileJumpSelection,
  nextReviewFileJumpPreciseScrollStep,
  nextReviewFileTreeActiveIdFromScroll,
  shouldShowReviewFileTree,
} from '../fileTree';

function diff(path: string): FileDiff {
  return {
    id: `unstaged:${path}`,
    source: 'unstaged',
    path,
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
    hunks: [],
    error: null,
  };
}

describe('review file tree helpers', () => {
  it('groups changed files by directory', () => {
    const tree = buildReviewFileTree([
      diff('src/app.ts'),
      diff('src/components/Button.tsx'),
      diff('README.md'),
    ]);

    expect(tree.map((node) => `${node.type}:${node.name}`)).toEqual([
      'directory:src',
      'file:README.md',
    ]);

    const src = tree[0];
    expect(src.type).toBe('directory');
    if (src.type !== 'directory') return;
    expect(src.children.map((node) => `${node.type}:${node.name}`)).toEqual([
      'directory:components',
      'file:app.ts',
    ]);
  });

  it('filters by path substring while preserving the matching directory chain', () => {
    const { nodes, matchedDiffs } = buildFilteredReviewFileTree(
      [diff('src/app.ts'), diff('src/components/Button.tsx'), diff('docs/Button.md')],
      'components/button',
    );

    expect(matchedDiffs.map((item) => item.path)).toEqual(['src/components/Button.tsx']);
    const flat = flattenReviewFileTree(nodes, new Set());
    expect(flat.map((item) => `${item.depth}:${item.node.type}:${item.node.name}`)).toEqual([
      '0:directory:src',
      '1:directory:components',
      '2:file:Button.tsx',
    ]);
  });

  it('returns an empty tree when no file matches the filter', () => {
    const { nodes, matchedDiffs } = buildFilteredReviewFileTree([diff('src/app.ts')], 'missing');

    expect(nodes).toEqual([]);
    expect(matchedDiffs).toEqual([]);
  });

  it('omits children below collapsed directories', () => {
    const tree = buildReviewFileTree([diff('src/app.ts'), diff('src/components/Button.tsx')]);
    const flat = flattenReviewFileTree(tree, new Set(['dir:src']));

    expect(flat.map((item) => `${item.depth}:${item.node.type}:${item.node.name}`)).toEqual([
      '0:directory:src',
    ]);
  });

  it('hides the sidebar until the user enables it and enough width is available', () => {
    expect(
      shouldShowReviewFileTree({
        userVisible: false,
        containerWidth: 800,
        fileCount: 2,
      }),
    ).toBe(false);
    expect(
      shouldShowReviewFileTree({
        userVisible: true,
        containerWidth: 500,
        fileCount: 2,
      }),
    ).toBe(false);
    expect(
      shouldShowReviewFileTree({
        userVisible: true,
        containerWidth: 800,
        fileCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowReviewFileTree({
        userVisible: true,
        containerWidth: 800,
        fileCount: 2,
      }),
    ).toBe(true);
  });

  it('separates file tree user preference from effective narrow-width visibility', () => {
    expect(
      getReviewFileTreeVisibility({
        userVisible: true,
        containerWidth: 500,
        fileCount: 2,
      }),
    ).toEqual({ effectiveVisible: false, temporarilyHidden: true });

    expect(
      getReviewFileTreeVisibility({
        userVisible: true,
        containerWidth: 620,
        fileCount: 2,
      }),
    ).toEqual({ effectiveVisible: true, temporarilyHidden: false });

    expect(
      getReviewFileTreeVisibility({
        userVisible: false,
        containerWidth: 500,
        fileCount: 2,
      }),
    ).toEqual({ effectiveVisible: false, temporarilyHidden: false });
  });

  it('disables expand-all toggle for an empty current source', () => {
    expect(getReviewDiffExpansionAction([], false)).toBe('disabled');
  });

  it('collapses all diffs when their persisted default is expanded', () => {
    expect(getReviewDiffExpansionAction(['unstaged:a.ts', 'unstaged:b.ts'], true)).toBe('collapse');
  });

  it('expands all diffs when their persisted default is collapsed', () => {
    expect(getReviewDiffExpansionAction(['unstaged:a.ts', 'unstaged:b.ts'], false)).toBe('expand');
  });

  it('keeps the pinned target active while programmatic scroll sync is suppressed', () => {
    expect(
      nextReviewFileTreeActiveIdFromScroll({
        currentActiveFileId: 'unstaged:case-124.json',
        candidateId: 'unstaged:case-123.json',
        suppressed: true,
      }),
    ).toEqual({ activeFileId: 'unstaged:case-124.json', releasePin: false });

    expect(
      nextReviewFileTreeActiveIdFromScroll({
        currentActiveFileId: 'unstaged:case-124.json',
        candidateId: 'unstaged:case-125.json',
        suppressed: false,
      }),
    ).toEqual({ activeFileId: 'unstaged:case-125.json', releasePin: false });

    expect(
      nextReviewFileTreeActiveIdFromScroll({
        currentActiveFileId: 'unstaged:case-124.json',
        candidateId: null,
        suppressed: false,
      }),
    ).toEqual({ activeFileId: 'unstaged:case-124.json', releasePin: false });
  });

  it('does not let late scroll sync overwrite a pinned jump target', () => {
    expect(
      nextReviewFileTreeActiveIdFromScroll({
        currentActiveFileId: 'unstaged:case-124.ts',
        candidateId: 'unstaged:case-104.ts',
        suppressed: false,
        pinnedTargetId: 'unstaged:case-124.ts',
      }),
    ).toEqual({ activeFileId: 'unstaged:case-124.ts', releasePin: false });

    expect(
      nextReviewFileTreeActiveIdFromScroll({
        currentActiveFileId: 'unstaged:case-124.ts',
        candidateId: 'unstaged:case-124.ts',
        suppressed: true,
        pinnedTargetId: 'unstaged:case-124.ts',
      }),
    ).toEqual({ activeFileId: 'unstaged:case-124.ts', releasePin: true });

    expect(
      nextReviewFileTreeActiveIdFromScroll({
        currentActiveFileId: 'unstaged:case-124.ts',
        candidateId: 'unstaged:case-125.ts',
        suppressed: false,
        pinnedTargetId: null,
      }),
    ).toEqual({ activeFileId: 'unstaged:case-125.ts', releasePin: false });
  });

  it('recognizes keyboard scroll intent keys', () => {
    expect(isReviewFileTreeScrollKey('ArrowDown')).toBe(true);
    expect(isReviewFileTreeScrollKey('PageUp')).toBe(true);
    expect(isReviewFileTreeScrollKey(' ')).toBe(true);
    expect(isReviewFileTreeScrollKey('Enter')).toBe(false);
  });

  it('retries precise jump scroll while the target row is not mounted', () => {
    expect(
      nextReviewFileJumpPreciseScrollStep({
        targetStillPinned: true,
        rowMounted: false,
        attemptsLeft: 3,
      }),
    ).toEqual({ action: 'retry', nextAttemptsLeft: 2 });

    expect(
      nextReviewFileJumpPreciseScrollStep({
        targetStillPinned: true,
        rowMounted: true,
        attemptsLeft: 3,
      }),
    ).toEqual({ action: 'scroll', nextAttemptsLeft: 3 });

    expect(
      nextReviewFileJumpPreciseScrollStep({
        targetStillPinned: false,
        rowMounted: false,
        attemptsLeft: 3,
      }),
    ).toEqual({ action: 'stop', nextAttemptsLeft: 3 });

    expect(
      nextReviewFileJumpPreciseScrollStep({
        targetStillPinned: true,
        rowMounted: false,
        attemptsLeft: 0,
      }),
    ).toEqual({ action: 'stop', nextAttemptsLeft: 0 });
  });

  it('resolves active file index in flattened tree and respects collapsed directories', () => {
    const tree = buildReviewFileTree([
      diff('src/app.ts'),
      diff('src/components/Button.tsx'),
      diff('README.md'),
    ]);

    const flat = flattenReviewFileTree(tree, new Set());
    expect(findReviewFileTreeFileIndex(flat, 'unstaged:src/components/Button.tsx')).toBe(2);
    expect(findReviewFileTreeFileIndex(flat, 'unstaged:src')).toBe(-1);
    expect(findReviewFileTreeFileIndex(flat, null)).toBe(-1);

    const collapsed = flattenReviewFileTree(tree, new Set(['dir:src']));
    expect(findReviewFileTreeFileIndex(collapsed, 'unstaged:src/components/Button.tsx')).toBe(-1);
  });

  it('filters jump results by path and reports overflow', () => {
    const { results, overflowCount, totalMatches } = filterReviewFileJumpResults(
      [diff('src/components/Button.tsx'), diff('src/components/Input.tsx'), diff('README.md')],
      'COMPONENTS',
      1,
    );

    expect(totalMatches).toBe(2);
    expect(overflowCount).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      fileName: 'Button.tsx',
      directory: 'src/components',
    });
  });

  it('moves jump selection with wrap-around', () => {
    expect(moveReviewFileJumpSelection(-1, 1, 3)).toBe(0);
    expect(moveReviewFileJumpSelection(-1, -1, 3)).toBe(2);
    expect(moveReviewFileJumpSelection(2, 1, 3)).toBe(0);
    expect(moveReviewFileJumpSelection(0, -1, 3)).toBe(2);
    expect(moveReviewFileJumpSelection(0, 1, 0)).toBe(-1);
  });
});
