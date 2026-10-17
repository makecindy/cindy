import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { cancelAnimation, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import type { HomeMode } from './homeViewPreferenceStore';

/**
 * Critically damped (~0.35s response), clamped: no visible bounce. A spring rather than
 * a duration tier, so a reversal mid-slide starts moving at once and a short remaining
 * distance settles quickly instead of replaying a full ease-in-out (DESIGN.md §14.4).
 */
export const HOME_MODE_SLIDE_SPRING = { mass: 1, stiffness: 320, damping: 36, overshootClamping: true } as const;

/** One UI-thread clock, owned by ResidentHomeListProvider, for the panes and the wide resident list. */
export const HomeModeProgressContext = createContext<SharedValue<number> | null>(null);
export const homeModeIndex = (mode: HomeMode) => mode === 'tasks' ? 0 : 1;

export function useHomeModeProgress(mode: HomeMode, animate: boolean, ready: boolean): SharedValue<number> {
  const progress = useSharedValue(homeModeIndex(mode));
  const reduceMotion = useReduceMotionEnabled();
  const wasReady = useRef(ready);
  useLayoutEffect(() => {
    const canAnimate = animate && ready && wasReady.current && reduceMotion === false;
    wasReady.current = ready;
    const target = homeModeIndex(mode);
    // Assign over a running slide (no cancel first) so the spring keeps its velocity.
    if (progress.value !== target) progress.value = canAnimate ? withSpring(target, HOME_MODE_SLIDE_SPRING) : target;
  }, [animate, mode, progress, ready, reduceMotion]);
  useEffect(() => () => cancelAnimation(progress), [progress]);
  return progress;
}

export function useHomeModeSlide(): SharedValue<number> {
  const progress = useContext(HomeModeProgressContext);
  if (!progress) throw new Error('useHomeModeSlide requires ResidentHomeListProvider');
  return progress;
}
