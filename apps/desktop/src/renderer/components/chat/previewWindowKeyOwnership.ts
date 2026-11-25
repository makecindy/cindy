import { isLightboxCovered } from '@/lib/lightboxLayer';

/**
 * Keyboard ownership for the shared non-modal preview window.
 *
 * Several previews can now be open at once, and the conversation behind them
 * keeps its own focus. Two rules keep one keypress from doing two things:
 *
 *  - Only the foreground preview (the last mounted `[data-lightbox-layer]`)
 *    consumes Escape, and it marks the event as handled.
 *  - App shortcuts such as Ctrl/Cmd+A and Ctrl/Cmd+F belong to a preview only
 *    while keyboard focus is actually inside it, so selecting or searching in
 *    the message bar keeps working (DESIGN.md §14.2).
 */

const POPUP_SELECTOR =
  '[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

export function isForegroundPreviewWindow(panel: HTMLElement | null): boolean {
  return Boolean(panel && !isLightboxCovered(panel));
}

/**
 * `body` / `documentElement` count as "no background control claimed focus
 * yet". A popup portaled outside the panel (the shared find bar) still belongs
 * to the preview while it is open.
 */
export function previewOwnsKeyboardFocus(host: HTMLElement | null): boolean {
  if (!host) return false;
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return true;
  if (host.contains(active)) return true;
  return active instanceof Element && active.closest('[data-preview-window-popup]') !== null;
}

/** Escape belongs to the foreground preview even when focus sits on the page body. */
export function previewWindowOwnsEscape(
  event: KeyboardEvent,
  panel: HTMLElement | null,
): boolean {
  if (!panel || event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (!isForegroundPreviewWindow(panel)) return false;
  return !(event.target instanceof Element && event.target.closest(POPUP_SELECTOR));
}

/** Shortcuts additionally need focus inside the preview. */
export function previewWindowOwnsShortcut(
  event: KeyboardEvent,
  panel: HTMLElement | null,
): boolean {
  return previewWindowOwnsEscape(event, panel) && previewOwnsKeyboardFocus(panel);
}

/** Mark an Escape as consumed so a second preview cannot close in the same key. */
export function claimPreviewWindowEscape(event: KeyboardEvent, panel: HTMLElement | null): boolean {
  if (!previewWindowOwnsEscape(event, panel)) return false;
  event.preventDefault();
  return true;
}
