import { Host } from "@expo/ui";
import {
  BottomSheet,
  Button,
  Divider,
  Group,
  HStack,
  RNHostView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  background,
  buttonStyle,
  contentShape,
  disabled,
  foregroundStyle,
  frame,
  labelStyle,
  padding,
  presentationDetents,
  presentationDragIndicator,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { ScrollView, View } from "react-native";
import { useState } from "react";
import { radius, spacing, useTheme } from "@/theme";
import type {
  SessionDetailsAction,
  SessionDetailsNativeProps,
} from "./SessionDetailsNative";

export function SessionDetailsNative({
  visible,
  title,
  backLabel,
  onClose,
  onClosed,
  onBack,
  children,
  footer,
}: SessionDetailsNativeProps) {
  const { colors, mode } = useTheme();
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      pointerEvents="none"
      style={{ position: "absolute" }}
    >
      <BottomSheet
        isPresented={visible}
        onIsPresentedChange={(presented) => {
          if (!presented) onClose();
        }}
        onDismiss={onClosed}
      >
        <Group
          modifiers={[
            presentationDetents(["medium", "large"], { selection: "medium" }),
            presentationDragIndicator("visible"),
          ]}
        >
          <VStack spacing={0}>
            <HStack
              modifiers={[
                padding({
                  top: spacing.lg,
                  bottom: spacing.sm,
                  leading: spacing.lg,
                  trailing: spacing.lg,
                }),
              ]}
            >
              {onBack ? (
                <Button
                  label={backLabel}
                  systemImage="chevron.backward"
                  onPress={onBack}
                  modifiers={[
                    labelStyle("iconOnly"),
                    buttonStyle("glass"),
                    frame({ width: 44, height: 44 }),
                  ]}
                />
              ) : (
                <Spacer modifiers={[frame({ width: 44 })]} />
              )}
              <Spacer />
              <Text>{title}</Text>
              <Spacer />
              <Spacer modifiers={[frame({ width: 44, height: 44 })]} />
            </HStack>
            <RNHostView>
              <View style={{ flex: 1 }}>
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{
                    padding: spacing.lg,
                    paddingBottom: spacing.xxl,
                  }}
                >
                  {children}
                </ScrollView>
                {footer ? (
                  <View style={{ padding: spacing.lg }}>{footer}</View>
                ) : null}
              </View>
            </RNHostView>
          </VStack>
        </Group>
      </BottomSheet>
    </Host>
  );
}

export function SessionDetailsNativeActions({
  actions,
}: {
  actions: SessionDetailsAction[];
}) {
  const { colors, mode } = useTheme();
  const [width, setWidth] = useState(0);
  if (!actions.length) return null;
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", paddingTop: spacing.lg }}
    >
      {width > 0 ? (
        <Host
          key={width}
          colorScheme={mode}
          matchContents={{ vertical: true }}
          style={{ width }}
        >
          <VStack
            spacing={0}
            modifiers={[
              frame({ width }),
              background(
                colors.surfaceTranslucent,
                shapes.roundedRectangle({ cornerRadius: radius.container }),
              ),
            ]}
          >
            {actions.map((action, index) => (
              <Group key={action.testID}>
                {index > 0 ? (
                  <Divider modifiers={[padding({ leading: spacing.lg })]} />
                ) : null}
                <Button
                  onPress={action.onPress}
                  testID={action.testID}
                  modifiers={[
                    buttonStyle("plain"),
                    disabled(!!action.disabled),
                  ]}
                >
                  <Text
                    modifiers={[
                      foregroundStyle(
                        action.danger ? colors.destructive : colors.textPrimary,
                      ),
                      frame({ minHeight: 48 }),
                      frame({
                        width: Math.max(0, width - spacing.lg * 2),
                        alignment: "leading",
                      }),
                      padding({ leading: spacing.lg, trailing: spacing.lg }),
                      // Apply after sizing the label so empty row space receives taps too.
                      contentShape(shapes.rectangle()),
                    ]}
                  >
                    {action.label}
                  </Text>
                </Button>
              </Group>
            ))}
          </VStack>
        </Host>
      ) : null}
    </View>
  );
}
