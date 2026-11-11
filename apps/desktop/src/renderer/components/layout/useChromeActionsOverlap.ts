import { useLayoutEffect, useRef, useState } from 'react';

/** Each clipped drag header owns the part of window chrome over its actual box. */
export function useChromeActionsOverlap<T extends HTMLElement>(
  enabled: boolean,
  rightEdge: number,
) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  // A React layout/reorder can move the box without resizing it.
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!enabled || !rect || rect.width <= 0) return;
    setWidth(rect.top < 46 && rect.bottom > 0 ? Math.max(0, rightEdge - rect.left) : 0);
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0) {
        setWidth(rect.top < 46 && rect.bottom > 0 ? Math.max(0, rightEdge - rect.left) : 0);
      }
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    const observePosition = () => {
      observer?.disconnect();
      // A preceding pane/sidebar can move this header without resizing the header.
      for (let node: Element | null = element; node; node = node.parentElement) {
        observer?.observe(node);
        for (
          let sibling = node.previousElementSibling;
          sibling;
          sibling = sibling.previousElementSibling
        ) {
          observer?.observe(sibling);
        }
      }
      measure();
    };
    let frame: number | undefined;
    const onLayoutChange = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(observePosition);
    };
    observePosition();
    window.addEventListener('resize', measure);
    const unsubscribe = window.electronAPI?.layout?.onChanged?.(onLayoutChange);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      if (frame !== undefined) cancelAnimationFrame(frame);
      unsubscribe?.();
    };
  }, [enabled, rightEdge]);

  return { ref, width: enabled ? width : null };
}
