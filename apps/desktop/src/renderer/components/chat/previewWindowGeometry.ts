import type { CSSProperties } from 'react';

/** Matches `PreviewChrome.PREVIEW_PANEL_MARGIN`: that strip is OS window chrome. */
const TOP_MARGIN = 40;

/**
 * Geometry for the Desktop attachment preview window. This module is pure: no
 * DOM, no persistence and no timers. Every viewer that uses `PreviewWindow`
 * shares these numbers, so dragging and resizing behave the same for documents,
 * media, diagrams and payloads (DESIGN.md §4 / §14).
 *
 * A normal window docks to the right at ~44% of the viewport: the conversation
 * column stays visible, scrollable and selectable behind it. `TOP_MARGIN`
 * keeps the top strip (native traffic lights / OS window drag) clear. Compact
 * windows are the existing 480×360 centered surface for files we cannot render.
 */

export const PREVIEW_WINDOW_MIN_WIDTH = 288;
export const PREVIEW_WINDOW_MIN_HEIGHT = 240;
export const PREVIEW_WINDOW_MAX_WIDTH = 720;
export const PREVIEW_WINDOW_SIDE_RATIO = 0.44;
export const PREVIEW_WINDOW_HEADER_HEIGHT = 64;
export const COMPACT_PREVIEW_WINDOW = { width: 480, height: 360 } as const;

export interface PreviewWindowViewport {
  width: number;
  height: number;
}

export interface PreviewWindowRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function readPreviewWindowViewport(): PreviewWindowViewport {
  if (typeof window === 'undefined') return { width: 1024, height: 768 };
  return {
    width: window.innerWidth > 0 ? window.innerWidth : 1024,
    height: window.innerHeight > 0 ? window.innerHeight : 768,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function gutter(viewportWidth: number): number {
  return Math.min(16, Math.max(4, Math.floor(viewportWidth / 40)));
}

/** Keep the window wholly inside the viewport, shrinking it first if needed. */
export function clampPreviewWindowRect(
  rect: PreviewWindowRect,
  viewport: PreviewWindowViewport,
): PreviewWindowRect {
  const vw = Math.max(1, Math.round(viewport.width));
  const vh = Math.max(1, Math.round(viewport.height));
  const width = Math.round(clamp(rect.width, Math.min(PREVIEW_WINDOW_MIN_WIDTH, vw), vw));
  const height = Math.round(clamp(rect.height, Math.min(PREVIEW_WINDOW_MIN_HEIGHT, vh), vh));
  const side = gutter(vw);
  const maxLeft = Math.max(side, vw - width - side);
  const maxTop = Math.max(TOP_MARGIN, vh - height - side);
  return {
    left: Math.round(clamp(rect.left, side, maxLeft)),
    top: Math.round(clamp(rect.top, TOP_MARGIN, maxTop)),
    width,
    height,
  };
}

export function initialPreviewWindowRect(
  viewport: PreviewWindowViewport,
  options: { compact?: boolean; extraHeight?: number } = {},
): PreviewWindowRect {
  const vw = Math.max(1, Math.round(viewport.width));
  const vh = Math.max(1, Math.round(viewport.height));
  const side = gutter(vw);
  const maxWidth = Math.max(1, vw - side * 2);
  const maxHeight = Math.max(1, vh - TOP_MARGIN - side);
  if (options.compact) {
    const width = Math.min(COMPACT_PREVIEW_WINDOW.width, maxWidth);
    const height = Math.min(COMPACT_PREVIEW_WINDOW.height + (options.extraHeight ?? 0), maxHeight);
    return clampPreviewWindowRect(
      {
        left: Math.round((vw - width) / 2),
        top: Math.round((vh - height) / 2),
        width,
        height,
      },
      viewport,
    );
  }
  const width = Math.min(
    PREVIEW_WINDOW_MAX_WIDTH,
    maxWidth,
    Math.max(Math.min(PREVIEW_WINDOW_MIN_WIDTH, maxWidth), Math.round(vw * PREVIEW_WINDOW_SIDE_RATIO)),
  );
  // Leave room below the window so it can also be dragged vertically; a window
  // exactly as tall as the available area would be pinned to the title bar.
  const height = Math.max(
    Math.min(PREVIEW_WINDOW_MIN_HEIGHT, maxHeight),
    Math.min(maxHeight, Math.round(vh * 0.82)),
  );
  return {
    left: vw - width - side,
    top: TOP_MARGIN,
    width,
    height,
  };
}

export function movePreviewWindowRect(
  rect: PreviewWindowRect,
  dx: number,
  dy: number,
  viewport: PreviewWindowViewport,
): PreviewWindowRect {
  return clampPreviewWindowRect({ ...rect, left: rect.left + dx, top: rect.top + dy }, viewport);
}

/** Resize from the bottom-right handle; the top-left corner stays put. */
export function resizePreviewWindowRect(
  rect: PreviewWindowRect,
  dw: number,
  dh: number,
  viewport: PreviewWindowViewport,
): PreviewWindowRect {
  const vw = Math.max(1, Math.round(viewport.width));
  const vh = Math.max(1, Math.round(viewport.height));
  const side = gutter(vw);
  const width = clamp(
    rect.width + dw,
    Math.min(PREVIEW_WINDOW_MIN_WIDTH, vw),
    Math.max(1, vw - rect.left - side),
  );
  const height = clamp(
    rect.height + dh,
    Math.min(PREVIEW_WINDOW_MIN_HEIGHT, vh),
    Math.max(1, vh - rect.top - side),
  );
  return clampPreviewWindowRect({ ...rect, width, height }, viewport);
}

/** Box of the floating panel inside the portal layer (which spans the viewport). */
export function previewWindowStyle(rect: PreviewWindowRect): CSSProperties {
  return {
    position: 'absolute',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    overflow: 'hidden',
    pointerEvents: 'auto',
    // Consumers that size media by the preview surface read these two vars.
    '--preview-width': `${rect.width}px`,
    '--preview-height': `${rect.height}px`,
  } as CSSProperties;
}
