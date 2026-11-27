import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { GhostReadmeContent } from "@cindy/plugin-protocol";
import { Text } from "@/components/AppText";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { MarkdownFileReader } from "@/session/MarkdownFileReader";
import { radius, spacing, textStyles, useTheme } from "@/theme";
import { loadPluginReadme, pluginReadmeImageSources } from "./pluginReadme";

type ReadmeState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; content: GhostReadmeContent | null };

/** Full-page reader for a plugin's detailed introduction; read-only, fetched when opened. */
export function PluginReadmePage({
  deviceId,
  pluginId,
}: {
  deviceId: string;
  pluginId: string;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const { invoke } = useDeviceLink();
  const [state, setState] = useState<ReadmeState>({ status: "loading" });
  const alive = useRef(true);
  const load = useCallback(async () => {
    const owner = getMobileAuthOwner();
    const current = () => alive.current && isMobileAuthOwnerCurrent(owner);
    setState({ status: "loading" });
    try {
      const content = await loadPluginReadme(invoke, deviceId, pluginId, i18n.language);
      if (current()) setState({ status: "ready", content });
    } catch {
      if (current()) setState({ status: "failed" });
    }
  }, [invoke, deviceId, pluginId, i18n.language]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  const content = state.status === "ready" ? state.content : null;
  const imageSources = useMemo(
    () => (content ? pluginReadmeImageSources(content) : null),
    [content],
  );

  if (state.status === "ready" && content && imageSources)
    return (
      <MarkdownFileReader
        markdown={content.markdown}
        imageSources={imageSources}
        testID="plugins.readme.content"
      />
    );
  return (
    <View style={styles.state} testID={"plugins.readme." + state.status}>
      {state.status === "loading" ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : (
        <Text style={[textStyles.footnote, styles.copy, { color: colors.textSecondary }]}>
          {t(
            state.status === "failed"
              ? "plugins.detail.readmeLoadFailed"
              : "plugins.detail.readmeUnavailable",
          )}
        </Text>
      )}
      {state.status === "failed" ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void load()}
          style={[
            styles.action,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
          testID="plugins.readme.retry"
        >
          <Text style={[textStyles.body, { color: colors.textPrimary }]}>
            {t("plugins.detail.action.retry")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xl,
  },
  copy: { textAlign: "center" },
  action: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
