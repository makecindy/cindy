import { RemoteDesktopActionButton } from "./RemoteDesktopActionButton";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  Keyboard,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react-native";
import { AllWindowsIcon, ShowDesktopIcon } from "./RemoteDesktopIcons";
import { RemoteDesktopPanelButton } from "./RemoteDesktopPanelButton";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  iconSize,
  iconStroke,
  fontWeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

export function RemoteDesktopToolbar({
  landscape,
  canControl,
  keyboard,
  operations,
  onWindows,
  onDesktop,
  onKeyboard,
  onOperations,
}: {
  landscape: boolean;
  canControl: boolean;
  keyboard: boolean;
  operations: boolean;
  onWindows(): void;
  onDesktop(): void;
  onKeyboard(): void;
  onOperations(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const actions: Array<{
    key: string;
    icon: LucideIcon;
    press(): void;
    selected?: boolean;
    disabled?: boolean;
  }> = [
    {
      key: "allWindows",
      icon: AllWindowsIcon,
      press: onWindows,
      disabled: !canControl,
    },
    {
      key: "showDesktop",
      icon: ShowDesktopIcon,
      press: onDesktop,
      disabled: !canControl,
    },
    {
      key: "keyboard",
      icon: Keyboard,
      press: onKeyboard,
      selected: keyboard,
      disabled: !canControl,
    },
    {
      key: "operations",
      icon: SlidersHorizontal,
      press: onOperations,
      selected: operations,
    },
  ];
  return (
    <View
      style={[styles.toolbar, landscape && styles.rail]}
      testID="remoteDesktop.toolbar"
    >
      {(landscape ? [...actions].reverse() : actions).map(
        ({ key, icon: Icon, press, selected, disabled }) => (
          <RemoteDesktopActionButton
            key={key}
            testID={`remoteDesktop.${key}`}
            accessibilityRole="button"
            accessibilityLabel={t(`remoteDesktop.${key}`)}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={press}
            style={({ pressed }) => [
              styles.tool,
              landscape && styles.railTool,
              (pressed || selected) && styles.selected,
              disabled && styles.disabled,
            ]}
          >
            <Icon
              size={iconSize.action}
              strokeWidth={iconStroke.regular}
              color={colors.textPrimary}
            />
            <Text numberOfLines={2} style={styles.label}>
              {t(`remoteDesktop.${key}`)}
            </Text>
          </RemoteDesktopActionButton>
        ),
      )}
    </View>
  );
}

// Keep the panel inside the viewport so it can anchor at the bottom or right
// without covering the four tools or resizing the remote desktop underneath it.
export function RemoteDesktopPanel({
  landscape,
  topInset,
  title,
  caption,
  onClose,
  onBack,
  page,
  children,
  footer,
}: {
  landscape: boolean;
  topInset: number;
  title: string;
  caption: string;
  onClose(): void;
  onBack?(): void;
  page?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={StyleSheet.absoluteFill}
      testID="remoteDesktop.operationsPanel"
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel={t("remoteDesktop.close")}
        accessibilityRole="button"
      />
      <View
        accessibilityViewIsModal
        testID="remoteDesktop.panelSurface"
        style={[
          styles.panel,
          landscape ? styles.sidePanel : styles.bottomPanel,
          { top: landscape ? topInset : undefined },
        ]}
      >
        <View style={styles.panelHeader}>
          <View style={styles.close}>
            {onBack && (
              <RemoteDesktopPanelButton
                back
                label={t("remoteDesktop.back")}
                onPress={onBack}
              />
            )}
          </View>
          <View style={styles.heading}>
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            <Text numberOfLines={1} style={styles.caption}>
              {caption}
            </Text>
          </View>
          <RemoteDesktopPanelButton
            label={t("remoteDesktop.close")}
            onPress={onClose}
          />
        </View>
        <ScrollView
          key={page}
          testID="remoteDesktop.panelScroll"
          style={styles.panelScroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.panelContent}
        >
          {children}
        </ScrollView>
        {footer && <View style={styles.panelFooter}>{footer}</View>}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    toolbar: { flexDirection: "row", padding: spacing.xs, gap: spacing.xs },
    rail: {
      flexDirection: "column",
      flex: 1,
      width: 64,
      justifyContent: "space-around",
    },
    tool: {
      flex: 1,
      minHeight: 56,
      minWidth: 44,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.xs,
      borderRadius: radius.control,
      padding: spacing.xs,
    },
    railTool: { flex: 0, width: "100%" },
    label: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      textAlign: "center",
    },
    selected: { backgroundColor: colors.surfaceChip },
    disabled: { opacity: 0.4 },
    panel: {
      position: "absolute",
      bottom: 0,
      right: 0,
      backgroundColor: colors.sheetSurface,
      borderTopLeftRadius: radius.container,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.sheetActionBorder,
      overflow: "hidden",
    },
    bottomPanel: {
      left: 0,
      height: "50%",
      borderTopRightRadius: radius.container,
    },
    sidePanel: { width: "48%", minWidth: 280, maxWidth: 360 },
    panelHeader: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    heading: { flex: 1, gap: spacing.xs, alignItems: "center" },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.semibold,
    },
    caption: { color: colors.textTertiary, fontSize: typeScale.caption },
    close: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    panelScroll: { flex: 1, minHeight: 0 },
    panelContent: { padding: spacing.md, gap: spacing.md },
    panelFooter: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.sheetActionBorder,
    },
  });
