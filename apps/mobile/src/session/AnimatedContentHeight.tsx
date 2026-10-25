import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type ViewProps } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration } from '@/theme/tokens';

/**
 * Animate the space a chat component actually occupies, not just its presentation
 * frame. Layout transitions report their final height before they finish drawing;
 * feeding that height to the message footer makes the list jump ahead of them.
 * The independent inner measurement is the destination; the outer Yoga height is
 * the current position, including while streaming content changes that destination.
 */
export function AnimatedContentHeight({ open = true, animateInitial = false, allowOverflow = false, onCollapsed, children, ...props }: ViewProps & {
  open?: boolean;
  /** Only live appended rows opt in; restored history starts at its final size. */
  animateInitial?: boolean;
  /** Composer drag surfaces may extend beyond a settled input; message rows may not. */
  allowOverflow?: boolean;
  onCollapsed?: () => void;
  children: ReactNode;
}) {
  const reduced = useReduceMotionEnabled();
  const [mounted, setMounted] = useState(open);
  const contentMounted = useRef(open);
  const [measured, setMeasured] = useState(animateInitial);
  const height = useSharedValue(0);
  const destination = useSharedValue(0);
  const showing = useSharedValue(open);
  const hasNativeMeasurement = useSharedValue(false);
  const target = useRef(0);
  const requested = useRef<{ height: number; animate: boolean } | null>(null);
  const initialized = useRef(animateInitial);
  const currentOpen = useRef(open);
  currentOpen.current = open;
  const collapsedCallback = useRef(onCollapsed);
  collapsedCallback.current = onCollapsed;
  const retained = useRef<ReactNode>(children);
  if (open) retained.current = children;
  const release = useCallback(() => {
    if (!currentOpen.current) {
      retained.current = null;
      contentMounted.current = false;
      setMounted(false);
      collapsedCallback.current?.();
    }
  }, []);
  const move = useCallback((next: number, animate: boolean) => {
    const animated = animate && reduced === false;
    if (requested.current?.height === next && requested.current.animate === animated) return;
    requested.current = { height: next, animate: animated };
    destination.value = next;
    if (!animated) {
      cancelAnimation(height);
      height.value = next;
      if (next === 0) release();
      return;
    }
    // Keep velocity when a streamed line changes the destination. Cancelling
    // and restarting an ease-in on each chunk stalls growth, then rushes to
    // catch up when generation stops. Critical damping has no bounce.
    height.value = withSpring(next, {
      // Reach about 95% in the shared base duration. Duration-based springs
      // infer a much stiffer curve and can spend a third of a row in one frame.
      mass: 1,
      stiffness: (4.75 / (motionDuration.base / 1000)) ** 2,
      damping: 2 * 4.75 / (motionDuration.base / 1000),
      overshootClamping: true,
    }, finished => {
      if (finished && next === 0) scheduleOnRN(release);
    });
  }, [destination, height, reduced, release]);
  useLayoutEffect(() => {
    showing.value = open;
    if (open) {
      const wasMounted = contentMounted.current;
      if (!wasMounted) hasNativeMeasurement.value = false;
      contentMounted.current = true;
      setMounted(true);
      // A reopened child must first mount and report its native size. Starting
      // against the cached size here can spend most of the spring before Fabric
      // presents that child, exposing a nearly full-height first frame. An
      // interrupted exit still has its child and can retarget immediately.
      if (wasMounted && initialized.current) move(target.current, true);
    } else {
      // Remember zero even before first measurement, so a rapid open/close cannot
      // briefly lay out a full-height card on its next mount.
      initialized.current = true;
      setMeasured(true);
      move(0, true);
    }
  }, [move, open, showing, hasNativeMeasurement]);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    target.current = next;
    if (!currentOpen.current) return;
    move(target.current, initialized.current);
    hasNativeMeasurement.value = true;
    initialized.current = true;
    // Establish the measured shell before its first resize. Leaving it in
    // natural flow until the next onLayout exposes the new height for a frame,
    // then jumps back when the animation finally starts. Restored history still
    // starts at its measured size without playing an entrance.
    setMeasured(true);
  }, [move, hasNativeMeasurement]);
  const size = useAnimatedStyle(() => ({
    // Attach the animated style on the first native commit. Attaching it only
    // after measuring can apply its cached initial zero after the first height
    // update, leaving a perfectly measured composer inside a zero-height slot.
    height: measured ? height.value : undefined,
    // A new streamed line exists before onLayout reports its height. Message
    // content must remain clipped even at rest, or it flashes past the shell.
    // Composer drag surfaces opt out once settled; native menus use a Modal.
    overflow: allowOverflow && hasNativeMeasurement.value && showing.value && Math.abs(height.value - destination.value) < 0.1 ? 'visible' : 'hidden',
  }));
  useEffect(() => () => cancelAnimation(height), [height]);
  return (
    <Animated.View {...props}
      pointerEvents={open ? props.pointerEvents : 'none'}
      accessibilityElementsHidden={!open || props.accessibilityElementsHidden}
      importantForAccessibility={open ? props.importantForAccessibility : 'no-hide-descendants'}
      style={[props.style, styles.clip, size]}>
      {mounted ? <View collapsable={false} onLayout={measure}
        style={measured ? styles.content : undefined}>
        {open ? children : retained.current}
      </View> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  content: { position: 'absolute', left: 0, right: 0, top: 0 },
});
