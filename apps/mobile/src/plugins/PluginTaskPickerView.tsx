import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import { SheetModal } from "@/session/SheetModal";
import { SheetSurface } from "@/session/SheetSurface";
import {
  computeContextSheetSnapHeights,
  type ContextSheetSnap,
} from "@/session/contextSheetModel";
import type { RemoteSession } from "@/session/types";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

export interface PluginTaskPickerViewProps {
  deviceId: string;
  visible: boolean;
  query: string;
  rows: RemoteSession[];
  loading: boolean;
  error: boolean;
  onChangeQuery(query: string): void;
  onRetry(): void;
  onClose(): void;
  onSelect(sessionId: string): void;
}

export function PluginTaskPickerView({
  visible,
  query,
  rows,
  loading,
  error,
  onChangeQuery: setQuery,
  onRetry,
  onClose,
  onSelect,
}: PluginTaskPickerViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme(),
    styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets(),
    { height } = useWindowDimensions();
  const heights = useMemo(
    () =>
      computeContextSheetSnapHeights({
        safeAreaTopInset: insets.top,
        screenHeight: height,
      }),
    [height, insets.top],
  );
  const [snap, setSnap] = useState<ContextSheetSnap>("half");
  useEffect(() => {
    if (visible) setSnap("half");
  }, [visible]);
  const matches = rows.filter((row) =>
    row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={onClose}
      onBackdropPress={onClose}
      keyboardAvoiding
    >
      <SheetSurface
        title={t("plugins.chooseTask")}
        onClose={onClose}
        heights={heights}
        snap={snap}
        onSnapChange={setSnap}
        bottomInset={insets.bottom}
        pinnedTop={
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("plugins.searchTasks")}
            accessibilityLabel={t("plugins.searchTasks")}
            placeholderTextColor={colors.textPlaceholder}
            style={styles.search}
          />
        }
      >
        {loading ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : error ? (
          <View style={styles.empty}>
            <Text style={styles.note}>{t("plugins.loadFailed")}</Text>
            <Pressable style={styles.row} onPress={() => onRetry()}>
              <Text style={styles.title}>{t("plugins.retry")}</Text>
            </Pressable>
          </View>
        ) : (
          matches.map((row) => (
            <Pressable
              key={row.id}
              style={styles.row}
              onPress={() => onSelect(row.id)}
            >
              <Text numberOfLines={1} style={styles.title}>
                {row.title}
              </Text>
              {row.preview ? (
                <Text numberOfLines={2} style={styles.note}>
                  {row.preview}
                </Text>
              ) : null}
            </Pressable>
          ))
        )}
        {!loading && !error && !matches.length ? (
          <Text style={styles.note}>
            {t(rows.length ? "plugins.noMatchingTasks" : "plugins.noTasks")}
          </Text>
        ) : null}
      </SheetSurface>
    </SheetModal>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { minHeight: 56, padding: spacing.md, gap: spacing.xs },
    empty: { padding: spacing.md, gap: spacing.sm },
    search: {
      margin: spacing.md,
      padding: spacing.md,
      borderRadius: radius.control,
      backgroundColor: c.surfaceChip,
      color: c.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
    },
    title: {
      color: c.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    note: {
      color: c.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
  });
