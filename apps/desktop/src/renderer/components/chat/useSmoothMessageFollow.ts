import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Commit the real scroll geometry once, then interpolate its visual displacement on the
 * compositor. Repeated token batches retarget from the currently displayed position.
 * In particular, remember the old bottom before Chromium clamps it on a height shrink.
 * No React renders, Markdown parses or repeated layout writes are needed between frames.
 */
export function useSmoothMessageFollow(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  active = true,
) {
  const previousTop = useRef<number | null>(null);
  const initialized = useRef(false);
  const animation = useRef<Animation | null>(null);
  const trajectory = useRef<{ offset: number; start: number; duration: number; curve: number[] } | null>(null);

  const currentOffset = useCallback(() => {
    const path = trajectory.current;
    if (!path || !animation.current) return 0;
    // document.timeline/getComputedStyle can still describe the previous frame
    // during a long JS task. Sample the same CSS curve at wall-clock time, without
    // seeking the running animation (seeking would itself reset its start time).
    const progress = Math.min(1, Math.max(0, (performance.now() - path.start) / path.duration));
    const [x1, y1, x2, y2] = path.curve;
    const bezier = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    let low = 0, high = 1;
    for (let i = 0; i < 16; i++) {
      const middle = (low + high) / 2;
      if (bezier(middle, x1, x2) < progress) low = middle;
      else high = middle;
    }
    return path.offset * (1 - bezier((low + high) / 2, y1, y2));
  }, []);

  const retarget = useCallback((offset: number) => {
    const content = contentRef.current;
    animation.current?.cancel();
    animation.current = null;
    trajectory.current = null;
    if (!content?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const style = getComputedStyle(content);
    const duration = style.getPropertyValue('--motion-base').trim();
    const milliseconds = Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000);
    const easing = style.getPropertyValue('--motion-ease-move').trim();
    const curve = /^cubic-bezier\(([^)]+)\)$/.exec(easing)?.[1].split(',').map(Number);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || curve?.length !== 4 || curve.some(n => !Number.isFinite(n))) return;
    const start = performance.now();
    trajectory.current = { offset, start, duration: milliseconds, curve };
    animation.current = content.animate([
      { transform: `translateY(${offset}px)` },
      { transform: 'translateY(0)' },
    ], { duration: milliseconds, easing, fill: 'both' });
    // Pending animations otherwise wait for a compositor acknowledgement and
    // can sit on their first frame while another layout update retargets them.
    animation.current.startTime = start;
  }, [contentRef]);

  useLayoutEffect(() => {
    if (!active) {
      initialized.current = false;
      previousTop.current = null;
      return;
    }
    const scroll = scrollRef.current;
    if (!scroll) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const takeOver = () => {
      // Hand the exact visible position back to native scrolling before the user's gesture.
      const offset = currentOffset();
      animation.current?.cancel();
      animation.current = null;
      if (offset) scroll.scrollTop -= offset;
      previousTop.current = null;
    };
    const reduce = () => {
      if (!reduced?.matches) return;
      animation.current?.cancel();
      animation.current = null;
      previousTop.current = null;
    };
    const rememberScroll = () => {
      const delta = previousTop.current === null ? 0 : scroll.scrollTop - previousTop.current;
      previousTop.current = scroll.scrollTop;
      // A second measurement can clamp the range after the layout effect's pin.
      // Apply that correction to the same visible trajectory before this paint.
      if (animation.current?.playState === 'running' && Math.abs(delta) >= 0.25) {
        retarget(currentOffset() + delta);
      }
    };
    scroll.addEventListener('scroll', rememberScroll, { passive: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      scroll.addEventListener(event, takeOver, { capture: true, passive: true });
    }
    reduced?.addEventListener('change', reduce);
    return () => {
      animation.current?.cancel();
      scroll.removeEventListener('scroll', rememberScroll);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        scroll.removeEventListener(event, takeOver, true);
      }
      reduced?.removeEventListener('change', reduce);
    };
  }, [scrollRef, currentOffset, retarget, active]);

  return useCallback(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!active || !scroll || !content) return;
    const before = previousTop.current ?? scroll.scrollTop;
    const offset = currentOffset();
    scroll.scrollTop = scroll.scrollHeight;
    const delta = scroll.scrollTop - before;
    previousTop.current = scroll.scrollTop;
    if (!initialized.current) { initialized.current = true; return; }
    if (Math.abs(delta) < 0.25) return;
    retarget(offset + delta);
  }, [scrollRef, contentRef, currentOffset, retarget, active]);
}
