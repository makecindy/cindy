/**
 * 图片预览浮窗几何与手势
 * ---------------------------------------------------------------------------
 * 只服务 ImageLightbox:图片预览默认是贴右的非模态浮窗,让消息正文继续可读、
 * 可滚动、可选中。标题栏拖动整个浮窗、右下角调整尺寸、贴左/贴右/居中快捷动作
 * 都共用这里的纯几何函数;放大后图片内容的平移仍在 ImageLightbox 内,互不抢事件。
 *
 * 所有矩形都按当前浏览器视口夹取。顶部保留 PREVIEW_PANEL_MARGIN,避开 Electron
 * 顶部窗口拖拽区;窄到 320px 时退化为视口内的小浮窗,不产生横向溢出。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PREVIEW_PANEL_MARGIN } from './PreviewChrome';

export type PreviewDockMode = 'left' | 'right' | 'center';
export type PreviewWindowMode = PreviewDockMode | 'free';
export type PreviewResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface PreviewWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewViewport {
  width: number;
  height: number;
}

const EDGE_GUTTER = 16;
const MIN_WIDTH = 288;
const MIN_HEIGHT = 240;
const MAX_SIDE_WIDTH = 720;
const MAX_CENTER_WIDTH = 1440;
const SIDE_WIDTH_RATIO = 0.44;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function gutterFor(viewport: PreviewViewport): number {
  return Math.min(EDGE_GUTTER, Math.max(4, Math.floor(viewport.width / 40)));
}

function minWidthFor(viewport: PreviewViewport): number {
  return Math.min(MIN_WIDTH, Math.max(1, viewport.width - gutterFor(viewport) * 2));
}

function minHeightFor(viewport: PreviewViewport): number {
  return Math.min(
    MIN_HEIGHT,
    Math.max(1, viewport.height - PREVIEW_PANEL_MARGIN - gutterFor(viewport)),
  );
}

function maxWidthFor(viewport: PreviewViewport): number {
  return Math.max(1, viewport.width - gutterFor(viewport) * 2);
}

function maxHeightFor(viewport: PreviewViewport): number {
  return Math.max(1, viewport.height - PREVIEW_PANEL_MARGIN - gutterFor(viewport));
}

export function readPreviewViewport(): PreviewViewport {
  return {
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  };
}

/** 把任意矩形夹在视口内;宽高先收敛,再据此夹左上角。 */
export function clampPreviewRect(
  rect: PreviewWindowRect,
  viewport: PreviewViewport,
): PreviewWindowRect {
  const gutter = gutterFor(viewport);
  const width = clamp(rect.width, minWidthFor(viewport), maxWidthFor(viewport));
  const height = clamp(rect.height, minHeightFor(viewport), maxHeightFor(viewport));
  return {
    x: clamp(rect.x, gutter, viewport.width - width - gutter),
    y: clamp(rect.y, PREVIEW_PANEL_MARGIN, viewport.height - height - gutter),
    width,
    height,
  };
}

/** 三种预设位置。贴左/贴右只占约 44% 宽度,居中用于主动展开大图。 */
export function dockPreviewRect(
  mode: PreviewDockMode,
  viewport: PreviewViewport,
): PreviewWindowRect {
  const gutter = gutterFor(viewport);
  const maxWidth = maxWidthFor(viewport);
  const sideWidth = Math.min(
    MAX_SIDE_WIDTH,
    Math.max(minWidthFor(viewport), Math.round(viewport.width * SIDE_WIDTH_RATIO)),
  );
  const height = Math.max(minHeightFor(viewport), maxHeightFor(viewport));
  if (mode === 'center') {
    const width = Math.min(MAX_CENTER_WIDTH, maxWidth);
    return clampPreviewRect(
      { x: (viewport.width - width) / 2, y: PREVIEW_PANEL_MARGIN, width, height },
      viewport,
    );
  }
  const width = Math.min(sideWidth, maxWidth);
  const x = mode === 'left' ? gutter : viewport.width - width - gutter;
  return clampPreviewRect({ x, y: PREVIEW_PANEL_MARGIN, width, height }, viewport);
}

/** 从八个方向之一调整尺寸;最终仍由 clampPreviewRect 保证不越界。 */
export function resizePreviewRect(
  start: PreviewWindowRect,
  direction: PreviewResizeDirection,
  dx: number,
  dy: number,
  viewport: PreviewViewport,
): PreviewWindowRect {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  let { x, y, width, height } = start;
  if (direction.includes('e')) width = start.width + dx;
  if (direction.includes('s')) height = start.height + dy;
  if (direction.includes('w')) {
    x = start.x + dx;
    width = right - x;
  }
  if (direction.includes('n')) {
    y = start.y + dy;
    height = bottom - y;
  }
  return clampPreviewRect({ x, y, width, height }, viewport);
}

interface PreviewWindowGesture {
  kind: 'drag' | 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  startRect: PreviewWindowRect;
  viewport: PreviewViewport;
  direction?: PreviewResizeDirection;
  moved: boolean;
}

type FrameHandle = number;

function scheduleFrame(callback: () => void): FrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 0) as unknown as FrameHandle;
}

function cancelFrame(handle: FrameHandle): void {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle);
    return;
  }
  window.clearTimeout(handle);
}

/**
 * 持有浮窗矩形与手势状态。拖动过程用 rAF 合并 state 写入,避免每个 pointermove
 * 都让整张图重排;松手前同步提交最后一帧,视觉位置与 React 状态不脱节。
 */
export function useImagePreviewWindow(options: {
  onGestureEnd?: (moved: boolean) => void;
} = {}) {
  const onGestureEndRef = useRef(options.onGestureEnd);
  onGestureEndRef.current = options.onGestureEnd;
  const [mode, setMode] = useState<PreviewWindowMode>('right');
  const [rect, setRect] = useState<PreviewWindowRect>(() =>
    dockPreviewRect('right', readPreviewViewport()),
  );
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const gestureRef = useRef<PreviewWindowGesture | null>(null);
  const frameRef = useRef<FrameHandle | null>(null);
  const pendingRectRef = useRef<PreviewWindowRect | null>(null);
  const captureTargetRef = useRef<HTMLElement | null>(null);

  const applyRectNow = useCallback((next: PreviewWindowRect) => {
    rectRef.current = next;
    setRect(next);
  }, []);

  const cancelPendingFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingRectRef.current = null;
  }, []);

  const scheduleRect = useCallback(
    (next: PreviewWindowRect) => {
      pendingRectRef.current = next;
      if (frameRef.current !== null) return;
      frameRef.current = scheduleFrame(() => {
        frameRef.current = null;
        const pending = pendingRectRef.current;
        pendingRectRef.current = null;
        if (pending) applyRectNow(pending);
      });
    },
    [applyRectNow],
  );

  const releasePointerCapture = useCallback((pointerId: number) => {
    const target = captureTargetRef.current;
    captureTargetRef.current = null;
    if (!target) return;
    try {
      if (typeof target.hasPointerCapture !== 'function' || target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture?.(pointerId);
      }
    } catch {
      // A detached handle or stale pointer id cannot keep a gesture alive.
    }
  }, []);

  const endGesture = useCallback(
    (pointerId?: number) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (pointerId !== undefined && gesture.pointerId !== pointerId) return;
      gestureRef.current = null;
      releasePointerCapture(gesture.pointerId);
      if (frameRef.current !== null) {
        cancelFrame(frameRef.current);
        frameRef.current = null;
      }
      const pending = pendingRectRef.current;
      pendingRectRef.current = null;
      if (pending) applyRectNow(pending);
      if (gesture.moved) onGestureEndRef.current?.(true);
    },
    [applyRectNow, releasePointerCapture],
  );

  const onLostPointerCapture = useCallback(
    (event: Event) => {
      endGesture((event as PointerEvent).pointerId);
    },
    [endGesture],
  );

  const capturePointer = useCallback(
    (target: EventTarget | null, pointerId: number) => {
      if (!(target instanceof HTMLElement) || typeof target.setPointerCapture !== 'function') return;
      try {
        target.setPointerCapture(pointerId);
        captureTargetRef.current = target;
      } catch {
        // Pointer capture is best-effort; window pointerup/cancel/blur still end the gesture.
      }
    },
    [],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) gesture.moved = true;
      const next =
        gesture.kind === 'drag'
          ? clampPreviewRect(
              {
                ...gesture.startRect,
                x: gesture.startRect.x + dx,
                y: gesture.startRect.y + dy,
              },
              gesture.viewport,
            )
          : resizePreviewRect(
              gesture.startRect,
              gesture.direction ?? 'se',
              dx,
              dy,
              gesture.viewport,
            );
      scheduleRect(next);
    };
    const onUp = (event: PointerEvent) => endGesture(event.pointerId);
    const onBlur = () => endGesture();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('lostpointercapture', onLostPointerCapture);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('lostpointercapture', onLostPointerCapture);
      window.removeEventListener('blur', onBlur);
      cancelPendingFrame();
    };
  }, [cancelPendingFrame, endGesture, onLostPointerCapture, scheduleRect]);

  useEffect(() => {
    const onResize = () => {
      cancelPendingFrame();
      gestureRef.current = null;
      const viewport = readPreviewViewport();
      const currentMode = modeRef.current;
      const next =
        currentMode === 'free'
          ? clampPreviewRect(rectRef.current, viewport)
          : dockPreviewRect(currentMode, viewport);
      applyRectNow(next);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [applyRectNow, cancelPendingFrame]);

  const startDrag = useCallback(
    (clientX: number, clientY: number, pointerId: number, target: EventTarget | null) => {
      cancelPendingFrame();
      gestureRef.current = {
        kind: 'drag',
        pointerId,
        startX: clientX,
        startY: clientY,
        startRect: rectRef.current,
        viewport: readPreviewViewport(),
        moved: false,
      };
      setMode('free');
      capturePointer(target, pointerId);
    },
    [cancelPendingFrame, capturePointer],
  );

  const startResize = useCallback(
    (
      clientX: number,
      clientY: number,
      pointerId: number,
      direction: PreviewResizeDirection,
      target: EventTarget | null,
    ) => {
      cancelPendingFrame();
      gestureRef.current = {
        kind: 'resize',
        pointerId,
        startX: clientX,
        startY: clientY,
        startRect: rectRef.current,
        viewport: readPreviewViewport(),
        direction,
        moved: false,
      };
      setMode('free');
      capturePointer(target, pointerId);
    },
    [cancelPendingFrame, capturePointer],
  );

  const dock = useCallback(
    (next: PreviewDockMode) => {
      cancelPendingFrame();
      gestureRef.current = null;
      const nextRect = dockPreviewRect(next, readPreviewViewport());
      applyRectNow(nextRect);
      setMode(next);
    },
    [applyRectNow, cancelPendingFrame],
  );

  return { rect, mode, dock, startDrag, startResize };
}
