/** Scroll toward a live element, not the absolute offset captured by native smooth
 * scrolling. Virtual rows can replace estimated heights anywhere along the path. */
export function animateFocusScroll({
  root, getTarget, reconcile, onFinish,
}: {
  root: HTMLElement;
  getTarget: () => HTMLElement | null;
  reconcile: () => void;
  onFinish: () => void;
}): () => void {
  const centeredOffset = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const container = root.getBoundingClientRect();
    const style = getComputedStyle(target);
    const rootStyle = getComputedStyle(root);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const targetCenter = (rect.top + rect.bottom + px(style.scrollMarginBottom) - px(style.scrollMarginTop)) / 2;
    const viewportCenter = container.top + root.clientTop +
      (root.clientHeight + px(rootStyle.scrollPaddingTop) - px(rootStyle.scrollPaddingBottom)) / 2;
    return targetCenter - viewportCenter;
  };
  const target = getTarget();
  const initialOffset = target ? centeredOffset(target) : 0;
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0 : Math.min(800, Math.max(200, Math.sqrt(Math.abs(initialOffset)) * 8));
  let frame = 0;
  let cancelled = false;
  const start = performance.now();
  // Stop an earlier native animation before taking ownership.
  root.scrollTo({ top: root.scrollTop, behavior: 'instant' });
  const tick = (now: number) => {
    if (cancelled) return;
    // rAF uses the frame timestamp, which can precede our performance.now()
    // start. Negative progress would scroll away from the target on frame one.
    const progress = duration ? Math.max(0, Math.min(1, (now - start) / duration)) : 1;
    const remaining = initialOffset * (1 - progress) ** 3;
    // Mounting the new viewport may move the target. Correct that displacement
    // in the same paint, preserving the animation's intended visual position.
    for (let pass = 0; pass < 3; pass++) {
      const current = getTarget();
      if (!current) break;
      const delta = centeredOffset(current) - remaining;
      if (Math.abs(delta) <= 0.5) break;
      const before = root.scrollTop;
      root.scrollTo({ top: before + delta, behavior: 'instant' });
      reconcile();
      if (cancelled) return;
      if (Math.abs(root.scrollTop - before) <= 0.5) break;
    }
    if (progress === 1 || !getTarget()) onFinish();
    else frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}
