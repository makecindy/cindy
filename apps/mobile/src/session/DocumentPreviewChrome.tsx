import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { lineHeight, spacing, typeScale, useTheme } from "@/theme";
import { PreviewHeader } from "./PreviewChrome";
import type { DocumentPreviewChromeProps } from "./HtmlBrowserChrome.types";

export function DocumentPreviewChrome(p: DocumentPreviewChromeProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <PreviewHeader
        name={p.title}
        detail={p.meta}
        onClose={p.onClose}
        actions={[
          ...(p.onToggleSource
            ? [
                {
                  key: "source",
                  label: t(
                    p.source
                      ? "files.preview.browserShowDocument"
                      : "files.preview.browserShowSource",
                  ),
                  onPress: p.onToggleSource,
                },
              ]
            : []),
          {
            key: "share",
            label: t("files.preview.exportShare"),
            onPress: p.onShare,
            disabled: p.busy || p.pending,
          },
          {
            key: "path",
            label: t("files.preview.copyPath"),
            onPress: p.onCopyPath,
            disabled: p.pending,
          },
          {
            key: "draft",
            label: t("files.preview.browserAddToTask"),
            onPress: p.onAddToTask,
            disabled: p.pending,
          },
        ]}
      />
      {p.notice ? (
        <View
          style={{
            position: "absolute",
            top: insets.top + 64,
            left: 0,
            right: 0,
            backgroundColor: colors.surface,
            padding: spacing.sm,
            flexDirection: "row",
            gap: spacing.sm,
            alignItems: "center",
          }}
        >
          {p.busy ? <ActivityIndicator color={colors.textSecondary} /> : null}
          <Text
            style={{
              flex: 1,
              color: colors.textSecondary,
              fontSize: typeScale.footnote,
              lineHeight: lineHeight.caption,
            }}
          >
            {p.notice}
          </Text>
          {p.onCancelNotice ? (
            <Pressable onPress={p.onCancelNotice}>
              <Text
                style={{
                  color: colors.textPrimary,
                  fontSize: typeScale.footnote,
                  lineHeight: lineHeight.caption,
                }}
              >
                {t("message.lightbox.cancel")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
