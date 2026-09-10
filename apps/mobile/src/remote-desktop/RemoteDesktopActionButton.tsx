import { Pressable, type PressableProps } from "react-native";

// Tap-only actions. Remote keys must retain their press-in / press-out handling.
export type RemoteDesktopActionButtonProps = Pick<
  PressableProps,
  | "children"
  | "style"
  | "disabled"
  | "testID"
  | "accessibilityLabel"
  | "accessibilityState"
  | "accessibilityRole"
> & { onPress(): void };

export function RemoteDesktopActionButton(
  props: RemoteDesktopActionButtonProps,
) {
  return <Pressable {...props} />;
}
