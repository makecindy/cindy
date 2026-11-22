let activationLayerCount = 0;

/** Activated preview layers own shortcuts until a newer layer is mounted. */
export function activateLightboxLayer(element: HTMLElement | null): void {
  if (!element) return;
  activationLayerCount = document.querySelectorAll('[data-lightbox-layer]').length;
  document
    .querySelectorAll<HTMLElement>('[data-lightbox-layer][data-preview-active]')
    .forEach((layer) => {
      if (layer !== element) layer.removeAttribute('data-preview-active');
    });
  element.setAttribute('data-preview-active', '');
}

/** A layer mounted after the last activation supersedes the activated layer. */
function foregroundLayer(): HTMLElement | null {
  const layers = Array.from(document.querySelectorAll<HTMLElement>('[data-lightbox-layer]'));
  const active = document.querySelector<HTMLElement>('[data-lightbox-layer][data-preview-active]');
  if (active && layers.length <= activationLayerCount) return active;
  return layers.at(-1) ?? null;
}

export function isLightboxCovered(element: HTMLElement): boolean {
  const foreground = foregroundLayer();
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
