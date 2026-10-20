import type { CSSProperties } from 'react';

export interface KeepAliveSize {
  width: number;
  height: number;
}

/** Layout size used when a casting tab was hidden before it was ever measured. */
const FALLBACK_SIZE: KeepAliveSize = { width: 480, height: 720 };

/**
 * Style for a casting tab's body while the UI hides it.
 *
 * `display:none` (or a zero-size / `visibility:hidden` ancestor) stops Chromium
 * from producing frames, which freezes `capturePage`. So the body keeps its last
 * laid-out size and stays composited, only made invisible and click-through.
 * `position:fixed` takes it out of the (possibly 0-wide, overflow-clipped)
 * sidebar box without moving it in the DOM — reparenting a `<webview>` would
 * recreate its guest.
 */
export function castingKeepAliveStyle(
  measured: KeepAliveSize | null,
  viewport: KeepAliveSize,
): CSSProperties {
  const size = measured && measured.width > 0 && measured.height > 0 ? measured : FALLBACK_SIZE;
  return {
    position: 'fixed',
    top: 0,
    left: 0,
    // Stay inside the viewport: a fully off-screen layer may be culled.
    width: Math.max(1, Math.min(size.width, viewport.width)),
    height: Math.max(1, Math.min(size.height, viewport.height)),
    opacity: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
  };
}
