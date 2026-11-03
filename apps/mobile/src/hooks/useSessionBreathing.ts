import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useReduceMotionEnabled } from './useReduceMotion';

// Same running signal as Desktop's session-status-breathing: 1.5s, opacity 0.3–1.
export const SESSION_BREATH_MIN_OPACITY = 0.3;
const HALF_CYCLE_MS = 750;

/** Shared native animation for task glyphs, teammate dots and working avatar rings. */
export function createSessionBreathing(opacity: Animated.Value) {
  return Animated.loop(Animated.sequence([1, SESSION_BREATH_MIN_OPACITY].map(toValue =>
    Animated.timing(opacity, {
      toValue, duration: HALF_CYCLE_MS, easing: Easing.inOut(Easing.ease), useNativeDriver: true,
    }))));
}

export function useSessionBreathing(running: boolean) {
  const reduceMotion = useReduceMotionEnabled();
  const animate = running && reduceMotion === false;
  const opacity = useRef(new Animated.Value(animate ? SESSION_BREATH_MIN_OPACITY : 1)).current;
  useEffect(() => {
    opacity.stopAnimation();
    if (!animate) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(SESSION_BREATH_MIN_OPACITY);
    const loop = createSessionBreathing(opacity);
    loop.start();
    return () => loop.stop();
  }, [animate, opacity]);
  return opacity;
}
