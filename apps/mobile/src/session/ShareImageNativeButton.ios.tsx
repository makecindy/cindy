import { Host } from "@expo/ui";
import { Button, Label } from "@expo/ui/swift-ui";
import {
  disabled,
  controlSize,
  foregroundStyle,
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
        testID="session.shareImage.share"
        onPress={() => {
          if (!props.disabled) props.onPress();
        }}
        modifiers={[
          ...glassStyle,
          controlSize("large"),
          frame({ minWidth: 112, minHeight: 44 }),
          disabled(props.disabled),
        ]}
      >
        <Label
          title={props.label}
          systemImage="square.and.arrow.up"
          modifiers={[foregroundStyle(colors.ctaText)]}
        />
      </Button>
    </Host>
  );
}
