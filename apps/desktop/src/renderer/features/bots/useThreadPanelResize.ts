import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

function readStoredWidth(storageKey: string | undefined): number | null {
  if (!storageKey) return null;
  try {
    const value = Number(localStorage.getItem(storageKey));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(storageKey: string | undefined, width: number): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, String(Math.round(width)));
  } catch {
    // Storage can be unavailable (for example a restricted profile); the in-memory width still works.
  }
}

/**
 * View-only sizing: keep the current CSS default until the reader actually resizes.
 * With a storage key the last width is restored on the next mount, so switching away from a
 * companion and back does not reset it.
 */
export function useThreadPanelResize(
  layoutRef: RefObject<HTMLDivElement | null>,
  rootId: string | null,
  cancelOpening: () => void,
  options: { storageKey?: string } = {},
) {
  const { storageKey } = options;
  const [preferredWidth, setPreferredWidth] = useState<number | null>(() => readStoredWidth(storageKey));
  const preferredWidthRef = useRef(preferredWidth);
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
  const minWidth = Math.min(280, availableWidth / 2);
  const maxWidth = availableWidth - Math.min(400, availableWidth / 2);
  const clamp = (width: number) => Math.min(maxWidth, Math.max(minWidth, width));
  // A restored width cannot be clamped before the layout has been measured.
  const width = preferredWidth === null || availableWidth <= 0 ? undefined : clamp(preferredWidth);
  const updateWidth = (next: number) => {
    preferredWidthRef.current = next;
    setPreferredWidth(next);
  };

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
    updateWidth(clamp(current.width + current.startX - event.clientX));
  };
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setIsDragging(false);
    const latest = preferredWidthRef.current;
    if (latest !== null) storeWidth(storageKey, latest);
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
    const next = clamp(panel.getBoundingClientRect().width + step);
    updateWidth(next);
    storeWidth(storageKey, next);
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
