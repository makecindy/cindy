import { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image as ExpoImage, type ImageProps } from "expo-image";
import { ImageOff, LoaderCircle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  registerChatServerNativeImageCacheClearer,
  registerChatServerPurgedRoomStore,
} from "@/chat/chatServerMediaCache";
import { useReduceMotionEnabled } from "@/hooks/useReduceMotion";
import {
  iconSize,
  motionDuration,
  radius,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";

registerChatServerNativeImageCacheClearer(() => {
  void ExpoImage.clearMemoryCache?.()?.catch?.(() => undefined);
  void ExpoImage.clearDiskCache?.()?.catch?.(() => undefined);
});
// Room ids only (no media or account data); see chatServerMediaCache purgedRooms.
const PURGED_ROOMS_KEY = "cindy.chat-media.purged-rooms.v1";
registerChatServerPurgedRoomStore({
  load: async () => {
    const parsed: unknown = JSON.parse((await AsyncStorage.getItem(PURGED_ROOMS_KEY)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  },
  save: (roomIds) => {
    void AsyncStorage.setItem(PURGED_ROOMS_KEY, JSON.stringify(roomIds)).catch(() => undefined);
  },
});

/** Shared by remote resolution and byte decoding, so neither stage appears blank. */
export function MessageImagePlaceholder({
  style,
}: {
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const animate = useReduceMotionEnabled() === false;
  return (
    <View
      style={[styles.placeholder, style]}
      accessible
      accessibilityLabel={t("message.renderer.loading")}
      accessibilityRole="progressbar"
      testID="message.mediaThumbLoading"
    >
      {animate ? (
        <ActivityIndicator size="small" color={colors.textTertiary} />
      ) : (
        <LoaderCircle size={iconSize.md} color={colors.textTertiary} />
      )}
    </View>
  );
}

export function MessageLoadingImage(props: ImageProps) {
  return <ImageLoad key={props.recyclingKey} {...props} />;
}

function ImageLoad({ style, onDisplay, onError, ...props }: ImageProps) {
  const [status, setStatus] = useState<"loading" | "displayed" | "error">(
    "loading",
  );
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const animate = useReduceMotionEnabled() === false;
  return (
    <View style={[styles.frame, style]}>
      {status === "loading" && (
        <MessageImagePlaceholder style={StyleSheet.absoluteFill} />
      )}
      {status === "error" ? (
        <View
          style={[styles.placeholder, StyleSheet.absoluteFill]}
          accessible
          accessibilityLabel={t("message.lightbox.loadFailed")}
        >
          <ImageOff size={iconSize.xxl} color={colors.textTertiary} />
        </View>
      ) : (
        <ExpoImage
          {...props}
          style={StyleSheet.absoluteFill}
          transition={animate ? motionDuration.fast : 0}
          onDisplay={() => {
            setStatus("displayed");
            onDisplay?.();
          }}
          onError={(event) => {
            setStatus("error");
            onError?.(event);
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    frame: {
      borderRadius: radius.container,
      overflow: "hidden",
    },
    placeholder: {
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.container,
      alignItems: "center",
      justifyContent: "center",
    },
  });
