/** Correct only the remaining displacement of a measured anchor. Native scroll
 * anchoring may already have moved the viewport; adding the height delta again
 * would double-compensate. Signed offsets also preserve space above an item. */
export function viewportAnchorCorrection(
  containerTop: number,
  anchorTop: number,
  offset: number,
): number {
  const delta = anchorTop - containerTop + offset;
  return Math.abs(delta) < 1 ? 0 : delta;
}

/** Navigation, paging and direct manipulation own their existing scroll paths. */
export function canCompensateMessageHeight(state: {
  restoring: boolean;
  nearBottom: boolean;
  programmatic: boolean;
  loadingMore: boolean;
  pendingPrepend: boolean;
  pendingUserScroll: boolean;
  dragging: boolean;
  expanding: boolean;
}): boolean {
  return !Object.values(state).some(Boolean);
}

/** A remembered size is only an offscreen estimate, never a fixed/minimum height. */
export function rememberedItemIntrinsicSize(
  height: number | undefined,
  measuredWidth: number | undefined,
  currentWidth: number,
): string | undefined {
  if (
    height === undefined ||
    !Number.isFinite(height) ||
    height <= 0 ||
    measuredWidth === undefined ||
    !Number.isFinite(measuredWidth) ||
    !Number.isFinite(currentWidth) ||
    currentWidth <= 0 ||
    Math.abs(measuredWidth - currentWidth) >= 1
  )
    return undefined;
  return `auto ${height}px`;
}

/** Null-rendering cards do not occupy a DOM index. Match the stable render key. */
export function findRenderItemElement(
  container: HTMLElement | null | undefined,
  key: string | undefined,
): HTMLElement | undefined {
  if (!container || !key) return undefined;
  return Array.from(container.children).find(
    (element) => element.getAttribute('data-render-item-key') === key,
  ) as HTMLElement | undefined;
}

/** Layout at the last successful restoration, in scroll-content coordinates. */
export interface RestoredScrollGeometry {
  anchor: HTMLElement;
  scrollTop: number;
  scrollHeight: number;
  width: number;
  height: number;
  anchorTop: number;
  anchorHeight: number;
}

export function measureRestoredScrollGeometry(
  container: HTMLElement,
  anchor: HTMLElement,
): RestoredScrollGeometry {
  const rect = anchor.getBoundingClientRect();
  return {
    anchor,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    width: container.clientWidth,
    height: container.clientHeight,
    anchorTop: rect.top - container.getBoundingClientRect().top + container.scrollTop,
    anchorHeight: rect.height,
  };
}

/** Cross-origin frames can chain scrolling without bubbling input events.
 * Yield only after positioning has settled and without a layout change; native
 * intrinsic-size corrections still belong to the restoration path. */
export function isRestoredScrollTakeover(
  container: HTMLElement,
  previous: RestoredScrollGeometry | null,
  settled: boolean,
  programmatic: boolean,
): boolean {
  if (!settled || programmatic || !previous || !container.contains(previous.anchor)) return false;
  if (Math.abs(container.scrollTop - previous.scrollTop) < 1) return false;
  const current = measureRestoredScrollGeometry(container, previous.anchor);
  return current.scrollHeight === previous.scrollHeight
    && current.width === previous.width
    && current.height === previous.height
    && Math.abs(current.anchorTop - previous.anchorTop) < 1
    && Math.abs(current.anchorHeight - previous.anchorHeight) < 1;
}
