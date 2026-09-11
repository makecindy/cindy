import { Host } from "@expo/ui";
import { Button, RNHostView, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityIdentifier,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled,
  frame,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { StyleSheet, View } from "react-native";
import { useTheme } from "@/theme";
import type { RemoteDesktopActionButtonProps } from "./RemoteDesktopActionButton";

export function RemoteDesktopActionButton(
  props: RemoteDesktopActionButtonProps,
) {
  const { mode } = useTheme();
  const state = { pressed: false };
  const style = StyleSheet.flatten(
    typeof props.style === "function" ? props.style(state) : props.style,
  );
  const children =
    typeof props.children === "function"
      ? props.children(state)
      : props.children;
  return (
    <View style={style}>
      {/* Preserve intrinsic text height in Yoga, including larger text and translations. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          opacity: 0,
          alignSelf: "stretch",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: style?.flexDirection,
          gap: style?.gap,
        }}
      >
        {children}
      </View>
      <Host
        colorScheme={mode}
        ignoreSafeArea="all"
        style={StyleSheet.absoluteFill}
      >
        <Button
          onPress={() => {
            if (!props.disabled) props.onPress();
          }}
          modifiers={[
            buttonStyle("plain"),
            disabled(Boolean(props.disabled)),
            frame({ maxWidth: Infinity, maxHeight: Infinity }),
            accessibilityElement("ignore"),
            accessibilityLabel(props.accessibilityLabel ?? ""),
            accessibilityIdentifier(props.testID ?? ""),
            accessibilityAddTraits(
              props.accessibilityState?.selected
                ? ["isSelected", "isButton"]
                : ["isButton"],
            ),
          ]}
        >
          <VStack
            spacing={0}
            modifiers={[
              frame({ maxWidth: Infinity, maxHeight: Infinity }),
              contentShape(shapes.rectangle()),
            ]}
          >
            <RNHostView>
              <View
                pointerEvents="none"
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: style?.flexDirection,
                  gap: style?.gap,
                  padding: style?.padding,
                }}
              >
                {children}
              </View>
            </RNHostView>
          </VStack>
        </Button>
      </Host>
    </View>
  );
}
