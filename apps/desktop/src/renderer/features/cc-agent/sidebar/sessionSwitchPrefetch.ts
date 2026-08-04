/**
 * Keep task-switch prefetch limited to an intentional primary click on an
 * inactive, non-editing row. Modifier clicks belong to range/multi-select and
 * secondary buttons inside a row stop propagation before reaching the row.
 */
export function shouldPrefetchSessionOnPointerDown(
  event: Pick<
    PointerEvent,
    'button' | 'shiftKey' | 'metaKey' | 'ctrlKey'
  >,
  opts: { isActive: boolean; isEditing: boolean },
): boolean {
  return (
    !opts.isActive &&
    !opts.isEditing &&
    event.button === 0 &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey
  );
}
