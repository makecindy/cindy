import { useLayoutEffect, type RefObject } from 'react';

/** The native material follows the painted sidebar, including intermediate
 * collapse/peek frames. No polling when idle, and no persisted geometry. */
export function useSidebarMaterial(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    const theme = window.electronAPI?.theme;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const send = window.electronAPI?.platform === 'darwin' ? theme?.setSidebarWidth : undefined;
    let lastWidth = -1;
    let frame = 0;
    const sync = () => {
      const rect = element.getBoundingClientRect();
      // Left-anchored peek slides partly outside the viewport. Clip the material
      // to the visible portion rather than keeping the expanded-width rectangle.
      const width = rect.height > 0
        ? Math.round(Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left)) * 100) / 100
        : 0;
      if (width === lastWidth) return;
      lastWidth = width;
      // The shared veil must leave this area clear; otherwise a 0%-transparent
      // main background paints over the native sidebar before it can be seen.
      root.style.setProperty('--sidebar-visible-width', `${width}px`);
      send?.(width);
    };
    const tick = () => {
      frame = 0;
      sync();
      if (element.getAnimations().some(animation => animation.playState === 'running')) {
        frame = requestAnimationFrame(tick);
      }
    };
    const animate = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    element.addEventListener('transitionrun', animate);
    element.addEventListener('animationstart', animate);
    window.addEventListener('resize', sync);
    sync();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      element.removeEventListener('transitionrun', animate);
      element.removeEventListener('animationstart', animate);
      window.removeEventListener('resize', sync);
      root.style.removeProperty('--sidebar-visible-width');
      send?.(0);
    };
  }, [ref]);
}
