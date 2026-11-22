/** Lightboxes share a z-index and portal to body; the last mounted layer is in front. */
export function isLightboxCovered(element: HTMLElement): boolean {
  const layers = document.querySelectorAll<HTMLElement>('[data-lightbox-layer]');
  const foreground = layers.item(layers.length - 1);
  return foreground !== null && !foreground.contains(element);
}

/**
 * Active shortcuts belong to the foreground preview only. A non-modal image
 * preview yields to the background conversation when focus is outside its
 * panel; body/documentElement means no explicit focus, so the preview still
 * owns its shortcuts after opening.
 */
export function lightboxOwnsShortcutTarget(
  target: EventTarget | null,
  panel: HTMLElement | null,
): boolean {
  if (!panel || isLightboxCovered(panel)) return false;
  if (target === document.body || target === document.documentElement) return true;
  return target instanceof Node && panel.contains(target);
}
