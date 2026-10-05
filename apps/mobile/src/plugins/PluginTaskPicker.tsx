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
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
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

/** Host task chooser. Its list is never exposed to plugin JavaScript or cindy.tasks. */
export function PluginTaskPicker({
  deviceId,
  visible,
  onClose,
  onSelect,
}: {
  deviceId: string;
  visible: boolean;
  onClose(): void;
  onSelect(sessionId: string): void;
}) {
  const { invoke } = useDeviceLink(),
    { t } = useTranslation();
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
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<RemoteSession[]>([]);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const owner = getMobileAuthOwner();
    let disposed = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    setRows([]);
    setQuery("");
    setLoading(true);
    setError(false);
    setSnap("half");
    void invoke<RemoteSession[]>(
      deviceId,
      "local-db:sessions:list",
      [500, "active", { includePinned: true, fresh: true }],
      {
        preSend: () => {
          if (!current()) throw new Error("PLUGIN_TASK_PICKER_CLOSED");
        },
      },
    )
      .then((value) => {
        if (current())
          setRows(
            Array.isArray(value)
              ? value.filter(
                  (row) =>
                    row &&
                    typeof row.id === "string" &&
                    typeof row.title === "string" &&
                    row.status === "active" &&
                    row.orcaRole !== "worker",
                )
              : [],
          );
      })
      .catch(() => {
        if (current()) setError(true);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [deviceId, visible, invoke, attempt]);
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
            <Pressable
              style={styles.row}
              onPress={() => setAttempt((value) => value + 1)}
            >
              <Text style={styles.title}>{t("plugins.retry")}</Text>
            </Pressable>
          </View>
        ) : (
          rows
            .filter((row) =>
              row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )
            .map((row) => (
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
        {!loading && !error && !rows.length ? (
          <Text style={styles.note}>{t("plugins.noTasks")}</Text>
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
