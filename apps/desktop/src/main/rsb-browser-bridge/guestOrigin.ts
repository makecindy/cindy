/**
 * Where a browser tab's `<webview>` sits in its host window, for injecting touches.
 *
 * CDP's `Input.dispatchTouchEvent` reads a guest's touch coordinates in the embedding
 * window's space, so injecting at a page point needs the guest's origin there. Only the
 * host renderer knows the element's box; it answers a read-only `viewRect` tab-op over the
 * existing request/response bridge (no new channel, nothing executed in the renderer).
 * Zoom factors come from main's own WebContents APIs.
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
  /** Webview top-left in the host window, DIPs (CSS px x host zoom). */
  x: number;
  y: number;
  /** Guest page CSS px to host DIPs (the guest's zoom factor). */
  scale: number;
}

export interface TabOriginDeps {
  options(): RendererBridgeOptions | null;
  guest(tabId: string): Pick<WebContents, 'getZoomFactor' | 'isDestroyed'> | null;
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
  const hostZoom = host.getZoomFactor();
  const guestZoom = guest.getZoomFactor();
  if (!Number.isFinite(hostZoom) || hostZoom <= 0 || !Number.isFinite(guestZoom) || guestZoom <= 0)
    return null;
  return { x: result.rect.left * hostZoom, y: result.rect.top * hostZoom, scale: guestZoom };
}
