import type { ComponentProps, ReactNode } from 'react';
import { Platform, View } from 'react-native';
import Reanimated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';

/**
 * iOS composer dock: the composer (and, in an existing task / partner chat, the
 * message viewport) follows the keyboard on the UI thread every frame, instead of
 * jumping to the end position when the keyboard event arrives (RN LayoutAnimation
 * does not run for these views in this build).
 *
 * Only iOS mounts the keyboard tracker; the choice is a platform constant, so
 * hooks never change between renders and toggling `active` never remounts the
 * composer.
 */
const TRACKS = Platform.OS === 'ios';

/**
 * Composer bottom edge: it stays at the new-task button's edge until the keyboard
 * reaches it, then rides the keyboard with a fixed gap.
 */
function dockBottom(keyboardHeight: number, restingBottom: number, keyboardGap: number): number {
  'worklet';
  return Math.max(restingBottom, keyboardHeight + keyboardGap);
}

type ViewProps = ComponentProps<typeof View>;

/** Lifts its subtree by transform (no per-frame layout for the composer). */
export function DockKeyboardLift({ active, restingBottom, keyboardGap, style, children, ...props }: ViewProps & {
  active: boolean; restingBottom: number; keyboardGap: number; children?: ReactNode;
}) {
  if (!TRACKS) return <View {...props} style={style}>{children}</View>;
  return <TrackingLift {...props} active={active} restingBottom={restingBottom} keyboardGap={keyboardGap} style={style}>{children}</TrackingLift>;
}
function TrackingLift({ active, restingBottom, keyboardGap, style, children, ...props }: ViewProps & {
  active: boolean; restingBottom: number; keyboardGap: number; children?: ReactNode;
}) {
  const keyboard = useAnimatedKeyboard();
  const lift = useAnimatedStyle(() => ({
    transform: [{ translateY: active ? restingBottom - dockBottom(keyboard.height.value, restingBottom, keyboardGap) : 0 }],
  }), [active, keyboardGap, restingBottom]);
  return <Reanimated.View {...props} style={[style, lift]}>{children}</Reanimated.View>;
}

/** Shrinks the message viewport with the keyboard, in step with the lift above. */
export function DockKeyboardViewportSpacer({ active }: { active: boolean }) {
  return TRACKS ? <TrackingSpacer active={active} /> : null;
}
function TrackingSpacer({ active }: { active: boolean }) {
  const keyboard = useAnimatedKeyboard();
  const style = useAnimatedStyle(() => ({ height: active ? keyboard.height.value : 0 }), [active]);
  return <Reanimated.View pointerEvents="none" style={style} />;
}

/** New task: the space under the composer, sized by layout so the page content above shrinks with it. */
export function DockKeyboardBottomSpacer({ restingBottom, keyboardGap }: { restingBottom: number; keyboardGap: number }) {
  const keyboard = useAnimatedKeyboard();
  const style = useAnimatedStyle(() => ({ height: dockBottom(keyboard.height.value, restingBottom, keyboardGap) }), [keyboardGap, restingBottom]);
  return <Reanimated.View pointerEvents="none" style={style} />;
}
