import { Pressable, type PressableProps } from "react-native";

// Tap-only actions. Remote keys must retain their press-in / press-out handling.
export type RemoteDesktopActionButtonProps = Pick<
  PressableProps,
  | "children"
  | "style"
  | "disabled"
  | "testID"
  | "accessibilityLabel"
  | "accessibilityHint"
  | "accessibilityState"
  | "accessibilityRole"
> & { onPress(): void; variant?: "plain" | "glass"; systemImage?: string };

export function RemoteDesktopActionButton(
  props: RemoteDesktopActionButtonProps,
) {
  const {
    variant: _variant,
    systemImage: _systemImage,
    ...pressableProps
  } = props;
  return <Pressable {...pressableProps} />;
}
