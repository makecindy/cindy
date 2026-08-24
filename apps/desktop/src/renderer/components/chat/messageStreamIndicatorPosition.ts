const DEFAULT_BOTTOM_PADDING_PX = 200;
const LEGACY_STATUS_ROW_OFFSET_PX = 56;
const MIN_BOTTOM_OFFSET_PX = 12;
const COMPOSER_GAP_PX = 6;

const COMPOSER_STACK_SELECTOR = '[data-chat-composer-stack]';
const COMPOSER_CENTER_GROUP_SELECTOR = '[data-composer-center-group]';

export function resolveMessageStreamIndicatorBottomOffset({
  bottomPadding,
  bottomCenterClearanceOffset,
}: {
  bottomPadding?: number;
  bottomCenterClearanceOffset?: number;
}): number {
  if (bottomCenterClearanceOffset != null) return bottomCenterClearanceOffset + COMPOSER_GAP_PX;

  const resolvedBottomPadding = bottomPadding ?? DEFAULT_BOTTOM_PADDING_PX;
  return Math.max(resolvedBottomPadding - LEGACY_STATUS_ROW_OFFSET_PX, MIN_BOTTOM_OFFSET_PX);
}

/**
 * Measure the topmost occupied layer in the composer's bottom-center lane.
 *
 * The running-status row deliberately does not move message navigation: its
 * left/right text leaves the center lane free. Pinned plans and the expanded
 * controlled banner do occupy that lane, so the jump/new-message pill must
 * stack above them instead of sharing their 32px band.
 */
export function measureMessageStreamIndicatorClearanceOffset(
  overlayEl: HTMLElement,
): number | undefined {
  const composerStack = overlayEl.querySelector<HTMLElement>(COMPOSER_STACK_SELECTOR);
  if (!composerStack) return undefined;

  let clearanceTop = composerStack.getBoundingClientRect().top;
  const centerGroup = overlayEl.querySelector<HTMLElement>(COMPOSER_CENTER_GROUP_SELECTOR);
  if (centerGroup && centerGroup.childElementCount > 0) {
    const centerGroupRect = centerGroup.getBoundingClientRect();
    if (centerGroupRect.height > 0) clearanceTop = Math.min(clearanceTop, centerGroupRect.top);
  }

  return overlayEl.getBoundingClientRect().bottom - clearanceTop;
}

/**
 * The center group can gain or lose a plan while the outer overlay keeps the
 * same height (the running-status row already owns that grid row). Observe the
 * inner geometry as well so the clearance is refreshed in that case.
 */
export function getMessageStreamIndicatorResizeTargets(overlayEl: HTMLElement): HTMLElement[] {
  const targets = [overlayEl];
  const composerStack = overlayEl.querySelector<HTMLElement>(COMPOSER_STACK_SELECTOR);
  const centerGroup = overlayEl.querySelector<HTMLElement>(COMPOSER_CENTER_GROUP_SELECTOR);
  if (composerStack) targets.push(composerStack);
  if (centerGroup) targets.push(centerGroup);
  return targets;
}
