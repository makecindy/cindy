import { Host } from "@expo/ui";
import { Button, RNHostView, VStack } from "@expo/ui/swift-ui";
import type { ComponentProps, ReactNode } from "react";
import { View } from "react-native";
import {
  accessibilityElement,
  accessibilityLabel,
  disabled as disabledModifier,
  frame,
  font,
  labelStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useNativeGlassButtonStyle } from "./nativeGlassButtonStyle.ios";
import { iconSize, navigationChrome, useTheme } from "@/theme";

export function NativeChromeButton({
  label,
  systemImage,
  children,
  onPress,
  testID,
  disabled = false,
  glassVariant = "regular",
  prominent = false,
  size = navigationChrome.target,
  artworkSize = iconSize.action,
}: {
  testID: string;
  disabled?: boolean;
  systemImage?: ComponentProps<typeof Button>["systemImage"];
  children?: ReactNode;
  glassVariant?: "regular" | "clear";
  prominent?: boolean;
  size?: number;
  artworkSize?: number;
  label: string;
  onPress(): void;
}) {
  const { colors, mode } = useTheme();
  const clearPalette = navigationChrome.clear[mode];
  const clearGlass = glassVariant === "clear";
  const glassStyle = useNativeGlassButtonStyle({ shape: "circle", clear: clearGlass, prominent, size });

  return (
    <Host
      colorScheme={mode}
      seedColor={prominent ? colors.cta : clearGlass ? clearPalette.foreground : colors.textPrimary}
      ignoreSafeArea="all"
      style={{ width: size, height: size }}
    >
      <Button
        label={children ? undefined : label}
        systemImage={systemImage}
        onPress={() => { if (!disabled) onPress(); }}
        testID={testID}
        modifiers={[
          labelStyle("iconOnly"),
          accessibilityElement("ignore"),
          accessibilityLabel(label),
          disabledModifier(disabled),
          font({ size: artworkSize }),
          ...glassStyle,
        ]}
      >
        {children ? (
          <VStack modifiers={[frame({ width: artworkSize, height: artworkSize })]}>
            <RNHostView>
              <View pointerEvents="none" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                {children}
              </View>
            </RNHostView>
          </VStack>
        ) : undefined}
      </Button>
    </Host>
  );
}
