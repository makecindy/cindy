import { useEffect, type RefObject } from 'react';

/** Shared lifecycle for search selections and settings deep links. */
export function useSettingsSectionTarget(
  targetId: string | null,
  scrollRef: RefObject<HTMLDivElement | null>,
  navigationKey: string,
  fallbackTargetId?: string,
) {
  useEffect(() => {
    const container = scrollRef.current;
    if (!targetId || !container) return;
    let target: HTMLElement | null = null;
    let highlighted: HTMLElement | null = null;
    let timer: number | undefined;
    let observer: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let expiry: number | undefined;
    let stopped = false;
    let lastTop: number | undefined;
    let lastScrollHeight = 0;
    const stopFollowing = () => {
      stopped = true;
      observer?.disconnect();
      resizeObserver?.disconnect();
      window.clearTimeout(expiry);
    };
    const reveal = () => {
      if (stopped) return;
      const exact = document.getElementById(targetId);
      // 关闭分区后明细仍挂载但 hidden；搜索应落到可见的总开关，而不是隐藏锚点。
      const next = exact?.getClientRects().length
        ? exact
        : (fallbackTargetId ? document.getElementById(fallbackTargetId) : null);
      if (!next || !container.contains(next)) return;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const changed = next !== target;
      if (changed) {
        if (timer !== undefined) window.clearTimeout(timer);
        highlighted?.classList.remove('settings-search-target-highlight');
        // A page result scrolls to the panel and highlights its single navigation option.
        const pageTarget = next.getAttribute('role') === 'tabpanel';
        highlighted = pageTarget
          ? document.getElementById(next.getAttribute('aria-labelledby') ?? '')
          : next;
        if (highlighted) {
          const option = highlighted;
          option.classList.add('settings-search-target-highlight');
          if (pageTarget) option.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          timer = window.setTimeout(
            () => option.classList.remove('settings-search-target-highlight'),
            2300,
          );
        }
      }
      target = next;
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      if (!changed && lastTop !== undefined && Math.abs(top - lastTop) < 1 && lastScrollHeight === container.scrollHeight) return;
      lastTop = top;
      lastScrollHeight = container.scrollHeight;
      container.scrollTo({
        top: Math.max(0, top - 8),
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    };
    const frame = window.requestAnimationFrame(() => {
      if (stopped) return;
      reveal();
      // IPC may insert a target or expand cards above an existing target. Follow
      // only this navigation briefly; direct user interaction always takes over.
      observer = new MutationObserver(reveal);
      observer.observe(container, { childList: true, subtree: true });
      resizeObserver = new ResizeObserver(reveal);
      for (const child of container.children) resizeObserver.observe(child);
      expiry = window.setTimeout(stopFollowing, 5000);
    });
    const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const event of inputEvents) container.addEventListener(event, stopFollowing, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      stopFollowing();
      for (const event of inputEvents) container.removeEventListener(event, stopFollowing);
      if (timer !== undefined) window.clearTimeout(timer);
      highlighted?.classList.remove('settings-search-target-highlight');
    };
  }, [targetId, fallbackTargetId, navigationKey, scrollRef]);
}
