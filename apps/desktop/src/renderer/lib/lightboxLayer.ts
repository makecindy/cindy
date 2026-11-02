/** Lightboxes share a z-index and portal to body; the last mounted layer is in front. */
export function isLightboxCovered(element: HTMLElement): boolean {
  const layers = document.querySelectorAll<HTMLElement>('[data-lightbox-layer]');
  const foreground = layers.item(layers.length - 1);
  return foreground !== null && !foreground.contains(element);
}
