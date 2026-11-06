import { useLayoutEffect } from "react";
import {
  Keyboard,
  useWindowDimensions,
  type KeyboardEvent,
  type KeyboardMetrics,
} from "react-native";
import {
  KeyboardState,
  useAnimatedKeyboard,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import {
  iosKeyboardOverlap,
  loadDockedKeyboardHeights,
  subscribeDockedKeyboardHeights,
} from "@/session/keyboardOverlap";

/** Keep UI-thread motion, but use the public keyboard frame once it settles.
 * Reanimated 4.5's iOS observer only subscribes to show/hide and can retain an
 * old height when a third-party keyboard resizes without hiding. Its private
 * keyboard-view measurement can also differ from the notification's full frame.
 */
export function useComposerDockKeyboardHeight() {
  const keyboard = useAnimatedKeyboard();
  const viewport = useWindowDimensions();
  const settledHeight = useSharedValue(-1);

  useLayoutEffect(() => {
    loadDockedKeyboardHeights();
    // Same judgement as the composer card, including iOS's impossible frames after PiP.
    const overlap = (frame: KeyboardMetrics | undefined) =>
      !frame || frame.screenY === 0 ? 0 : iosKeyboardOverlap(frame, viewport);
    let lastFrame: KeyboardMetrics | undefined = Keyboard.isVisible()
      ? Keyboard.metrics()
      : undefined;
    settledHeight.value = Keyboard.isVisible() ? overlap(lastFrame) : -1;
    const settle = (event: KeyboardEvent) => {
      lastFrame = event.endCoordinates;
      settledHeight.value = overlap(lastFrame);
    };
    const invalidate = () => {
      settledHeight.value = -1;
    };
    const subscriptions = [
      Keyboard.addListener("keyboardWillShow", invalidate),
      Keyboard.addListener("keyboardWillHide", invalidate),
      Keyboard.addListener("keyboardDidShow", settle),
      Keyboard.addListener("keyboardDidChangeFrame", settle),
      Keyboard.addListener("keyboardDidHide", () => {
        lastFrame = undefined;
        settledHeight.value = 0;
      }),
    ];
    // Saved heights arrive asynchronously; recompute a settled keyboard that
    // used the estimate. -1 (moving/not settled) and 0 (hidden) stay as they are.
    const unsubscribe = subscribeDockedKeyboardHeights(() => {
      if (lastFrame && settledHeight.value >= 0) {
        settledHeight.value = overlap(lastFrame);
      }
    });
    return () => {
      unsubscribe();
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [settledHeight, viewport.width, viewport.height]);

  return useDerivedValue(() => {
    // Interactive dismissal/cancellation must keep following the native frames;
    // a settled height is not a minimum, or it would pin the composer in place.
    const moving =
      keyboard.state.value === KeyboardState.OPENING ||
      keyboard.state.value === KeyboardState.CLOSING;
    return !moving && settledHeight.value >= 0
      ? settledHeight.value
      : keyboard.height.value;
  });
}
