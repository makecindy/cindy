/**
 * Where a browser tab's `<webview>` sits in its host window, for injecting touches.
 *
 * CDP's `Input.dispatchTouchEvent` reads a guest's touch coordinates in the embedding
 * window's space, so injecting at a page point needs the guest's origin there. Only the
 * host renderer knows the element's box; it answers a read-only `viewRect` tab-op over the
 * existing request/response bridge (no new channel, nothing executed in the renderer).
 *
 * The space is the host renderer's CSS px, as `getBoundingClientRect()` reports it: measured
 * on a real Desktop with the host app at 90%, 100% and 110% zoom, the offset between what
 * CDP was sent and what the page received was exactly the webview's rect, with no host zoom
 * factor in it. The page-to-host scale is left to the consumer, which can derive it from the
 * rect size and the guest's own CSS viewport without trusting any zoom API.
 */

import type { WebContents } from 'electron';

import type {
  RsbBrowserBridgeTabOp,
  RsbBrowserBridgeTabOpResult,
  RsbBrowserBridgeViewRect,
} from '../../shared/rsbBrowserBridge.js';
import { dispatchTabOp, type RendererBridgeOptions } from './renderer-bridge.js';

/** The renderer answers in milliseconds; a gesture must not wait on a missing one. */
export const VIEW_RECT_TIMEOUT_MS = 1_000;
const MAX_COORDINATE = 100_000;

export interface TabOrigin {
  /** Webview box in the host renderer's viewport, CSS px (`getBoundingClientRect()`). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The webview cannot be hit-tested in its host (`pointer-events: none` on it or above it). */
  hitBlocked?: boolean;
}

export interface TabOriginDeps {
  options(): RendererBridgeOptions | null;
  guest(tabId: string): Pick<WebContents, 'isDestroyed'> | null;
  dispatch?(
    op: RsbBrowserBridgeTabOp,
    options: RendererBridgeOptions,
    assertActive?: () => void,
    dispatchOptions?: { ensureHost?: boolean },
  ): Promise<RsbBrowserBridgeTabOpResult>;
}

function validRect(rect: unknown): rect is RsbBrowserBridgeViewRect {
  if (!rect || typeof rect !== 'object') return false;
  const { left, top, width, height } = rect as Record<string, unknown>;
  return (
    typeof left === 'number' &&
    typeof top === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(left) &&
    Number.isFinite(top) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    Math.abs(left) <= MAX_COORDINATE &&
    Math.abs(top) <= MAX_COORDINATE &&
    width > 0 &&
    height > 0
  );
}

/** Null whenever the origin cannot be established: the caller must refuse, not guess. */
export async function requestTabOrigin(
  tab: { sessionId: string; tabId: string },
  deps: TabOriginDeps,
): Promise<TabOrigin | null> {
  const options = deps.options();
  if (!options) return null;
  const op: RsbBrowserBridgeTabOp = { op: 'viewRect', sessionId: tab.sessionId, tabId: tab.tabId };
  const host = options.getHostWebContents(op);
  if (!host || host.isDestroyed()) return null;
  const guest = deps.guest(tab.tabId);
  if (!guest || guest.isDestroyed()) return null;
  let result: RsbBrowserBridgeTabOpResult;
  try {
    // Never pops a window open: a tab that is not hosted anywhere has no origin to give.
    result = await (deps.dispatch ?? dispatchTabOp)(
      op,
      { ...options, timeoutMs: VIEW_RECT_TIMEOUT_MS },
      undefined,
      { ensureHost: false },
    );
  } catch {
    return null;
  }
  if (!result.ok || !validRect(result.rect)) return null;
  // The tab may have been closed or rebuilt while the renderer answered.
  if (guest.isDestroyed() || host.isDestroyed()) return null;
  return {
    x: result.rect.left,
    y: result.rect.top,
    width: result.rect.width,
    height: result.rect.height,
    ...(result.rect.pointerBlocked === true ? { hitBlocked: true } : {}),
  };
}
