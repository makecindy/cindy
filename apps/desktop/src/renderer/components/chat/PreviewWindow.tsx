import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';
import { PREVIEW_PANEL_CLASS, usePreviewFocusReturn } from './PreviewChrome';
import {
  clampPreviewWindowRect,
  initialPreviewWindowRect,
  movePreviewWindowRect,
  previewWindowStyle,
  readPreviewWindowViewport,
  resizePreviewWindowRect,
  PREVIEW_WINDOW_HEADER_HEIGHT,
  type PreviewWindowRect,
} from './previewWindowGeometry';

/**
 * Shared non-modal shell for Desktop attachment previews.
 *
 * The portal layer spans the viewport but is `pointer-events: none`, so the
 * conversation behind it stays readable, scrollable, selectable and editable.
 * Only the floating panel takes pointer events. There is no scrim, no scroll
 * lock and no Tab trap: focus still enters the window on open and returns to
 * the opener on close, but ordinary Tab traversal reaches the message bar
 * (DESIGN.md §14.2). The header's blank area and its grip drag the window; the
 * bottom-right corner resizes it. Closing stays with each viewer's own button,
 * Escape, or an optional click on the panel's bare background — clicking the
 * conversation never closes the preview.
 */
export type PreviewWindowAttrs = HTMLAttributes<HTMLDivElement> & {
  [key: `data-${string}`]: unknown;
};

export interface PreviewWindowProps {
  children: ReactNode;
  /** Accessible name of the non-modal dialog. */
  ariaLabel: string;
  /** Centered 480×360 surface for files that cannot be rendered. */
  compact?: boolean;
  /** Extra height for compact windows with a collection footer. */
  extraHeight?: number;
  /** Focus this element on open instead of the window itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Let FocusScope focus the first toolbar control (document previews). */
  focusFirstOnOpen?: boolean;
  /** Callers that gate keyboard shortcuts on the foreground layer. */
  panelRef?: Ref<HTMLDivElement>;
  /** Click on the panel's bare background closes; children keep their clicks. */
  onBackgroundClick?: () => void;
  className?: string;
  style?: CSSProperties;
  /** Attributes on the full-viewport portal layer (existing data-* consumers). */
  layerAttrs?: PreviewWindowAttrs;
  /** Attributes on the floating panel (existing data-* consumers, handlers). */
  panelAttrs?: PreviewWindowAttrs;
}

type Gesture = {
  kind: 'move' | 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  rect: PreviewWindowRect;
};

const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="menu"], [contenteditable="true"], [data-preview-window-resize-handle]';

export function PreviewWindow({
  children,
  ariaLabel,
  compact = false,
  extraHeight = 0,
  initialFocusRef,
  focusFirstOnOpen = false,
  panelRef,
  onBackgroundClick,
  className,
  style,
  layerAttrs,
  panelAttrs,
}: PreviewWindowProps) {
  const restorePreviewFocus = usePreviewFocusReturn();
  const [rect, setRect] = useState<PreviewWindowRect>(() =>
    initialPreviewWindowRect(readPreviewWindowViewport(), { compact, extraHeight }),
  );
  const panelNode = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const releaseGesture = useRef<(() => void) | null>(null);
  const geometryKey = useRef(`${compact}:${extraHeight}`);

  const setPanelNode = useCallback(
    (node: HTMLDivElement | null) => {
      panelNode.current = node;
      if (typeof panelRef === 'function') panelRef(node);
      else if (panelRef) (panelRef as { current: HTMLDivElement | null }).current = node;
    },
    [panelRef],
  );

  useEffect(() => {
    const onResize = () =>
      setRect((current) => clampPreviewWindowRect(current, readPreviewWindowViewport()));
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      releaseGesture.current?.();
      releaseGesture.current = null;
    };
  }, []);

  // FileLightbox learns whether a file is renderable only after its content is
  // read; switching to the compact surface must re-initialize the geometry.
  useEffect(() => {
    const key = `${compact}:${extraHeight}`;
    if (geometryKey.current === key) return;
    geometryKey.current = key;
    setRect(initialPreviewWindowRect(readPreviewWindowViewport(), { compact, extraHeight }));
  }, [compact, extraHeight]);

  const beginGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, kind: Gesture['kind']) => {
      if (event.button !== 0 || gesture.current) return;
      const target = event.target as HTMLElement;
      if (kind === 'move' && target.closest(INTERACTIVE_SELECTOR)) return;
      const session: Gesture = {
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        rect,
      };
      gesture.current = session;
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== session.pointerId || !gesture.current) return;
        const dx = move.clientX - session.startX;
        const dy = move.clientY - session.startY;
        const viewport = readPreviewWindowViewport();
        setRect(
          session.kind === 'move'
            ? movePreviewWindowRect(session.rect, dx, dy, viewport)
            : resizePreviewWindowRect(session.rect, dx, dy, viewport),
        );
      };
      const end = (up: PointerEvent) => {
        if (up.pointerId !== session.pointerId) return;
        gesture.current = null;
        releaseGesture.current?.();
        releaseGesture.current = null;
      };
      const release = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      releaseGesture.current = release;
      event.preventDefault();
    },
    [rect],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    panelAttrs?.onPointerDown?.(event);
    if (event.defaultPrevented) return;
    const bounds = panelNode.current?.getBoundingClientRect();
    const inHeader =
      bounds !== undefined && event.clientY - bounds.top <= PREVIEW_WINDOW_HEADER_HEIGHT;
    if (inHeader) beginGesture(event, 'move');
  };

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    panelAttrs?.onClick?.(event);
    if (!event.defaultPrevented && onBackgroundClick && event.target === event.currentTarget)
      onBackgroundClick();
  };

  return createPortal(
    <div
      data-preview-window-layer
      {...layerAttrs}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: Z_INDEX_LAYERS.fullscreen,
        ...layerAttrs?.style,
      }}
    >
      <FocusScope
        asChild
        trapped={false}
        loop={false}
        onMountAutoFocus={(event) => {
          if (focusFirstOnOpen && !initialFocusRef) return;
          event.preventDefault();
          (initialFocusRef?.current ?? panelNode.current)?.focus();
        }}
        onUnmountAutoFocus={restorePreviewFocus}
      >
        <div
          {...panelAttrs}
          ref={setPanelNode}
          data-preview-window-panel
          data-lightbox-layer
          role="dialog"
          aria-modal={false}
          aria-label={ariaLabel}
          tabIndex={-1}
          className={cn(PREVIEW_PANEL_CLASS, className, panelAttrs?.className)}
          style={{
            ...previewWindowStyle(rect),
            ...WINDOW_NO_DRAG_STYLE,
            ...style,
            ...panelAttrs?.style,
          }}
          onPointerDown={handlePointerDown}
          onClick={handleClick}
        >
          {children}
          {/* Muted grip: no new copy, and no drag of the OS window. */}
          <div
            data-preview-window-drag-handle
            aria-hidden="true"
            className="absolute left-0 top-0 flex items-center justify-center select-none text-[var(--text-tertiary)]"
            style={{
              width: 24,
              height: PREVIEW_WINDOW_HEADER_HEIGHT,
              cursor: 'grab',
              touchAction: 'none',
              zIndex: Z_INDEX_LAYERS.raised + 1,
              ...WINDOW_NO_DRAG_STYLE,
            }}
          >
            <GripVertical className="h-4 w-4" />
          </div>
          <div
            data-preview-window-resize-handle
            aria-hidden="true"
            className="absolute bottom-0 right-0 select-none"
            style={{
              width: 18,
              height: 18,
              cursor: 'nwse-resize',
              touchAction: 'none',
              zIndex: Z_INDEX_LAYERS.raised + 1,
              ...WINDOW_NO_DRAG_STYLE,
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              beginGesture(event, 'resize');
            }}
          >
            <div
              style={{
                position: 'absolute',
                right: 4,
                bottom: 4,
                width: 8,
                height: 8,
                borderRight: '2px solid var(--text-tertiary)',
                borderBottom: '2px solid var(--text-tertiary)',
                opacity: 0.6,
              }}
            />
          </div>
        </div>
      </FocusScope>
    </div>,
    document.body,
  );
}
