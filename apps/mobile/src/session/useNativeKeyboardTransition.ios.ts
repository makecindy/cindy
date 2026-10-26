import { KeyboardState, useAnimatedKeyboard, useDerivedValue } from 'react-native-reanimated';

/** Native keyboard ownership must reach the scroll worklet before a delayed
 * React event can cancel the old tail trajectory. */
export function useNativeKeyboardTransition() {
  const keyboard = useAnimatedKeyboard();
  return useDerivedValue(() => keyboard.state.value === KeyboardState.OPENING
    || keyboard.state.value === KeyboardState.CLOSING);
}
