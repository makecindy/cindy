import { HomeHeaderGlassButton } from "./HomeHeaderGlassButton";
import { useState } from "react";
import { Share as ShareIcon, X } from "lucide-react-native";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { ShareImageNativeButton } from "@/session/ShareImageNativeButton";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from "@/theme/tokens";

/** 分享选择模式底部：关闭、标题 + 已选数量（对齐桌面 title/subtitle）、分享主按钮。 */
export function ShareSelectionBar({
  busy,
  count,
  screenshotTriggered = false,
  onCancel,
  onShare,
}: {
  busy?: boolean;
  count: number;
  screenshotTriggered?: boolean;
  onCancel(): void;
  onShare(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { width, fontScale } = useWindowDimensions();
  const [barWidth, setBarWidth] = useState<number | null>(null);
  const stacked = (barWidth ?? width) / fontScale < 360;

  const cancelIcon = (
    <X
      color={colors.textPrimary}
      size={iconSize.action}
      strokeWidth={iconStroke.regular}
    />
  );
  const cancelButton = (
    <HomeHeaderGlassButton
      accessibilityLabel={t("session.shareImage.cancel")}
      onPress={onCancel}
      testID="session.shareImage.cancel"
    >
      {cancelIcon}
    </HomeHeaderGlassButton>
  );
  const countLabel = (
    <View
      style={[styles.count, screenshotTriggered && styles.screenshotSafeCount]}
    >
      <Text ellipsizeMode="tail" numberOfLines={1} style={styles.titleText}>
        {t("session.shareImage.title")}
      </Text>
      <Text ellipsizeMode="tail" numberOfLines={1} style={styles.countText}>
        {t("session.shareImage.subtitle", { count })}
      </Text>
    </View>
  );
  const shareButton = (
    <Pressable
      accessibilityLabel={t("session.shareImage.share")}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy === true || count === 0 }}
      disabled={busy === true || count === 0}
      onPress={onShare}
      style={({ pressed }) => [
        styles.shareButton,
        (busy || count === 0) && styles.disabled,
        pressed && styles.pressed,
      ]}
      testID="session.shareImage.share"
    >
      <ShareIcon
        color={colors.ctaText}
        size={iconSize.sm}
        strokeWidth={iconStroke.regular}
      />
      <Text ellipsizeMode="tail" numberOfLines={1} style={styles.shareLabel}>
        {busy
          ? t("session.shareImage.generating")
          : t("session.shareImage.share")}
      </Text>
    </Pressable>
  );

  return (
    <View
      onLayout={({ nativeEvent }) => setBarWidth(nativeEvent.layout.width)}
      style={[styles.container, stacked && styles.stacked]}
      testID="session.shareImage.bar"
    >
      <View style={[styles.summary, stacked && styles.fullWidth]}>
        {cancelButton}
        {countLabel}
      </View>
      <View style={[styles.action, stacked && styles.stackedAction]}>
        <ShareImageNativeButton
          label={
            busy
              ? t("session.shareImage.generating")
              : t("session.shareImage.share")
          }
          disabled={busy === true || count === 0}
          onPress={onShare}
        >
          {shareButton}
        </ShareImageNativeButton>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      alignItems: "center",
      backgroundColor: colors.surfaceTranslucent,
      borderTopColor: colors.borderTranslucent,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: spacing.sm,
      minHeight: 64,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    count: { flex: 1, minWidth: 0 },
    summary: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    stacked: { flexDirection: "column", alignItems: "stretch" },
    fullWidth: { flex: 0 },
    action: { flexShrink: 0 },
    stackedAction: { alignSelf: "flex-end" },
    titleText: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    countText: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      marginTop: spacing.xs,
    },
    screenshotSafeCount: {
      paddingLeft: spacing.xl,
    },
    shareButton: {
      alignItems: "center",
      backgroundColor: colors.cta,
      borderRadius: radius.pill,
      flexDirection: "row",
      justifyContent: "center",
      gap: spacing.sm,
      minHeight: 44,
      minWidth: 112,
      paddingHorizontal: spacing.lg,
    },
    shareLabel: {
      color: colors.ctaText,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    disabled: { opacity: 0.46 },
    pressed: { opacity: 0.72 },
  });
