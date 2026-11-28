import { useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { Host, HStack, Image, Text, VStack, Button } from "@expo/ui/swift-ui";
import { background, buttonStyle, clipShape, contentShape, controlSize, disabled, fixedSize, font, foregroundStyle, frame, onGeometryChange, padding, shapes } from "@expo/ui/swift-ui/modifiers";
import { iconSize, radius, spacing, useTheme } from "@/theme";
import type { PluginNoticeProps } from "./PluginNotice";

/** A compact status strip; SwiftUI owns label and button layout. */
export function PluginNativeNotice({ title, detail, icon = "info", testID, actions, unavailable, compact = false, onPress }: PluginNoticeProps) {
  const { colors } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const availableWidth = measuredWidth || width - (spacing.lg + spacing.xs) * 2;
  // Keep native button labels intact on narrow screens and with larger accessibility text.
  const stackedActions = (actions?.length ?? 0) > 1 || (!unavailable && !!detail) || availableWidth < 340 || fontScale > 1.2;
  const systemImage = icon === "offline" ? "desktopcomputer.trianglebadge.exclamationmark" : icon === "warning" ? "exclamationmark.circle" : "info.circle";
  // Beside the text a button keeps its one-line width; stacked under it (narrow, large text) it may wrap within the
  // notice instead, so a long label at the largest sizes (German "Erneut versuchen") never pushes the notice past the
  // screen edge (dispatcher M-3).
  // A notice the whole of which opens something (dispatcher P-2) is one button: its action shows as a label inside it, so
  // the tap target is the full row however the text wraps (no button within a button).
  const buttons = onPress ? actions?.map((action) => <Text key={action.label} testID={action.testID}
    modifiers={[font({ textStyle: "subheadline", weight: "semibold" }), foregroundStyle(colors.textPrimary),
      fixedSize({ horizontal: false, vertical: true })]}>{action.label}</Text>)
    : actions?.map((action) => <Button
    key={action.label} label={action.label} testID={action.testID} onPress={action.onPress}
    modifiers={[buttonStyle("bordered"), controlSize("small"),
      fixedSize(stackedActions ? { horizontal: false, vertical: true } : { horizontal: true, vertical: false }),
      frame({ minHeight: 44 }), disabled(Boolean(action.disabled))]}
  />);
  const notice = <VStack testID={onPress ? (testID ? testID + ".label" : undefined) : testID} alignment="leading" spacing={spacing.sm}
    modifiers={[
      padding({ horizontal: compact ? 0 : spacing.md, vertical: spacing.xs }),
      frame({ minHeight: 48, maxWidth: Infinity, alignment: "leading" }),
      ...(compact ? [] : [background(colors.surfaceChip), clipShape("roundedRectangle", radius.container)]),
      onGeometryChange(({ width: nextWidth }) => setMeasuredWidth((previous) => previous === nextWidth ? previous : nextWidth)),
      // A plain button hit-tests only what it draws: a compact notice has no background, so the space beside the text
      // (under the icon at large text sizes) took no taps (dispatcher U-1). Its whole frame, padding included, takes them.
      ...(onPress ? [contentShape(shapes.rectangle())] : []),
    ]}>
    <HStack alignment={stackedActions ? "top" : "center"} spacing={spacing.sm}>
      <VStack modifiers={[frame({ width: iconSize.md, alignment: "top" })]}>
        <Image systemName={systemImage} size={iconSize.md} modifiers={[foregroundStyle(colors.textSecondary)]} />
      </VStack>
      <VStack alignment="leading" spacing={spacing.sm} modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}>
        <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(colors.textPrimary), fixedSize({ horizontal: false, vertical: true })]}>{title}</Text>
        {!unavailable && detail ? <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary), fixedSize({ horizontal: false, vertical: true })]}>{detail}</Text> : null}
        {stackedActions ? buttons : null}
      </VStack>
      {!stackedActions ? buttons : null}
    </HStack>
  </VStack>;
  return onPress ? <Button testID={testID} onPress={onPress} modifiers={[buttonStyle("plain"), frame({ maxWidth: Infinity, alignment: "leading" })]}>
    {notice}
  </Button> : notice;
}
export function PluginNotice(props: PluginNoticeProps) {
  const { mode } = useTheme();
  const [width, setWidth] = useState(0);
  return (
    <View
      testID={props.testID ? props.testID + ".layout" : undefined}
      collapsable={false}
      style={{ width: "100%", minHeight: 44 }}
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
    >
      {width > 0 ? (
        <Host colorScheme={mode} matchContents={{ vertical: true }} style={{ width }}>
          <VStack modifiers={[frame({ width, alignment: "leading" })]}>
            <PluginNativeNotice {...props} />
          </VStack>
        </Host>
      ) : null}
    </View>
  );
}
