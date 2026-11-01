/** Observe scroll chaining from embedded documents without reading their contents. */
export function observeIframeScrollIntent(
  root: HTMLElement,
  shouldTakeOver: () => boolean,
  onTakeOver: () => void,
): () => void {
  let hoveredFrame: Element | null = null;
  const onPointerOver = (event: Event) => {
    const target = event.target;
    hoveredFrame = target instanceof Element && target.tagName === 'IFRAME' ? target : null;
  };
  const onPointerOut = () => { hoveredFrame = null; };
  const onScroll = (event: Event) => {
    // wheel events stay inside the child document, but Chromium can chain its
    // scroll to this list. Release restoration before the list's scroll handler
    // mistakes that movement for an intrinsic-size correction and pulls it back.
    if (event.target === root && hoveredFrame && root.contains(hoveredFrame) && shouldTakeOver()) {
      onTakeOver();
    }
  };
  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointerout', onPointerOut);
  root.addEventListener('scroll', onScroll, true);
  return () => {
    hoveredFrame = null;
    root.removeEventListener('pointerover', onPointerOver);
    root.removeEventListener('pointerout', onPointerOut);
    root.removeEventListener('scroll', onScroll, true);
  };
}
