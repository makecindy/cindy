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

const FOCUSABLE =
  'webview, iframe, a[href], button, input, select, textarea, [contenteditable], [tabindex]';

/**
 * Take everything inside a kept-alive (invisible) body out of the Tab order and
 * give up focus if it currently holds it, so a keyboard user can never land in
 * a transparent webview. Previous `tabindex` values are restored by the
 * returned function. Elements added while suspended (a late-attached webview,
 * a popover) are covered too. Not `inert`: that would blur the guest on its own
 * terms and is broader than needed.
 */
export function suspendFocusInside(root: HTMLElement): () => void {
  const saved = new Map<Element, string | null>();
  const apply = () => {
    for (const el of root.querySelectorAll(FOCUSABLE)) {
      if (saved.has(el)) continue;
      saved.set(el, el.getAttribute('tabindex'));
      el.setAttribute('tabindex', '-1');
    }
  };
  apply();
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  if (active instanceof HTMLElement && active !== doc.body && root.contains(active)) active.blur();
  const observer =
    typeof MutationObserver === 'undefined' ? null : new MutationObserver(apply);
  observer?.observe(root, { childList: true, subtree: true });
  return () => {
    observer?.disconnect();
    for (const [el, previous] of saved) {
      if (previous === null) el.removeAttribute('tabindex');
      else el.setAttribute('tabindex', previous);
    }
    saved.clear();
  };
}
