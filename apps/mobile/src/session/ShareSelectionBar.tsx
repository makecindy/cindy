import { Share as ShareIcon, X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
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

  const cancelButton = (
    <Pressable
      accessibilityLabel={t("session.shareImage.cancel")}
      accessibilityRole="button"
      hitSlop={spacing.sm}
      onPress={onCancel}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
      testID="session.shareImage.cancel"
    >
      <X
        color={colors.textSecondary}
        size={iconSize.md}
        strokeWidth={iconStroke.regular}
      />
    </Pressable>
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
    <View style={styles.container} testID="session.shareImage.bar">
      {cancelButton}
      {countLabel}
      {shareButton}
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
    iconButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    count: { flex: 1, minWidth: 0 },
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
      gap: spacing.sm,
      minHeight: 44,
      minWidth: 112,
      paddingHorizontal: spacing.lg,
    },
    shareLabel: {
      color: colors.ctaText,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    disabled: { opacity: 0.46 },
    pressed: { opacity: 0.72 },
  });
