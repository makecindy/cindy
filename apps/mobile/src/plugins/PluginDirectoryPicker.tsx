import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Folder, ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { PluginDirectoryRequest } from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import type { RemoteDirectoryListResult } from "@/device-link/mobileMakerTransport";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { SheetModal } from "@/session/SheetModal";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

/** Paths are displayed only in trusted native UI and submitted only after an explicit selection. */
export function PluginDirectoryPicker({
  request,
  deviceId,
  onAnswer,
}: {
  request: PluginDirectoryRequest;
  deviceId: string;
  onAnswer(path: string | null): Promise<void>;
}) {
  const { t } = useTranslation(),
    { colors } = useTheme(),
    styles = useThemedStyles(makeStyles);
  const link = useDeviceLink(),
    owner = useRef(getMobileAuthOwner()).current;
  const liveEpoch = useRef(link.connectionEpoch);
  liveEpoch.current = link.connectionEpoch;
  const live = useRef(true),
    generation = useRef(0),
    lock = useRef(false);
  const [directory, setDirectory] = useState<RemoteDirectoryListResult>();
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  useEffect(
    () => () => {
      live.current = false;
      generation.current++;
    },
    [],
  );
  const browse = async (path: string) => {
    if (lock.current) return;
    const current = ++generation.current,
      epoch = link.connectionEpoch;
    const assertCurrent = () => {
      if (
        !live.current ||
        current !== generation.current ||
        !isMobileAuthOwnerCurrent(owner) ||
        liveEpoch.current !== epoch ||
        Date.now() >= request.expiresAt
      )
        throw new Error("PLUGIN_DIRECTORY_CLOSED");
    };
    setLoading(true);
    setFailed(false);
    try {
      const result = await link.invoke<RemoteDirectoryListResult>(
        deviceId,
        "fs:list-dir",
        [{ path }],
        { preSend: assertCurrent },
      );
      assertCurrent();
      if (
        !result ||
        typeof result.resolvedPath !== "string" ||
        !Array.isArray(result.entries)
      )
        throw new Error("INVALID_DIRECTORY");
      setDirectory(result);
    } catch {
      if (live.current && current === generation.current) {
        setFailed(true);
        setDirectory(undefined);
      }
    } finally {
      if (live.current && current === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    void browse("~");
  }, []);
  const answer = async (path: string | null) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await onAnswer(path);
    } catch {
      if (live.current) setFailed(true);
    } finally {
      if (live.current) setBusy(false);
      lock.current = false;
    }
  };
  return (
    <SheetModal
      visible
      onRequestClose={() => void answer(null)}
      onBackdropPress={() => {}}
    >
      <View style={styles.sheet}>
        <Text style={styles.title}>{request.ghostName}</Text>
        <Text style={styles.body}>{t("plugins.chooseComputerFolder")}</Text>
        {request.purpose ? (
          <Text style={styles.hint}>{request.purpose}</Text>
        ) : null}
        {directory ? (
          <Text style={styles.hint} selectable>
            {directory.resolvedPath}
          </Text>
        ) : null}
        {loading ? <ActivityIndicator color={colors.textSecondary} /> : null}
        {failed ? (
          <Text style={styles.hint}>{t("plugins.folderReadFailed")}</Text>
        ) : null}
        <ScrollView style={styles.list}>
          {directory?.parent ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy || loading}
              style={styles.row}
              onPress={() => void browse(directory.parent!)}
            >
              <ChevronLeft
                color={colors.textPrimary}
                size={iconSize.action}
                strokeWidth={iconStroke.regular}
              />
              <Text style={styles.body}>{t("plugins.parentFolder")}</Text>
            </Pressable>
          ) : null}
          {directory?.drives
            ?.filter((drive) => !drive.current)
            .map((drive) => (
              <Pressable
                key={drive.path}
                accessibilityRole="button"
                disabled={busy || loading}
                style={styles.row}
                onPress={() => void browse(drive.path)}
              >
                <Folder
                  color={colors.textSecondary}
                  size={iconSize.action}
                  strokeWidth={iconStroke.regular}
                />
                <Text style={styles.body}>{drive.name}</Text>
              </Pressable>
            ))}
          {directory?.entries
            .filter((entry) => entry.kind === "dir" || entry.kind === "symlink")
            .map((entry) => (
              <Pressable
                key={entry.path}
                accessibilityRole="button"
                disabled={busy || loading}
                style={styles.row}
                onPress={() => void browse(entry.path)}
              >
                <Folder
                  color={colors.textSecondary}
                  size={iconSize.action}
                  strokeWidth={iconStroke.regular}
                />
                <Text style={styles.body}>{entry.name}</Text>
              </Pressable>
            ))}
        </ScrollView>
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            style={styles.row}
            onPress={() => void answer(null)}
          >
            <Text style={styles.body}>{t("plugins.cancel")}</Text>
          </Pressable>
          {failed ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy || loading}
              style={styles.row}
              onPress={() => void browse("~")}
            >
              <Text style={styles.body}>{t("plugins.retry")}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy || loading || !directory || failed}
            style={styles.row}
            onPress={() => directory && void answer(directory.resolvedPath)}
          >
            <Text style={styles.body}>{t("plugins.selectFolder")}</Text>
          </Pressable>
        </View>
      </View>
    </SheetModal>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    sheet: {
      backgroundColor: colors.surfaceElevated,
      padding: spacing.lg,
      gap: spacing.md,
      maxHeight: "85%",
    },
    list: { flexShrink: 1 },
    buttons: { flexDirection: "row", gap: spacing.md, flexWrap: "wrap" },
    row: {
      minHeight: 44,
      paddingVertical: spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    title: {
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
      color: colors.textPrimary,
    },
    body: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
    },
    hint: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
    },
  });
