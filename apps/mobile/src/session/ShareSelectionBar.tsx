import { Check, Share as ShareIcon, X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { shareSelectionStore } from "@/session/shareSelectionStore";
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

export function ShareSelectionBar({
  busy,
  count,
  shareableIds,
  screenshotTriggered = false,
  onCancel,
  onShare,
}: {
  busy?: boolean;
  count: number;
  shareableIds: readonly string[];
  screenshotTriggered?: boolean;
  onCancel(): void;
  onShare(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const selectedVisibleCount =
    shareSelectionStore.getSelectedIdsInOrder(shareableIds).length;
  const allSelected =
    shareableIds.length > 0 &&
    selectedVisibleCount === shareableIds.length &&
    selectedVisibleCount === count;
  const selectionBeforeSelectAllRef = useRef<string[] | null>(null);

  const toggleAll = () => {
    const selectedCount =
      shareSelectionStore.getSelectedIdsInOrder(shareableIds).length;
    const currentlyAllSelected =
      shareableIds.length > 0 &&
      selectedCount === shareableIds.length &&
      selectedCount === shareSelectionStore.count();
    if (currentlyAllSelected) {
      shareSelectionStore.setSelection(
        selectionBeforeSelectAllRef.current ?? [],
      );
      selectionBeforeSelectAllRef.current = null;
      return;
    }
    selectionBeforeSelectAllRef.current = shareSelectionStore.getSelectedIds();
    shareSelectionStore.setSelection(shareableIds);
  };

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
  const selectAllButton = (
    <Pressable
      accessibilityLabel={
        allSelected
          ? t("session.shareImage.clearAll")
          : t("session.shareImage.selectAll")
      }
      accessibilityRole="checkbox"
      accessibilityState={{
        checked: allSelected,
        disabled: busy === true || shareableIds.length === 0,
      }}
      disabled={busy === true || shareableIds.length === 0}
      onPress={toggleAll}
      style={({ pressed }) => [
        styles.selectAllButton,
        (busy || shareableIds.length === 0) && styles.disabled,
        pressed && styles.pressed,
      ]}
      testID="session.shareImage.selectAll"
    >
      <View
        style={[
          styles.selectAllMark,
          allSelected && styles.selectAllMarkSelected,
        ]}
      >
        {allSelected ? (
          <Check
            color={colors.ctaText}
            size={iconSize.xs}
            strokeWidth={iconStroke.bold}
          />
        ) : null}
      </View>
      <Text style={styles.selectAllLabel}>
        {t(
          allSelected
            ? "session.shareImage.clearAll"
            : "session.shareImage.selectAll",
        )}
      </Text>
    </Pressable>
  );
  const copy = (
    <View
      style={[styles.copy, screenshotTriggered && styles.screenshotSafeCopy]}
    >
      <Text style={styles.title}>
        {t("session.shareImage.title")}
      </Text>
      <Text style={styles.subtitle}>
        {t("session.shareImage.selectedCount", { count })}
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
      <Text style={styles.shareLabel}>
        {busy
          ? t("session.shareImage.generating")
          : t("session.shareImage.share")}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.container} testID="session.shareImage.bar">
      {cancelButton}
      {selectAllButton}
      {copy}
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
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    selectAllButton: {
      alignItems: "center",
      backgroundColor: colors.surfaceChip,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: spacing.xs,
      height: 36,
      paddingHorizontal: spacing.sm,
    },
    selectAllLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.medium,
    },
    selectAllMark: {
      alignItems: "center",
      borderColor: colors.textTertiary,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      height: 16,
      justifyContent: "center",
      width: 16,
    },
    selectAllMarkSelected: {
      backgroundColor: colors.cta,
      borderColor: colors.cta,
    },
    copy: { flex: 1, gap: 2, minWidth: 0 },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    screenshotSafeCopy: {
      paddingLeft: spacing.xl,
    },
    subtitle: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    shareButton: {
      alignItems: "center",
      backgroundColor: colors.cta,
      borderRadius: radius.pill,
      flexDirection: "row",
      gap: spacing.xs,
      minHeight: 40,
      paddingHorizontal: spacing.md,
    },
    shareLabel: {
      color: colors.ctaText,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.medium,
    },
    disabled: { opacity: 0.46 },
    pressed: { opacity: 0.72 },
  });
