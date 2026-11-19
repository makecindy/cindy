import { useEffect, useRef, useState } from 'react';

/**
 * Animate a numeric value smoothly toward `target` using requestAnimationFrame
 * with an ease-out curve, similar to claude code's running token counter.
 *
 * Behavior:
 * - On first mount, returns `target` directly (no initial 0 → target jump).
 * - When `target` changes mid-animation, the animation re-anchors from the
 *   currently displayed value (not the previous target), so rapid updates
 *   blend seamlessly without visible reverts.
 * - Returns an integer (rounded) to keep token-count formatting clean.
 * - Cancels the in-flight RAF on unmount or when a new animation starts.
 *
 * @param target   The desired final value.
 * @param duration Animation duration in ms (default 400); non-positive values snap without RAF.
 */
export function useAnimatedNumber(target: number, duration = 400): number {
  const [displayed, setDisplayed] = useState(target);

  // Mutable refs avoid re-running the effect on every tick (which would happen
  // if `displayed` were a dep — that would create an infinite re-schedule loop).
  const displayedRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  // Keep the ref in sync so the next animation can read the latest displayed
  // value as its starting point without depending on it in the effect deps.
  displayedRef.current = displayed;

  useEffect(() => {
    // Cancel any animation already in flight — we always re-anchor from the
    // current displayed value so rapid target updates don't snap or reverse.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const from = displayedRef.current;
    const to = target;

    // Already there — nothing to do (avoids a 1-frame redundant tick).
    if (from === to) return;

    // Decreases mean a reset, not a real change to animate. The token counter
    // jumps from the previous turn's total (e.g. 8.5k) down to 0 at the start
    // of every new turn (see makerChatStore handleStatusUpdate isTurnStart).
    // Easing through that drop reads as a confusing countdown — snap instead.
    // A non-positive duration also snaps (e.g. reduced motion) without scheduling RAF.
    if (duration <= 0 || to < from) {
      setDisplayed(to);
      return;
    }

    // For very small jumps, skip the RAF dance — the visual gain is zero and
    // the overhead is wasted. (e.g. token counter going 1023 → 1024.)
    if (to - from < 2) {
      setDisplayed(to);
      return;
    }

    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out quadratic: fast start, slow finish — feels responsive.
      const eased = 1 - (1 - t) * (1 - t);
      const value = Math.round(from + (to - from) * eased);
      setDisplayed(value);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, duration]);

  return displayed;
}
