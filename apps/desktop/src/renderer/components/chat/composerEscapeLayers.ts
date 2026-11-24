// Pinned plans, image sharing and the sidebar rail can open in different orders.
const layers = new Set<HTMLElement>();

export function registerComposerEscapeLayer(element: HTMLElement): () => void {
  layers.add(element);
  return () => { layers.delete(element); };
}

export function isForegroundComposerEscapeLayer(element: HTMLElement): boolean {
  const foreground = Array.from(layers).findLast(
    (layer) => layer.isConnected
      && !layer.closest('[aria-hidden="true"]')
      && layer.checkVisibility?.({ checkVisibilityCSS: true }) !== false,
  );
  return foreground === element;
}
