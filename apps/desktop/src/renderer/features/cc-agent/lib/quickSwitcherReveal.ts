/** Reveal a mounted sidebar destination after its ancestor expansion transitions. */
export function revealQuickSwitcherTarget(target: {
  kind: 'project' | 'session';
  sessionId: string | null;
  projectKey: string | null;
}): () => void {
  const selector =
    target.kind === 'project' && target.projectKey
      ? `[data-project-workingdir="${CSS.escape(target.projectKey)}"] > [data-project-header="true"]`
      : target.sessionId
        ? `[data-sidebar-session-row="true"][data-session-id="${CSS.escape(target.sessionId)}"]`
        : null;
  if (!selector) return () => {};
  let disposed = false;
  let waiting = false;
  const reveal = () => {
    if (disposed || waiting) return;
    const row = document.querySelector<HTMLElement>(selector);
    if (
      !row ||
      row.closest('[data-sidebar-section-collapsed="true"]') ||
      row.getClientRects().length === 0
    )
      return;
    waiting = true;
    observer.disconnect();
    const animations: Animation[] = [];
    for (let element: HTMLElement | null = row; element; element = element.parentElement) {
      animations.push(
        ...(element.getAnimations?.() ?? []).filter(
          (animation) => animation.effect?.getComputedTiming().iterations !== Infinity,
        ),
      );
    }
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (disposed || !row.isConnected) return;
      row.scrollIntoView({ block: 'nearest' });
      row.focus({ preventScroll: true });
      clearTimeout(timeout);
    });
  };
  const observer = new MutationObserver(reveal);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'data-sidebar-section-collapsed'],
  });
  const frame = requestAnimationFrame(reveal);
  const timeout = setTimeout(() => {
    disposed = true;
    observer.disconnect();
  }, 2000);
  return () => {
    disposed = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(timeout);
  };
}
