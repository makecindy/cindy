/** Lightboxes share a z-index and portal to body; the last mounted layer is in front. */
export function isLightboxCovered(element: HTMLElement): boolean {
  const layers = document.querySelectorAll<HTMLElement>('[data-lightbox-layer]');
  const foreground = layers.item(layers.length - 1);
  return foreground !== null && !foreground.contains(element);
}


/** Portaled menus and the viewer's described tooltip own their Escape first. */
export function isLightboxEscapeOwnedByPopup(host: HTMLElement, target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest(
    '[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]',
  )) return true;
  return [...host.querySelectorAll('[aria-describedby]')].some(element =>
    (element.getAttribute('aria-describedby') ?? '').split(/\s+/).some(id =>
      document.getElementById(id)?.getAttribute('role') === 'tooltip',
    ),
  );
}
