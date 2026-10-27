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
import { isDockedKeyboard } from "@/auth/loginKeyboardAvoidance";

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
    const overlap = (frame: KeyboardMetrics | undefined) => {
      if (!frame || frame.screenY === 0) return 0;
      return isDockedKeyboard(
        { x: frame.screenX, y: frame.screenY, ...frame },
        viewport.width,
      ) && frame.screenY + frame.height >= viewport.height
        ? Math.max(0, Math.min(frame.height, viewport.height - frame.screenY))
        : 0;
    };
    settledHeight.value = Keyboard.isVisible()
      ? overlap(Keyboard.metrics())
      : -1;
    const settle = (event: KeyboardEvent) => {
      settledHeight.value = overlap(event.endCoordinates);
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
        settledHeight.value = 0;
      }),
    ];
    return () => {
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
