import { useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, type StyleProp, type TextStyle } from 'react-native';
import { Text } from '@/components/AppText';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme';

/** Product cadence shared with Desktop `WorkingStatusText`. */
export const WORKING_STATUS_MIN_INTERVAL_MS = 1000;

/** Mount only for an active lifecycle (key it by turn). Unmounting cancels all pending copy. */
export function WorkingStatusText({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  // Only an explicit `false` animates; an unknown preference commits directly.
  const animate = useReduceMotionEnabled() === false;
  const [displayed, setDisplayed] = useState(text);
  const opacity = useRef(new Animated.Value(1)).current;
  const state = useRef({
    displayed: text,
    latest: text,
    changedAt: Date.now(),
    fading: false,
    animate,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    unmounted: false,
  });

  useLayoutEffect(() => {
    const current = state.current;
    current.latest = text;
    current.animate = animate;
    const fade = (toValue: number, done?: () => void) => {
      Animated.timing(opacity, {
        toValue,
        duration: motionDuration.fast,
        easing: Easing.bezier(...motionEasing.move),
        useNativeDriver: true,
      }).start(({ finished }) => { if (finished && !current.unmounted) done?.(); });
    };
    const commitLatest = () => {
      current.timer = undefined;
      current.displayed = current.latest;
      current.changedAt = Date.now();
      current.fading = false;
      setDisplayed(current.displayed);
      if (current.animate) fade(1);
      else { opacity.stopAnimation(); opacity.setValue(1); }
    };
    const beginTransition = () => {
      current.timer = undefined;
      if (current.latest === current.displayed) return;
      if (!current.animate) {
        commitLatest();
        return;
      }
      current.fading = true;
      // The fade callback consumes whichever copy is latest when it completes.
      fade(0, commitLatest);
    };

    if (text === current.displayed) {
      clearTimeout(current.timer);
      current.timer = undefined;
      if (current.fading) {
        current.fading = false;
        opacity.stopAnimation();
        if (animate) fade(1);
        else opacity.setValue(1);
      }
    } else if (current.fading) {
      if (!animate) {
        opacity.stopAnimation();
        commitLatest();
      }
    } else if (current.timer === undefined) {
      const remaining = Math.max(0, current.changedAt + WORKING_STATUS_MIN_INTERVAL_MS - Date.now());
      current.timer = setTimeout(beginTransition, remaining);
    }
  }, [animate, opacity, text]);

  useLayoutEffect(() => {
    const current = state.current;
    current.unmounted = false;
    return () => {
      current.unmounted = true;
      clearTimeout(current.timer);
      current.timer = undefined;
      opacity.stopAnimation();
    };
  }, [opacity]);

  return (
    <Animated.View style={{ opacity, flexShrink: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={style}>{displayed}</Text>
    </Animated.View>
  );
}
