/**
 * Keep task-switch prefetch limited to an intentional mouse primary click on
 * an inactive, non-editing row. Touch scrolling and modifier clicks belong to
 * navigation/selection gestures, while secondary buttons inside a row stop
 * propagation before reaching the row.
 */
export function shouldPrefetchSessionOnPointerDown(
  event: Pick<
    PointerEvent,
    'button' | 'pointerType' | 'shiftKey' | 'metaKey' | 'ctrlKey'
  >,
  opts: { isActive: boolean; isEditing: boolean },
): boolean {
  return (
    !opts.isActive &&
    !opts.isEditing &&
    event.pointerType === 'mouse' &&
    event.button === 0 &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey
  );
}
