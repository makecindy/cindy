import type { FileDiff } from '@/lib/gitReview.types';

export const REVIEW_FILE_TREE_WIDTH_PX = 220;
export const REVIEW_FILE_TREE_MIN_CONTAINER_WIDTH_PX = 620;
export const REVIEW_FILE_JUMP_RESULT_LIMIT = 50;

export type ReviewFileTreeNode = ReviewFileTreeDirectoryNode | ReviewFileTreeFileNode;

export interface ReviewFileTreeDirectoryNode {
  type: 'directory';
  id: string;
  path: string;
  name: string;
  children: ReviewFileTreeNode[];
}

export interface ReviewFileTreeFileNode {
  type: 'file';
  id: string;
  path: string;
  name: string;
  diff: FileDiff;
}

export interface ReviewFileTreeFlatNode {
  node: ReviewFileTreeNode;
  depth: number;
}

export interface ReviewFileJumpResult {
  diff: FileDiff;
  fileName: string;
  directory: string;
}

export interface ReviewFileTreeActiveSyncResult {
  activeFileId: string | null;
  releasePin: boolean;
}

export type ReviewFileJumpPreciseScrollAction = 'stop' | 'scroll' | 'retry';

export interface ReviewFileJumpPreciseScrollStep {
  action: ReviewFileJumpPreciseScrollAction;
  nextAttemptsLeft: number;
}

export type ReviewDiffExpansionToggleAction = 'expand' | 'collapse' | 'disabled';

export interface ReviewFileTreeVisibility {
  effectiveVisible: boolean;
  temporarilyHidden: boolean;
}

interface MutableDirectory {
  path: string;
  name: string;
  directories: Map<string, MutableDirectory>;
  files: ReviewFileTreeFileNode[];
}

export function buildFilteredReviewFileTree(
  diffs: readonly FileDiff[],
  query: string,
): { nodes: ReviewFileTreeNode[]; matchedDiffs: FileDiff[] } {
  const normalizedQuery = query.trim().toLowerCase();
  const matchedDiffs = normalizedQuery
    ? diffs.filter((diff) => diff.path.toLowerCase().includes(normalizedQuery))
    : [...diffs];
  return {
    nodes: buildReviewFileTree(matchedDiffs),
    matchedDiffs,
  };
}

export function filterReviewFileJumpResults(
  diffs: readonly FileDiff[],
  query: string,
  limit = REVIEW_FILE_JUMP_RESULT_LIMIT,
): { results: ReviewFileJumpResult[]; overflowCount: number; totalMatches: number } {
  const normalizedQuery = query.trim().toLowerCase();
  const matchedDiffs = normalizedQuery
    ? diffs.filter((diff) => diff.path.toLowerCase().includes(normalizedQuery))
    : [...diffs];
  const totalMatches = matchedDiffs.length;
  const limited = matchedDiffs.slice(0, limit);
  return {
    results: limited.map((diff) => {
      const parts = splitPath(diff.path);
      const fileName = parts.pop() ?? diff.path;
      return {
        diff,
        fileName,
        directory: parts.join('/'),
      };
    }),
    overflowCount: Math.max(0, totalMatches - limited.length),
    totalMatches,
  };
}

export function buildReviewFileTree(diffs: readonly FileDiff[]): ReviewFileTreeNode[] {
  const root: MutableDirectory = {
    path: '',
    name: '',
    directories: new Map(),
    files: [],
  };

  for (const diff of [...diffs].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = splitPath(diff.path);
    const fileName = parts.pop() ?? diff.path;
    let dir = root;
    for (const part of parts) {
      const nextPath = dir.path ? `${dir.path}/${part}` : part;
      let next = dir.directories.get(part);
      if (!next) {
        next = {
          path: nextPath,
          name: part,
          directories: new Map(),
          files: [],
        };
        dir.directories.set(part, next);
      }
      dir = next;
    }
    dir.files.push({
      type: 'file',
      id: diff.id,
      path: diff.path,
      name: fileName,
      diff,
    });
  }

  return materializeDirectory(root).children;
}

export function flattenReviewFileTree(
  nodes: readonly ReviewFileTreeNode[],
  collapsedDirectoryIds: ReadonlySet<string>,
): ReviewFileTreeFlatNode[] {
  const flat: ReviewFileTreeFlatNode[] = [];
  const walk = (items: readonly ReviewFileTreeNode[], depth: number) => {
    for (const node of items) {
      flat.push({ node, depth });
      if (node.type === 'directory' && !collapsedDirectoryIds.has(node.id)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return flat;
}

export function shouldShowReviewFileTree({
  userVisible,
  containerWidth,
  fileCount,
}: {
  userVisible: boolean;
  containerWidth: number;
  fileCount: number;
}): boolean {
  return getReviewFileTreeVisibility({ userVisible, containerWidth, fileCount }).effectiveVisible;
}

export function getReviewFileTreeVisibility({
  userVisible,
  containerWidth,
  fileCount,
}: {
  userVisible: boolean;
  containerWidth: number;
  fileCount: number;
}): ReviewFileTreeVisibility {
  if (!userVisible || fileCount === 0) {
    return { effectiveVisible: false, temporarilyHidden: false };
  }
  if (containerWidth <= 0) {
    return { effectiveVisible: false, temporarilyHidden: false };
  }
  if (containerWidth < REVIEW_FILE_TREE_MIN_CONTAINER_WIDTH_PX) {
    return { effectiveVisible: false, temporarilyHidden: true };
  }
  return { effectiveVisible: true, temporarilyHidden: false };
}

export function nextReviewFileTreeActiveIdFromScroll({
  currentActiveFileId,
  candidateId,
  suppressed,
  pinnedTargetId = null,
}: {
  currentActiveFileId: string | null;
  candidateId: string | null;
  suppressed: boolean;
  pinnedTargetId?: string | null;
}): ReviewFileTreeActiveSyncResult {
  if (pinnedTargetId) {
    if (candidateId === pinnedTargetId) {
      return { activeFileId: pinnedTargetId, releasePin: true };
    }
    return { activeFileId: currentActiveFileId, releasePin: false };
  }
  if (suppressed || !candidateId) {
    return { activeFileId: currentActiveFileId, releasePin: false };
  }
  return { activeFileId: candidateId, releasePin: false };
}

export function findReviewFileTreeFileIndex(
  flatNodes: readonly ReviewFileTreeFlatNode[],
  activeFileId: string | null,
): number {
  if (!activeFileId) return -1;
  return flatNodes.findIndex((item) => item.node.type === 'file' && item.node.id === activeFileId);
}

export function moveReviewFileJumpSelection(
  currentIndex: number,
  direction: 1 | -1,
  resultCount: number,
): number {
  if (resultCount <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= resultCount) return direction > 0 ? 0 : resultCount - 1;
  return (currentIndex + direction + resultCount) % resultCount;
}

export function isReviewFileTreeScrollKey(key: string): boolean {
  return (
    key === 'ArrowDown' ||
    key === 'ArrowUp' ||
    key === 'PageDown' ||
    key === 'PageUp' ||
    key === 'Home' ||
    key === 'End' ||
    key === ' '
  );
}

export function nextReviewFileJumpPreciseScrollStep({
  targetStillPinned,
  rowMounted,
  attemptsLeft,
}: {
  targetStillPinned: boolean;
  rowMounted: boolean;
  attemptsLeft: number;
}): ReviewFileJumpPreciseScrollStep {
  if (!targetStillPinned) return { action: 'stop', nextAttemptsLeft: attemptsLeft };
  if (rowMounted) return { action: 'scroll', nextAttemptsLeft: attemptsLeft };
  if (attemptsLeft > 0) return { action: 'retry', nextAttemptsLeft: attemptsLeft - 1 };
  return { action: 'stop', nextAttemptsLeft: 0 };
}

export function getReviewDiffExpansionAction(
  diffIds: readonly string[],
  diffsExpanded: boolean,
): ReviewDiffExpansionToggleAction {
  if (diffIds.length === 0) return 'disabled';
  return diffsExpanded ? 'collapse' : 'expand';
}

function materializeDirectory(dir: MutableDirectory): ReviewFileTreeDirectoryNode {
  const directories = [...dir.directories.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(materializeDirectory);
  const files = dir.files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    type: 'directory',
    id: `dir:${dir.path}`,
    path: dir.path,
    name: dir.name,
    children: [...directories, ...files],
  };
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}
