import { useCallback, useLayoutEffect, useRef, type MouseEvent, type RefObject } from 'react';

/** Release only the focus left by pointer navigation, after the destination is active.
 * Navigation can await route resolution: blurring on click would expose the old
 * task's permission card to keys intended for the destination. Keyboard activation
 * and any focus move during that wait cancel this handoff. The active signal
 * must describe the actual navigation destination, not file-view highlighting.
 */
export function usePointerNavigationFocus(
  ref: RefObject<HTMLDivElement | null>,
  isActive: boolean,
) {
  const pending = useRef(false);
  const cancel = useCallback(() => {
    pending.current = false;
  }, []);
  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const nested =
        event.target instanceof Element
          ? event.target.closest('button, a, input, select, textarea, [role="button"]')
          : null;
      pending.current =
        !isActive &&
        event.detail > 0 &&
        event.button === 0 &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        nested === event.currentTarget &&
        event.currentTarget.ownerDocument.activeElement === event.currentTarget;
    },
    [isActive],
  );

  useLayoutEffect(() => {
    if (!isActive || !pending.current) return;
    pending.current = false;
    const row = ref.current;
    if (row && row.ownerDocument.activeElement === row) row.blur();
  }, [isActive, ref]);

  return { onClick, cancel };
}
