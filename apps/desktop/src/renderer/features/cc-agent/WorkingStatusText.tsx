import { useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** Product cadence, independent of the theme's animation duration. */
export const WORKING_STATUS_MIN_INTERVAL_MS = 1000;

/** Mount only for an active lifecycle. Unmounting cancels all pending copy. */
export function WorkingStatusText({ text }: { text: string }) {
  const reducedMotion = useReducedMotion();
  const element = useRef<HTMLSpanElement>(null);
  const [displayed, setDisplayed] = useState(text);
  const [fading, setFading] = useState(false);
  const state = useRef({
    displayed: text,
    latest: text,
    changedAt: performance.now(),
    fading: false,
    reducedMotion,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });

  useLayoutEffect(() => {
    const current = state.current;
    current.latest = text;
    current.reducedMotion = reducedMotion;

    const commitLatest = () => {
      current.timer = undefined;
      current.displayed = current.latest;
      current.changedAt = performance.now();
      current.fading = false;
      setDisplayed(current.displayed);
      setFading(false);
    };
    const beginTransition = () => {
      current.timer = undefined;
      if (current.latest === current.displayed) return;
      const durationToken = element.current
        ? getComputedStyle(element.current).getPropertyValue('--motion-fast').trim()
        : '';
      const duration = Number.parseFloat(durationToken)
        * (durationToken.endsWith('ms') ? 1 : 1000);
      if (current.reducedMotion || !Number.isFinite(duration) || duration <= 0) {
        commitLatest();
        return;
      }
      current.fading = true;
      setFading(true);
      current.timer = setTimeout(commitLatest, duration);
    };

    if (text === current.displayed) {
      clearTimeout(current.timer);
      current.timer = undefined;
      current.fading = false;
      setFading(false);
    } else if (current.fading) {
      // Keep the original fade deadline; its callback consumes the latest copy.
      if (reducedMotion) {
        clearTimeout(current.timer);
        commitLatest();
      }
    } else if (current.timer === undefined) {
      const remaining = Math.max(0,
        current.changedAt + WORKING_STATUS_MIN_INTERVAL_MS - performance.now());
      current.timer = setTimeout(beginTransition, remaining);
    }
  }, [text, reducedMotion]);

  useLayoutEffect(() => () => clearTimeout(state.current.timer), []);

  return (
    <span
      ref={element}
      className="truncate transition-opacity duration-[var(--motion-fast)] ease-[var(--motion-ease-move)] motion-reduce:transition-none"
      style={{ opacity: fading && !reducedMotion ? 0 : 1 }}
    >
      {displayed}
    </span>
  );
}
