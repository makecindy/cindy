import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { normalizeSize } from './layout';
import type { DagSize } from './types';

export type CardBoxProps = { size?: DagSize; resizeHandle?: ReactNode };

type Props = { size: DagSize; preview: (s: DagSize | null) => void; finish: (s: DagSize) => void };

/** Preview locally during capture. Only a completed gesture is a canvas edit. */
export function DagResizeHandle({ size, preview, finish }: Props) {
  const active = useRef<{ id: number; x: number; y: number; k: number; start: DagSize } | null>(
    null,
  );
  const [captured, setCaptured] = useState(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => {
    if (!captured) return;
    const cancel = () => {
      if (!active.current) return;
      active.current = null;
      setCaptured(false);
      previewRef.current(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape);
      cancel();
    };
  }, [captured]);
  const changed = (e: PointerEvent) => {
    const p = active.current;
    if (!p || p.id !== e.pointerId) return null;
    return normalizeSize({
      width: p.start.width + (e.clientX - p.x) / p.k,
      height: p.start.height + (e.clientY - p.y) / p.k,
    });
  };
  return (
    <button
      type="button"
      data-dag-resize
      aria-label="调整卡片大小"
      title="拖动调整卡片大小，或用方向键微调"
      className="absolute bottom-0 right-0 z-[1] grid size-5 touch-none cursor-nwse-resize select-none place-items-end rounded-br-[inherit] text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2"
      onPointerDown={(e) => {
        if (e.button !== 0 || active.current) return;
        e.preventDefault();
        e.stopPropagation();
        const surface = e.currentTarget.closest<HTMLElement>('[data-dag-scale]');
        active.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          k: Number(surface?.dataset.dagScale) || 1,
          start: size,
        };
        setCaptured(true);
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const next = changed(e);
        if (next) preview(next);
      }}
      onPointerUp={(e) => {
        const next = changed(e);
        if (!next) return;
        active.current = null;
        setCaptured(false);
        preview(null);
        finish(next);
      }}
      onLostPointerCapture={(e) => {
        if (active.current?.id === e.pointerId) {
          active.current = null;
          setCaptured(false);
          preview(null);
        }
      }}
      onPointerCancel={(e) => {
        if (active.current?.id === e.pointerId) {
          active.current = null;
          setCaptured(false);
          preview(null);
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const delta = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[e.key];
        if (!delta || active.current) return;
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 32 : 8;
        finish(
          normalizeSize({
            width: size.width + delta[0] * step,
            height: size.height + delta[1] * step,
          }),
        );
      }}
    >
      <svg
        aria-hidden="true"
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <path d="M3 12L12 3M8 12L12 8" />
      </svg>
    </button>
  );
}
