import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { ScrollView } from 'react-native';
import {
  cancelAnimation, runOnUI, scrollTo, useAnimatedReaction,
  useAnimatedRef, useScrollOffset, useSharedValue, withSpring,
} from 'react-native-reanimated';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration } from '@/theme/tokens';
import { useNativeKeyboardTransition } from './useNativeKeyboardTransition';
import type { NativeChatViewportHandle } from './NativeChatViewport';

/** One UI-thread trajectory owns the native offset; never translate the scroll viewport.
 * A compensating transform and Fabric's scroll command can land on different frames,
 * exposing the very jump they were intended to hide, especially during keyboard resize.
 * Collapsing content already animates its occupied height, so native range clamping
 * follows that height rather than requiring a second, inverse animation.
 */
export function useSmoothMessageFollow(ready: boolean, nativeKeyboardOwned = false, nativeFollower?: RefObject<NativeChatViewportHandle | null>) {
  const scrollRef = useAnimatedRef<ScrollView>();
  const attachScrollRef = useCallback((view: ScrollView | null) => { scrollRef(view); }, [scrollRef]);
  const scrollOffset = useScrollOffset(scrollRef);
  const position = useSharedValue(0);
  const destination = useSharedValue<number | null>(null);
  const following = useSharedValue(false);
  const keyboardTransition = useNativeKeyboardTransition();
  const reduceMotion = useReduceMotionEnabled();
  const allowed = useRef(false);
  allowed.current = ready && reduceMotion === false;

  useAnimatedReaction(() => position.value, next => {
    if (following.value && !(nativeKeyboardOwned && keyboardTransition?.value)) scrollTo(scrollRef, 0, next, false);
  });
  useAnimatedReaction(() => nativeKeyboardOwned && keyboardTransition?.value === true, moving => {
    if (!moving) return;
    following.value = false;
    cancelAnimation(position);
    destination.value = null;
  });

  const cancel = useCallback(() => {
    nativeFollower?.current?.cancelFollowing();
    runOnUI(() => {
      'worklet';
      following.value = false;
      cancelAnimation(position);
      destination.value = null;
      // The native view already occupies its visible position. A touch must not
      // issue another scroll command or take over the user's drag/momentum.
    })();
  }, [destination, following, position, nativeFollower]);

  const move = useCallback((target: number, animate: boolean) => {
    if (nativeFollower?.current) {
      nativeFollower.current.moveTo(Math.max(0, target), animate && allowed.current);
      return;
    }
    runOnUI((end: number, smooth: boolean) => {
      'worklet';
      if (nativeKeyboardOwned && keyboardTransition?.value) return;
      if (smooth && following.value && destination.value !== null && Math.abs(end - destination.value) < 0.1) return;
      if (!following.value) position.value = scrollOffset.value;
      following.value = true;
      destination.value = end;
      if (smooth) {
        // Retarget the existing velocity; repeated layout/token measurements
        // must not restart an ease-in and postpone movement until the final chunk.
        position.value = withSpring(end, {
          duration: motionDuration.base, dampingRatio: 1, overshootClamping: true,
        });
      } else {
        cancelAnimation(position);
        position.value = end;
        // Initial/history positioning also retries when the value hasn't changed.
        scrollTo(scrollRef, 0, end, false);
      }
    })(Math.max(0, target), animate && allowed.current);
  }, [destination, following, position, scrollOffset, scrollRef, nativeKeyboardOwned, keyboardTransition, nativeFollower]);

  useEffect(() => {
    if (!ready || reduceMotion !== false) cancel();
  }, [cancel, ready, reduceMotion]);
  useEffect(() => cancel, [cancel]);
  return { scrollRef: attachScrollRef, nativeScrollRef: scrollRef, scrollOffset, move, cancel };
}
