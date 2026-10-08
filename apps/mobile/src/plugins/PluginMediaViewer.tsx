import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Sharing from "expo-sharing";
import type {
  PluginNativeIntent,
  PluginPageFetchResult,
} from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { ImageLightbox } from "@/session/ImageLightbox";
import { buildMediaPayload } from "@/session/messagePayload";
import { lightboxImagesForPayload } from "@/session/messageGallery";
import { RemoteMediaPlayerWebView } from "@/session/mediaPlayerWebView";
import {
  fontWeight,
  lineHeight,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { readPluginMediaFile } from "./pluginMediaFile";

export function PluginMediaViewer({
  intent,
  read,
  onClose,
}: {
  intent: Extract<PluginNativeIntent, { kind: "media" }>;
  read(path: string, offset: number): Promise<PluginPageFetchResult>;
  onClose(): void;
}) {
  const { t } = useTranslation(),
    { colors } = useTheme(),
    styles = useThemedStyles(makeStyles),
    insets = useSafeAreaInsets();
  const [media, setMedia] =
      useState<Awaited<ReturnType<typeof readPluginMediaFile>>>(),
    [failed, setFailed] = useState(false);
  const sharing = useRef<Promise<void> | undefined>(undefined),
    alive = useRef(true);
  useEffect(() => {
    const abort = new AbortController();
    let owned: typeof media;
    void readPluginMediaFile(intent.path, intent.mediaKind, read, abort.signal)
      .then((value) => {
        owned = value;
        if (abort.signal.aborted) value.close();
        else setMedia(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => {
      alive.current = false;
      abort.abort();
      void Promise.resolve(sharing.current)
        .finally(() => owned?.close())
        .catch(() => {});
    };
  }, [intent.id]);
  const images = useMemo(
    () =>
      media
        ? lightboxImagesForPayload(
            [],
            buildMediaPayload(
              { kind: "image", url: media.uri, previewable: true },
              intent.ghostName,
            ),
          )
        : [],
    [media, intent.ghostName],
  );
  const share = async () => {
    if (!media || !alive.current || sharing.current) return;
    const work = Sharing.shareAsync(media.uri, { mimeType: media.mime });
    sharing.current = work;
    try {
      await work;
    } catch {
      if (alive.current) Alert.alert(t("plugins.actionFailed"));
    } finally {
      if (sharing.current === work) sharing.current = undefined;
    }
  };
  if (media && intent.mediaKind === "image")
    return (
      <ImageLightbox
        images={images}
        initialUrl={media.uri}
        onClose={onClose}
        onShareImage={share}
        showFileHeader
      />
    );
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
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={onClose}
          >
            <Text style={styles.body}>{t("plugins.returnToPlugin")}</Text>
          </Pressable>
          {media ? (
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => void share()}
              onLongPress={() => void share()}
            >
              <Text style={styles.body}>{t("plugins.shareMedia")}</Text>
            </Pressable>
          ) : null}
        </View>
        {media ? (
          <RemoteMediaPlayerWebView
            kind="video"
            url={media.uri}
            mimeType={media.mime}
            title={intent.ghostName}
            style={styles.root}
          />
        ) : failed ? (
          <Text style={styles.body}>{t("plugins.previewFailed")}</Text>
        ) : (
          <ActivityIndicator color={colors.textSecondary} />
        )}
      </View>
    </Modal>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.surface },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: spacing.md,
    },
    button: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: spacing.sm,
    },
    body: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
    },
  });
