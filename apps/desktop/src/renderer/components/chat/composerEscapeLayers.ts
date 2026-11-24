// A pinned plan and the image sharing bar can open in either order.
const layers = new Set<HTMLElement>();

export function registerComposerEscapeLayer(element: HTMLElement): () => void {
  layers.add(element);
  return () => { layers.delete(element); };
}

export function isForegroundComposerEscapeLayer(element: HTMLElement): boolean {
  const foreground = Array.from(layers).findLast(
    (layer) => layer.isConnected && layer.checkVisibility?.({ checkVisibilityCSS: true }) !== false,
  );
  return foreground === element;
}
