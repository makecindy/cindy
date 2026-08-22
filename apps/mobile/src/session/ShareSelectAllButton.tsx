import { Pressable, StyleSheet, View } from "react-native";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { ShareCheckboxMark } from "@/session/ShareMessageCheckbox";
import { shareSelectionStore, useShareSelectionRevision } from "@/session/shareSelectionStore";
import { useThemedStyles, type ThemeColors } from "@/theme";
import { fontWeight, spacing, typeScale } from "@/theme/tokens";

export function ShareSelectAllButton({
  busy = false,
  shareableIds,
}: {
  busy?: boolean;
  shareableIds: readonly string[];
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  useShareSelectionRevision();
  const selectedVisibleCount =
    shareSelectionStore.getSelectedIdsInOrder(shareableIds).length;
  const allSelected =
    shareableIds.length > 0 &&
    selectedVisibleCount === shareableIds.length &&
    selectedVisibleCount === shareSelectionStore.count();
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
        shareableIds.filter((clientId) =>
          selectionBeforeSelectAllRef.current?.includes(clientId),
        ),
      );
      selectionBeforeSelectAllRef.current = null;
      return;
    }
    selectionBeforeSelectAllRef.current = shareSelectionStore.getSelectedIds();
    shareSelectionStore.setSelection(shareableIds);
  };

  const label = t(
    allSelected ? "session.shareImage.clearAll" : "session.shareImage.selectAll",
  );

  return (
    <Pressable
      accessibilityLabel={label}
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
      <View style={styles.selectAllMarkGutter}>
        <ShareCheckboxMark checked={allSelected} />
      </View>
      <Text ellipsizeMode="tail" numberOfLines={1} style={styles.selectAllLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    selectAllButton: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.sm,
      height: 44,
      paddingLeft: spacing.sm,
    },
    selectAllLabel: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    selectAllMarkGutter: {
      alignItems: "center",
      width: spacing.xl * 2,
    },
    disabled: { opacity: 0.46 },
    pressed: { opacity: 0.72 },
  });
