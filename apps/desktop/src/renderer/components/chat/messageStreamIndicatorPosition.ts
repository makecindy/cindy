const DEFAULT_BOTTOM_PADDING_PX = 200;
const LEGACY_STATUS_ROW_OFFSET_PX = 56;
const MIN_BOTTOM_OFFSET_PX = 12;
const COMPOSER_GAP_PX = 6;

export function resolveMessageStreamIndicatorBottomOffset({
  bottomPadding,
  composerStackTopOffset,
}: {
  bottomPadding?: number;
  composerStackTopOffset?: number;
}): number {
  if (composerStackTopOffset != null) return composerStackTopOffset + COMPOSER_GAP_PX;

  const resolvedBottomPadding = bottomPadding ?? DEFAULT_BOTTOM_PADDING_PX;
  return Math.max(resolvedBottomPadding - LEGACY_STATUS_ROW_OFFSET_PX, MIN_BOTTOM_OFFSET_PX);
}

export function measureComposerStackTopOffset(overlayEl: HTMLElement): number | undefined {
  const composerStack = overlayEl.querySelector<HTMLElement>('[data-chat-composer-stack]');
  if (!composerStack) return undefined;

  return overlayEl.getBoundingClientRect().bottom - composerStack.getBoundingClientRect().top;
}
