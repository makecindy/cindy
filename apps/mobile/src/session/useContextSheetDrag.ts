import { useCallback, useEffect, useMemo, useRef } from 'react';
import { PanResponder } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { cancelAnimation, Easing, runOnJS, runOnUI, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Gesture } from '@/platform/gestureHandler';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme';
import { applyContextSheetDrag, settleContextSheetDrag, type ContextSheetSnap, type ContextSheetSnapHeights } from '@/session/contextSheetModel';

export interface UseContextSheetDragInput {
  heights: ContextSheetSnapHeights;
  snap: ContextSheetSnap;
  onSnapChange: (snap: ContextSheetSnap) => void;
  onDismiss: () => void;
}

const isStoreClient = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

function hasDragMoved(start: number, current: number): boolean {
  'worklet';
  return Math.abs(current - start) >= 3;
}

/** Pointer updates and snap animations stay on UI; JS only receives the result. */
export function useContextSheetDrag(input: UseContextSheetDragInput) {
  const latest = useRef(input);
  latest.current = input;
  const reduceMotion = useReduceMotionEnabled();
  const height = useSharedValue(input.heights[input.snap]);
  const startHeight = useSharedValue(height.value);
  const active = useSharedValue(false);
  // Keep the release destination even before JS acknowledges the snap.
  // A tap that interrupts an in-flight snap animation must return here.
  const settledSnap = useSharedValue(input.snap);
  const gestureId = useSharedValue(0);
  const mounted = useRef(true);
  const lastNotification = useRef<{ snap: ContextSheetSnap; id: number } | null>(null);
  const geometry = useSharedValue({ heights: input.heights, snap: input.snap });
  const notify = useCallback((target: ContextSheetSnap | 'dismiss', id: number) => {
    if (!mounted.current || id !== gestureId.value) return;
    if (target === 'dismiss') latest.current.onDismiss();
    else {
      lastNotification.current = { snap: target, id };
      // Do not compare with props: an earlier notification can still be waiting
      // for React to commit, including a full -> half return to the old value.
      latest.current.onSnapChange(target);
    }
  }, [gestureId]);
  useEffect(() => {
    const nextGeometry = { heights: input.heights, snap: input.snap };
    const duration = reduceMotion === false ? motionDuration.fast : 0;
    const notification = lastNotification.current;
    const observedGesture = notification?.snap === input.snap ? notification.id : gestureId.value;
    runOnUI((next: typeof nextGeometry, durationMs: number, observed: number) => {
      'worklet';
      if (next.snap !== geometry.value.snap && observed === gestureId.value) settledSnap.value = next.snap;
      geometry.value = next;
      // Rotation/reduced-motion changes retain the user's release destination.
      // Only an explicit external snap change replaces it.
      if (active.value) {
        height.value = Math.min(height.value, next.heights.full);
        return;
      }
      height.value = withTiming(next.heights[settledSnap.value], {
        duration: durationMs,
        easing: Easing.bezier(...motionEasing.move),
      });
    })(nextGeometry, duration, observedGesture);
  }, [active, geometry, gestureId, height, input.heights.half, input.heights.full, input.snap, reduceMotion, settledSnap]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAnimation(height);
    };
  }, [height]);

  const gesture = useMemo(() => Gesture.Pan()
    // Header buttons remain tappable; only a vertical drag claims the header.
    .activeOffsetY([-3, 3])
    .failOffsetX([-12, 12])
    .onBegin(() => {
      'worklet';
      cancelAnimation(height);
      gestureId.value += 1;
      active.value = true;
      startHeight.value = height.value;
    })
    .onUpdate((event) => {
      'worklet';
      height.value = applyContextSheetDrag({ heights: geometry.value.heights, startHeight: startHeight.value, translationY: event.translationY });
    })
    .onFinalize((_event, successful) => {
      'worklet';
      active.value = false;
      const current = geometry.value;
      const id = gestureId.value;
      const target = successful && hasDragMoved(startHeight.value, height.value)
        ? settleContextSheetDrag({ draggedHeight: height.value, heights: current.heights })
        : settledSnap.value;
      if (target === 'dismiss') {
        runOnJS(notify)(target, id);
        return;
      }
      settledSnap.value = target;
      // The semantic result survives animation cancellation (rotation, a new
      // touch, reduced motion); animation completion is presentation only.
      runOnJS(notify)(target, id);
      height.value = withTiming(current.heights[target], {
        duration: reduceMotion === false ? motionDuration.fast : 0,
        easing: Easing.bezier(...motionEasing.move),
      });
    }), [active, geometry, gestureId, height, notify, reduceMotion, settledSnap, startHeight]);

  // Preserve Expo Go's adapter fallback. Installed apps attach only the UI gesture.
  const panHandlers = useMemo(() => {
    if (!isStoreClient) return {};
    const settle = (successful: boolean) => {
      active.value = false;
      // A tap or cancellation resumes the release destination, even while its
      // animation or React acknowledgement is still pending.
      if (!successful || !hasDragMoved(startHeight.value, height.value)) {
        height.value = withTiming(latest.current.heights[settledSnap.value], { duration: reduceMotion === false ? motionDuration.fast : 0 });
        return;
      }
      const target = settleContextSheetDrag({ draggedHeight: height.value, heights: latest.current.heights });
      if (target === 'dismiss') notify(target, gestureId.value);
      else {
        settledSnap.value = target;
        height.value = withTiming(latest.current.heights[target], { duration: reduceMotion === false ? motionDuration.fast : 0 });
        notify(target, gestureId.value);
      }
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        cancelAnimation(height);
        gestureId.value += 1;
        startHeight.value = height.value;
        active.value = true;
      },
      onPanResponderMove: (_event, event) => {
        height.value = applyContextSheetDrag({ heights: latest.current.heights, startHeight: startHeight.value, translationY: event.dy });
      },
      onPanResponderRelease: () => settle(true),
      onPanResponderTerminate: () => settle(false),
      onPanResponderTerminationRequest: () => false,
    }).panHandlers;
  }, [active, gestureId, height, notify, reduceMotion, settledSnap, startHeight]);

  const animatedStyle = useAnimatedStyle(() => ({ height: height.value }));
  return { animatedStyle, gesture, panHandlers };
}
