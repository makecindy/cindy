/** Activated preview layers own shortcuts; DOM mount order is only the fallback. */
export function activateLightboxLayer(element: HTMLElement | null): void {
  if (!element) return;
  document
    .querySelectorAll<HTMLElement>('[data-lightbox-layer][data-preview-active]')
    .forEach((layer) => {
      if (layer !== element) layer.removeAttribute('data-preview-active');
    });
  element.setAttribute('data-preview-active', '');
}

/** Lightboxes share a z-index; the activated layer, else the last mounted one, is in front. */
export function isLightboxCovered(element: HTMLElement): boolean {
  const layers = document.querySelectorAll<HTMLElement>('[data-lightbox-layer]');
  const active = document.querySelector<HTMLElement>('[data-lightbox-layer][data-preview-active]');
  const foreground = active ?? layers.item(layers.length - 1);
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
