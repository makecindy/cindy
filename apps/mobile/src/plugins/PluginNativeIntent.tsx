import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  PluginNativeIntent as Intent,
  PluginPageFetchResult,
} from "@cindy/device-link";
import { useGuardedPush } from "@/utils/useGuardedPush";
import { SheetModal } from "@/session/SheetModal";
import { Text } from "@/components/AppText";
import { HtmlWebsiteBrowser } from "@/session/HtmlWebsiteBrowser";
import { HtmlSnapshotReader } from "@/session/HtmlFileReader";
import type { MobileHtmlPreview } from "@/session/mobileHtmlPreview";
import { PluginScheduleDraft } from "./PluginScheduleDraft";
import { PluginMediaViewer } from "./PluginMediaViewer";
import {
  fontWeight,
  lineHeight,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

export function PluginNativeIntent({
  intent,
  deviceId,
  onClose,
  readPreview,
  readMedia,
}: {
  intent: Intent;
  deviceId: string;
  onClose(): void;
  readPreview(
    url: string,
    offset: number,
    revision?: string,
  ): Promise<PluginPageFetchResult>;
  readMedia(path: string, offset: number): Promise<PluginPageFetchResult>;
}) {
  const { t } = useTranslation(),
    { colors } = useTheme(),
    styles = useThemedStyles(makeStyles),
    insets = useSafeAreaInsets();
  const push = useGuardedPush();
  const [preview, setPreview] = useState<MobileHtmlPreview>(),
    [failed, setFailed] = useState(false);
  const closed = useRef(Promise.resolve()).current;
  const local =
    intent.kind === "preview" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(intent.url).hostname);
  useEffect(() => {
    if (intent.kind !== "preview" || !local) return;
    const controller = new AbortController();
    let prepared: MobileHtmlPreview | undefined;
    void import("./pluginLocalPreview")
      .then((module) =>
        module.preparePluginLocalPreview(
          intent.url,
          readPreview,
          controller.signal,
        ),
      )
      .then((value) => {
        prepared = value;
        if (controller.signal.aborted) void value.close();
        else setPreview(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      void prepared?.close().catch(() => {});
    };
  }, [intent.id]);
  if (intent.kind === "schedule")
    return (
      <PluginScheduleDraft
        intent={intent}
        deviceId={deviceId}
        onClose={onClose}
      />
    );
  if (intent.kind === "media")
    return (
      <PluginMediaViewer intent={intent} read={readMedia} onClose={onClose} />
    );
  if (intent.kind === "simulator")
    return (
      <SheetModal visible onRequestClose={onClose} onBackdropPress={() => {}}>
        <View style={styles.fallback}>
          <Text style={styles.body}>{intent.ghostName}</Text>
          <Text style={styles.hint}>{t("plugins.simulatorOnComputer")}</Text>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => {
              onClose();
              push({
                pathname: "/devices/desktop/[deviceId]",
                params: { deviceId },
              });
            }}
          >
            <Text style={styles.body}>
              {t("interaction.pluginSetup.remoteDesktop")}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={onClose}
          >
            <Text style={styles.body}>{t("plugins.returnToPlugin")}</Text>
          </Pressable>
        </View>
      </SheetModal>
    );
  if (intent.kind !== "preview") return null;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View
        style={[
          styles.root,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.body}>{intent.ghostName}</Text>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={onClose}
          >
            <Text style={styles.body}>{t("plugins.returnToPlugin")}</Text>
          </Pressable>
        </View>
        {local ? (
          <>
            <Text style={styles.hint}>{t("plugins.computerPreview")}</Text>
            {preview ? (
              <HtmlSnapshotReader
                preview={preview}
                onError={() => setFailed(true)}
              />
            ) : !failed ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : null}
            {failed ? (
              <Text style={styles.hint}>{t("plugins.previewFailed")}</Text>
            ) : null}
          </>
        ) : (
          <HtmlWebsiteBrowser
            visit={{ url: intent.url, snapshotClosed: closed }}
            insets={{ top: 0, bottom: 44, left: 0, right: 0 }}
            chrome={{ top: 0, bottom: 0, left: 0, right: 0, onClose }}
            onReturn={onClose}
          />
        )}
      </View>
    </Modal>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fallback: { padding: spacing.lg, backgroundColor: colors.surfaceElevated },
    root: { flex: 1, backgroundColor: colors.surface },
    header: {
      minHeight: 44,
      paddingHorizontal: spacing.md,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: spacing.sm,
    },
    button: { minHeight: 44, paddingVertical: spacing.sm },
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
      padding: spacing.md,
    },
  });
