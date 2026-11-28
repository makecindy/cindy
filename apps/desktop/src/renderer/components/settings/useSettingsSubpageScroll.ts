import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** Remember each parent before its content is replaced in the shared settings viewport. */
export function useSettingsSubpageScroll(
  scrollRef: RefObject<HTMLDivElement | null> | undefined,
  depth: number | null,
  searchActivation: number,
) {
  const parentOffsets = useRef<number[]>([]);
  const previousDepth = useRef(depth);

  // A fresh search owns the next scroll, including searches within an open detail.
  useLayoutEffect(() => { parentOffsets.current = []; }, [searchActivation]);

  useLayoutEffect(() => {
    if (previousDepth.current === depth) return;
    previousDepth.current = depth;
    if (depth === null) {
      parentOffsets.current = [];
      return;
    }
    const viewport = scrollRef?.current;
    const [offset = 0] = parentOffsets.current.splice(depth);
    if (!viewport) return;
    const previousAnchor = viewport.style.overflowAnchor;
    if (offset) viewport.style.overflowAnchor = 'none';
    viewport.scrollTop = offset;
    if (!offset) return;

    // Remounted settings can grow as their initial reads complete. Keep the
    // saved position through that layout, until the user takes over.
    const restore = () => { viewport.scrollTop = offset; };
    const observer = new ResizeObserver(restore);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    const inputs = ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const;
    const stop = () => {
      viewport.style.overflowAnchor = previousAnchor;
      observer.disconnect();
      window.clearTimeout(timeout);
      for (const type of inputs) document.removeEventListener(type, stop, true);
    };
    const timeout = window.setTimeout(stop, 1500);
    for (const type of inputs) document.addEventListener(type, stop, { passive: true, capture: true });
    return stop;
  }, [depth, scrollRef, searchActivation]);

  return useCallback(() => {
    if (depth !== null && scrollRef?.current) parentOffsets.current[depth] = scrollRef.current.scrollTop;
  }, [depth, scrollRef]);
}
