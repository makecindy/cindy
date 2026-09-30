import { useNativeGlassGroupStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { NativeChromeBackButton } from "@/platform/chrome/NativeChromeBackButton.ios";
import { navigationChrome } from "@/theme/tokens";
import { Host } from "@expo/ui";
import {
  Button,
  HStack,
  Mask,
  Rectangle,
  RNHostView,
  VStack,
} from "@expo/ui/swift-ui";
import { Folder, Monitor, Pin, type LucideIcon } from "lucide-react-native";
import { View } from "react-native";
import { Text } from "@/components/AppText";
import { QuietSyncIndicator } from "@/components/QuietSyncIndicator";
import { TaskTagDots } from './TaskTags';
import {
  accessibilityHint,
  accessibilityElement,
  accessibilityLabel,
  background,
  buttonStyle,
  contentShape,
  disabled,
  frame,
  foregroundStyle,
  labelStyle,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import {
  iconSize,
  iconStroke,
  lineHeight,
  spacing,
  typeScale,
  fontWeight,
  useTheme,
} from "@/theme";
import { BlurBackdrop } from "./BlurBackdrop";
import type {
  SessionHeaderNativeActionsProps,
  SessionHeaderNativeBackProps,
  SessionHeaderNativeTitleProps,
} from "./SessionHeaderNativeControls";

/** A stationary, feathered backdrop: scrolling content passes beneath it. */
/** Fade length at the content edge; the chrome area itself stays fully blurred. */
const BLUR_FADE = 32;
/**
 * A two-stop gradient left the title row at roughly half blur, so text that
 * scrolled under a header stayed legible and read as overlapping it. Keep the
 * mask opaque over the chrome and fade only the last BLUR_FADE points
 * (evenly spaced stops approximate the break point).
 */
function blurMaskStops(height: number): string[] {
  const solid = Math.max(1, Math.round(height / Math.min(BLUR_FADE, height / 2)) - 1);
  return [...Array<string>(solid).fill("black"), "transparent"];
}

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
                  colors: edge === 'top' ? blurMaskStops(height) : blurMaskStops(height).reverse(),
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

export function SessionHeaderNativeTitle({ title,
  tags,
  onTagsPress,
  pinned, syncing, syncingImmediately, notice }: SessionHeaderNativeTitleProps) {
  const { colors } = useTheme();
  const style = {
    alignSelf: 'center' as const,
    maxWidth: '100%' as const,
    minHeight: 44,
    justifyContent: "center" as const,
    paddingHorizontal: spacing.xs / 2,
  };
  const label = (
    <Text
      numberOfLines={1}
      accessibilityRole="header"
      style={{
        color: colors.textPrimary,
        fontSize: typeScale.body,
        lineHeight: lineHeight.body,
        fontWeight: fontWeight.semibold,
        textAlign: "center",
        flexShrink: 1,
        minWidth: 0,
      }}
      testID="session.title"
    >
      {title}
    </Text>
  );
  return (
    <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
      <View style={style}>
        {/* The title sits directly on the bar: no capsule material behind it. */}
        <View style={{ flexDirection: "row", minWidth: 0, alignItems: "center", justifyContent: "center", gap: spacing.xs }}>
          {pinned ? <Pin color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} /> : null}
          {label}
          <TaskTagDots
            tags={tags}
            maxVisible={7}
            surfaceColor={colors.surface}
            onPress={onTagsPress}
          />
          <QuietSyncIndicator active={syncing} immediate={syncingImmediately} />
        </View>
        {notice ? (
          <Text numberOfLines={1} testID="session.headerNotice"
            style={{ color: colors.textSecondary, fontSize: typeScale.micro, lineHeight: lineHeight.micro, textAlign: "center" }}>
            {notice}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function SessionHeaderNativeBack({
  label,
  onPress,
}: SessionHeaderNativeBackProps) {
  return <NativeChromeBackButton label={label} onPress={onPress} testID="session.backButton" />;
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
  detailsOnly = false,
}: SessionHeaderNativeActionsProps) {
  const { colors, mode } = useTheme();
  const groupStyle = useNativeGlassGroupStyle();
  const iconModifiers = [
    labelStyle("iconOnly"),
    buttonStyle("borderless"),
    frame({ width: navigationChrome.target, height: navigationChrome.target }),
  ];
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      ignoreSafeArea="all"
      style={{ width: navigationChrome.target * (detailsOnly ? 1 : 3), height: navigationChrome.target }}
    >
      <HStack
        spacing={0}
        modifiers={groupStyle}
      >
        {detailsOnly ? null : <>
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
        </>}
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
        frame({ width: navigationChrome.target, height: navigationChrome.target }),
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
