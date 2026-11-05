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
      const next = exact ?? (fallbackTargetId ? document.getElementById(fallbackTargetId) : null);
      if (!next || !container.contains(next)) return;
      const changed = next !== target;
      if (changed) {
        if (timer !== undefined) window.clearTimeout(timer);
        target?.classList.remove('settings-search-target-highlight');
      }
      target = next;
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      if (!changed && lastTop !== undefined && Math.abs(top - lastTop) < 1 && lastScrollHeight === container.scrollHeight) return;
      lastTop = top;
      lastScrollHeight = container.scrollHeight;
      container.scrollTo({
        top: Math.max(0, top - 8),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      if (changed) {
        target.classList.add('settings-search-target-highlight');
        timer = window.setTimeout(() => target?.classList.remove('settings-search-target-highlight'), 1600);
      }
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
      target?.classList.remove('settings-search-target-highlight');
    };
  }, [targetId, fallbackTargetId, navigationKey, scrollRef]);
}
