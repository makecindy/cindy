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
