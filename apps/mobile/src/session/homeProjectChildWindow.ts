export interface HomeProjectChildWindowRange {
  end: number;
  leadingSpacerHeight: number;
  start: number;
  trailingSpacerHeight: number;
}

export function shouldWindowHomeProjectChildren(input: {
  collapsed: boolean;
  itemCount: number;
  scrollTrackingAvailable: boolean;
  threshold: number;
}): boolean {
  return input.scrollTrackingAvailable
    && !input.collapsed
    && input.itemCount > Math.max(0, Math.floor(input.threshold));
}

/**
 * Builds stable child offsets for a project block. Keeping the full height in
 * spacers lets the outer SectionList preserve exactly the same layout while
 * only mounting the nearby rows.
 */
export function buildHomeProjectChildOffsets(rowHeights: readonly number[]): number[] {
  const offsets = [0];
  for (const height of rowHeights) {
    const safeHeight = Number.isFinite(height) && height > 0 ? height : 0;
    offsets.push(offsets[offsets.length - 1] + safeHeight);
  }
  return offsets;
}

/** Returns the child containing the supplied offset, using O(log n) lookup. */
export function findHomeProjectChildIndex(
  childOffsets: readonly number[],
  relativeOffset: number,
): number {
  'worklet';
  const itemCount = Math.max(0, childOffsets.length - 1);
  if (itemCount === 0) return 0;
  const target = Math.max(0, relativeOffset);
  let low = 0;
  let high = itemCount - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (childOffsets[middle + 1] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Keeps a large nested group as a spacer until its child area intersects the
 * viewport. This prevents an off-screen folder header from eagerly mounting a
 * complete child window during a grouping-mode switch.
 */
export function resolveHomeProjectChildAnchor(input: {
  childOffsets: readonly number[];
  projectHeaderHeight: number;
  projectTop: number;
  shift: number;
  viewportHeight: number;
  viewportTop: number;
}): number {
  'worklet';
  const childContentHeight = Math.max(0, input.childOffsets[input.childOffsets.length - 1] ?? 0);
  const childTop = input.projectTop + Math.max(0, input.projectHeaderHeight);
  const childBottom = childTop + childContentHeight;
  const viewportTop = Math.max(0, input.viewportTop);
  const viewportBottom = viewportTop + Math.max(0, input.viewportHeight);
  if (childContentHeight === 0 || childTop >= viewportBottom || childBottom <= viewportTop) {
    return -1;
  }
  const shift = Math.max(1, Math.floor(input.shift));
  const relativeY = Math.max(0, viewportTop - childTop);
  const visibleIndex = findHomeProjectChildIndex(input.childOffsets, relativeY);
  return Math.floor(visibleIndex / shift) * shift;
}

export function resolveHomeProjectChildWindow(input: {
  anchor: number;
  childOffsets: readonly number[];
  overscan: number;
  windowSize: number;
}): HomeProjectChildWindowRange {
  const itemCount = Math.max(0, input.childOffsets.length - 1);
  if (itemCount === 0) {
    return { end: 0, leadingSpacerHeight: 0, start: 0, trailingSpacerHeight: 0 };
  }
  const overscan = Math.max(0, Math.floor(input.overscan));
  const windowSize = Math.max(1, Math.floor(input.windowSize));
  const maxStart = Math.max(0, itemCount - windowSize);
  const start = Math.max(0, Math.min(maxStart, Math.floor(input.anchor) - overscan));
  const end = Math.min(itemCount, start + windowSize + overscan * 2);
  const totalHeight = input.childOffsets[itemCount] ?? 0;
  return {
    end,
    leadingSpacerHeight: input.childOffsets[start] ?? 0,
    start,
    trailingSpacerHeight: Math.max(0, totalHeight - (input.childOffsets[end] ?? totalHeight)),
  };
}
