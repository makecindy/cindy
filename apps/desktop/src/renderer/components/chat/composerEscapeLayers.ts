// Pinned plans, image sharing, private topics and the sidebar rail can open in different orders.
const layers = new Map<HTMLElement, (() => boolean) | undefined>();

export function registerComposerEscapeLayer(element: HTMLElement, isActive?: () => boolean): () => void {
  layers.set(element, isActive);
  return () => { layers.delete(element); };
}

export function isForegroundComposerEscapeLayer(element: HTMLElement): boolean {
  const foreground = Array.from(layers).findLast(
    ([layer, isActive]) => layer.isConnected
      && (isActive?.() ?? true)
      && !layer.closest('[aria-hidden="true"]')
      && layer.checkVisibility?.({ checkVisibilityCSS: true }) !== false,
  );
  return foreground?.[0] === element;
}
