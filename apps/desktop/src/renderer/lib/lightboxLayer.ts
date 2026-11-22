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

/**
 * Menus opened by this preview are portaled to body. They are not part of the
 * image shortcut scope, but they do belong to its interaction guard; matching
 * the panel's scope id keeps menu keyboard work while background keys are held.
 */
export function isPreviewMenuTarget(target: EventTarget | null, panel: HTMLElement | null): boolean {
  if (!panel || isLightboxCovered(panel) || !(target instanceof Element)) return false;
  const scopeId = panel.getAttribute('data-preview-scope-id');
  if (!scopeId) return false;
  const menu = target.closest('[data-preview-menu-scope]');
  return menu?.getAttribute('data-preview-menu-scope') === scopeId;
}

/** Interaction guard: panel, implicit focus, or this preview's portaled menu. */
export function lightboxOwnsInteractionTarget(
  target: EventTarget | null,
  panel: HTMLElement | null,
): boolean {
  return lightboxOwnsShortcutTarget(target, panel) || isPreviewMenuTarget(target, panel);
}
