import { Host } from "@expo/ui";
import {
  Button,
  HStack,
  Mask,
  Rectangle,
  RNHostView,
  VStack,
} from "@expo/ui/swift-ui";
import { Folder, Monitor, type LucideIcon } from "lucide-react-native";
import { View } from "react-native";
import { Text } from "@/components/AppText";
import {
  accessibilityHint,
  accessibilityElement,
  accessibilityLabel,
  background,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  contentShape,
  disabled,
  frame,
  foregroundStyle,
  glassEffect,
  labelStyle,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import {
  iconSize,
  iconStroke,
  radius,
  spacing,
  typeScale,
  fontWeight,
  useTheme,
} from "@/theme";
import { useLiquidGlassAvailable } from "./useLiquidGlassAvailable";
import { BlurBackdrop } from "./BlurBackdrop";
import type {
  SessionHeaderNativeActionsProps,
  SessionHeaderNativeBackProps,
} from "./SessionHeaderNativeControls";

/** A stationary, feathered backdrop: scrolling content passes beneath it. */
export function SessionHeaderNativeBlur({ height, edge = 'top', inset = 0 }: { height: number; edge?: 'top' | 'bottom'; inset?: number }) {
  const { mode } = useTheme();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      style={{
        position: "absolute",
        ...(edge === 'top' ? { top: inset } : { bottom: inset }),
        left: 0,
        right: 0,
        height,
        zIndex: 9,
      }}
    >
      <Host colorScheme={mode} ignoreSafeArea="all" style={{ flex: 1 }}>
        <Mask modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}>
          <RNHostView>
            <View style={{ flex: 1 }}>
              <BlurBackdrop intensity={55} overlayColor="transparent" />
            </View>
          </RNHostView>
          <Mask.Content>
            <Rectangle
              modifiers={[
                foregroundStyle({
                  type: "linearGradient",
                  // Mask colors encode alpha only; they never tint the content.
                  colors: edge === 'top' ? ["black", "transparent"] : ["transparent", "black"],
                  startPoint: { x: 0.5, y: 0 },
                  endPoint: { x: 0.5, y: 1 },
                }),
              ]}
            />
          </Mask.Content>
        </Mask>
      </Host>
    </View>
  );
}

export function SessionHeaderNativeTitle({ title }: { title: string }) {
  const { colors } = useTheme();
  const style = {
    borderRadius: radius.pill,
    minHeight: 44,
    justifyContent: "center" as const,
    paddingHorizontal: spacing.md,
    overflow: "hidden" as const,
  };
  const label = (
    <Text
      numberOfLines={1}
      accessibilityRole="header"
      style={{
        color: colors.textPrimary,
        fontSize: typeScale.body,
        fontWeight: fontWeight.semibold,
        textAlign: "center",
      }}
      testID="session.title"
    >
      {title}
    </Text>
  );
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={style}>
        <BlurBackdrop intensity={20} overlayColor={colors.surfaceTranslucent} />
        {label}
      </View>
    </View>
  );
}

export function SessionHeaderNativeBack({
  label,
  onPress,
}: SessionHeaderNativeBackProps) {
  const { colors, mode } = useTheme();
  const glass = useLiquidGlassAvailable();
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      ignoreSafeArea="all"
      style={{ width: 44, height: 44 }}
    >
      <Button
        label={label}
        systemImage="chevron.backward"
        onPress={onPress}
        testID="session.backButton"
        modifiers={[
          labelStyle("iconOnly"),
          buttonStyle(glass ? "glass" : "bordered"),
          buttonBorderShape("circle"),
          controlSize("large"),
          frame({ width: 44, height: 44 }),
        ]}
      />
    </Host>
  );
}

/** Native SwiftUI buttons share one system capsule. */
export function SessionHeaderNativeActions({
  available,
  desktopLabel,
  filesLabel,
  moreLabel,
  files,
  onDetails,
  onDesktop,
  onAction,
}: SessionHeaderNativeActionsProps) {
  const { colors, mode } = useTheme();
  const glass = useLiquidGlassAvailable();
  const iconModifiers = [
    labelStyle("iconOnly"),
    buttonStyle("borderless"),
    controlSize("large"),
    frame({ width: 44, height: 44 }),
  ];
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      ignoreSafeArea="all"
      style={{ width: 132, height: 44 }}
    >
      <HStack
        spacing={0}
        modifiers={[
          ...(glass
            ? [glassEffect({ glass: { variant: "regular" }, shape: "capsule" })]
            : [background(colors.surfaceElevated, shapes.capsule())]),
        ]}
      >
        <Button
          onPress={onDesktop}
          testID="session.remoteDesktop"
          modifiers={[
            ...iconModifiers,
            disabled(!available),
            accessibilityElement("ignore"),
            accessibilityLabel(desktopLabel),
          ]}
        >
          <SessionHeaderIcon icon={Monitor} color={colors.textPrimary} />
        </Button>
        <Button
          onPress={() => onAction("files")}
          testID="session.filesButton"
          modifiers={[
            ...iconModifiers,
            disabled(!available || !files || files.disabled),
            accessibilityElement("ignore"),
            accessibilityLabel(filesLabel),
            accessibilityHint(files?.disabledReason ?? ""),
          ]}
        >
          <SessionHeaderIcon icon={Folder} color={colors.textPrimary} />
        </Button>
        <Button
          label={moreLabel}
          systemImage="ellipsis"
          testID="session.controlsToggle"
          onPress={onDetails}
          modifiers={[...iconModifiers, disabled(!available)]}
        />
      </HStack>
    </Host>
  );
}

/** Keep the existing Lucide artwork inside the native button's 44pt hit area. */
function SessionHeaderIcon({
  icon: Icon,
  color,
}: {
  icon: LucideIcon;
  color: string;
}) {
  return (
    <VStack
      spacing={0}
      modifiers={[
        frame({ width: 44, height: 44 }),
        contentShape(shapes.rectangle()),
      ]}
    >
      <RNHostView>
        <View
          pointerEvents="none"
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <Icon
            color={color}
            size={iconSize.action}
            strokeWidth={iconStroke.regular}
          />
        </View>
      </RNHostView>
    </VStack>
  );
}
