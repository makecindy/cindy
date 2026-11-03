import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

/** View-only sizing: keep the current CSS default until the reader actually resizes. */
export function useThreadPanelResize(
  layoutRef: RefObject<HTMLDivElement | null>,
  rootId: string | null,
  cancelOpening: () => void,
) {
  const [preferredWidth, setPreferredWidth] = useState<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; width: number } | null>(null);

  useLayoutEffect(() => {
    drag.current = null;
    setIsDragging(false);
    const layout = layoutRef.current;
    if (!rootId || !layout) return;
    const measure = () => setAvailableWidth(layout.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    return () => observer.disconnect();
  }, [layoutRef, rootId]);

  // At narrow widths retain two columns, rather than introducing another layout.
  const minWidth = Math.min(280, availableWidth * 0.4);
  const maxWidth = availableWidth - Math.min(400, availableWidth * 0.4);
  const clamp = (width: number) => Math.min(maxWidth, Math.max(minWidth, width));
  const width = preferredWidth === null ? undefined : clamp(preferredWidth);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || availableWidth <= 0) return;
    const panel = event.currentTarget.parentElement;
    if (!panel || panel.inert) return;
    event.preventDefault();
    cancelOpening();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      width: panel.getBoundingClientRect().width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || event.currentTarget.parentElement?.inert) return;
    setPreferredWidth(clamp(current.width + current.startX - event.clientX));
  };
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const panel = event.currentTarget.parentElement;
    if (!panel || panel.inert || availableWidth <= 0) return;
    event.preventDefault();
    cancelOpening();
    const step = event.key === 'ArrowLeft' ? 16 : -16;
    setPreferredWidth(clamp(panel.getBoundingClientRect().width + step));
  };

  return {
    width,
    isDragging,
    handleProps: {
      'aria-valuemin': Math.round(minWidth),
      'aria-valuemax': Math.round(maxWidth),
      'aria-valuenow': Math.round(width ?? Math.min(availableWidth / 2, 448)),
      onPointerDown,
      onPointerMove,
      onPointerUp: stopDragging,
      onPointerCancel: stopDragging,
      onLostPointerCapture: stopDragging,
      onKeyDown,
    },
  };
}

export type ThreadPanelResize = ReturnType<typeof useThreadPanelResize>;
