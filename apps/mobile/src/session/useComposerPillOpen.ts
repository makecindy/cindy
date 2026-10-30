import { useCallback, useEffect, useRef, useState } from 'react';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';

/** Native focuses the input as the card opens; JS only covers a missing native view. */
const FALLBACK_FOCUS_MS = 320;
/** Long enough for onFocus to arrive after focus(); only a fallback release. */
const FOCUS_GRACE_MS = 400;

/**
 * iOS composer dock: a tap on the compact pill first pulls it open into
 * the card (native glass growth keyed by `expandToken`), then the input is
 * focused so the keyboard follows.
 * `opening` holds the card open until focus lands; it is released shortly
 * after either way so a refused focus cannot leave the card stuck open.
 */
export function useComposerPillOpen(enabled: boolean, focus: () => void) {
  const reduceMotion = useReduceMotionEnabled();
  const [opening, setOpening] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const open = useCallback(() => {
    if (timers.current.length > 0) return;
    setOpening(true);
    setOpenCount(count => count + 1);
    timers.current.push(setTimeout(() => {
      focusRef.current();
      timers.current.push(setTimeout(() => {
        timers.current = [];
        setOpening(false);
      }, FOCUS_GRACE_MS));
    }, FALLBACK_FOCUS_MS));
  }, []);
  const active = enabled && reduceMotion === false;
  return {
    opening,
    onCollapsedPress: active ? open : undefined,
    // Mounted while enabled so native already knows the pill's frame on the first open.
    expandToken: active ? String(openCount) : undefined,
  };
}
