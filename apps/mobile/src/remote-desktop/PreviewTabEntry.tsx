/**
 * A strip on the task page that offers the plugin preview tabs open on the
 * computer for this task. It owns everything about the offer (polling, copy,
 * navigation), so a different spot for it only changes where it is mounted.
 */
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useIsFocused } from "expo-router";
import { ChevronRight, MonitorSmartphone } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { useGuardedPush } from "@/utils/useGuardedPush";
import type { PreviewTabListing } from "./previewTabsQuery";
import { usePreviewTabs } from "./usePreviewTabs";

export function PreviewTabEntry({
  deviceId,
  deviceName,
  sessionId,
}: {
  deviceId: string;
  deviceName: string;
  sessionId: string;
}) {
  const focused = useIsFocused();
  const tabs = usePreviewTabs({ deviceId, sessionId, active: focused });
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const push = useGuardedPush();
  if (tabs.length === 0) return null;
  // The route names the task and the tab; the one-time grant is fetched by the view.
  const open = (tab: PreviewTabListing) =>
    push({
      pathname: "/devices/desktop/[deviceId]",
      params: {
        deviceId,
        deviceName,
        previewSession: tab.sessionId,
        previewPlugin: tab.pluginName,
        previewTitle: tab.title,
        ...(tab.ref ? { previewRef: tab.ref } : {}),
      },
    });
  const press = () => {
    if (tabs.length === 1) {
      open(tabs[0]);
      return;
    }
    Alert.alert(t("remoteDesktop.previewEntryChoose"), undefined, [
      ...tabs.map((tab) => ({
        text: tab.title ? `${tab.pluginName} · ${tab.title}` : tab.pluginName,
        onPress: () => open(tab),
      })),
      { text: t("remoteDesktop.close"), style: "cancel" as const },
    ]);
  };
  const label =
    tabs.length === 1
      ? t("remoteDesktop.previewEntry")
      : t("remoteDesktop.previewEntryMany", { count: tabs.length });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={press}
      style={({ pressed }) => [styles.strip, pressed && styles.pressed]}
      testID="session.previewEntry"
    >
      <View style={styles.icon}>
        <MonitorSmartphone
          color={colors.textPrimary}
          size={iconSize.lg}
          strokeWidth={iconStroke.regular}
        />
      </View>
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        {tabs.length === 1 ? (
          <Text numberOfLines={1} style={styles.detail}>
            {tabs[0].title
              ? `${tabs[0].pluginName} · ${tabs[0].title}`
              : tabs[0].pluginName}
          </Text>
        ) : null}
      </View>
      <ChevronRight
        color={colors.textTertiary}
        size={iconSize.lg}
        strokeWidth={iconStroke.regular}
      />
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    strip: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
      // Same gap under the strip as the queue-edit bar above the composer.
      marginBottom: spacing.xs,
    },
    pressed: { backgroundColor: colors.surfaceChip },
    icon: {
      width: 36,
      height: 36,
      borderRadius: radius.control,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceChip,
    },
    text: { flex: 1, minWidth: 0, gap: 2 },
    label: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    detail: {
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
  });
