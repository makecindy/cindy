import { Host } from "@expo/ui";
import { Button } from "@expo/ui/swift-ui";
import {
  disabled,
  frame,
} from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "@/theme";
import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import type { ShareImageNativeButtonProps } from "./ShareImageNativeButton";

export function ShareImageNativeButton(props: ShareImageNativeButtonProps) {
  const { colors, mode } = useTheme();
  const glassStyle = useNativeGlassButtonStyle({ prominent: true });

  return (
    <Host
      colorScheme={mode}
      seedColor={colors.cta}
      ignoreSafeArea="all"
      matchContents
      style={{ flexShrink: 0 }}
    >
      <Button
        label={props.label}
        systemImage="square.and.arrow.up"
        testID="session.shareImage.share"
        onPress={() => {
          if (!props.disabled) props.onPress();
        }}
        modifiers={[
          ...glassStyle,
          frame({ minWidth: 112, minHeight: 44 }),
          disabled(props.disabled),
        ]}
      />
    </Host>
  );
}
