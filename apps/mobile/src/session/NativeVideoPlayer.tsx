/**
 * 文件预览里的视频播放:系统原生播放器(iOS AVPlayerViewController / Android ExoPlayer)。
 * 控件、全屏、旋转都交给系统,随系统版本自动是当代样式;本组件只补两件事:
 * 缓冲时显示已加载百分比,所在页失活(翻页 / 压栈)时暂停,回到本页不代用户续播。
 */
import { useEvent } from "expo";
import { GlassView } from "expo-glass-effect";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Text } from "@/components/AppText";
import { mobileDebugLog } from "@/debug/mobileDebugLog";
import { sanitizeDiagnosticText } from "@/debug/fileDiagnostics";
import { createMediaPlayerWebViewLifecycle } from "@/session/mediaPlayerWebViewLifecycle";
import { transferPercent } from "@/session/transferProgress";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import { lineHeight, radius, spacing, typeScale } from "@/theme/tokens";

/** 每次起播 AVPlayer 都会短暂进入 loading 评估缓冲,短于此时长不打扰。 */
const BUFFERING_HINT_DELAY_MS = 400;
const BUFFER_SAMPLE_MS = 500;
const HINT_SPINNER = "#FFFFFF";

export function NativeVideoPlayer({
  onError,
  style,
  testID,
  url,
  visible,
}: {
  onError(detail: string): void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  url: string;
  /** 所在页是否为当前可见页:可见 → 失活沿暂停一次。 */
  visible: boolean;
}) {
  const { t } = useTranslation();
  const liquidGlass = useLiquidGlassAvailable();
  const player = useVideoPlayer(url);
  const { status, error } = useEvent(player, "statusChange", {
    status: player.status,
  });
  const [buffering, setBuffering] = useState(false);
  const [bufferedPercent, setBufferedPercent] = useState<number | null>(null);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    mobileDebugLog(
      status === "error" ? "warn" : "debug",
      "files",
      "native video state",
      {
        state: status,
        mediaError: error?.message
          ? sanitizeDiagnosticText(error.message)
          : null,
      },
    );
    if (status === "error") onErrorRef.current(error?.message ?? "media error");
  }, [error, status]);

  useEffect(() => {
    if (status !== "loading") {
      setBuffering(false);
      return undefined;
    }
    const timer = setTimeout(() => setBuffering(true), BUFFERING_HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // 缓冲期间 AVPlayer 不发 timeUpdate(暂停时也不发),主动采样已加载到的位置。
  useEffect(() => {
    if (!buffering) return undefined;
    const sample = () => {
      const duration = player.duration;
      const loaded = player.bufferedPosition;
      setBufferedPercent(
        duration > 0 && loaded >= 0
          ? transferPercent({ loaded, total: duration })
          : null,
      );
    };
    sample();
    const timer = setInterval(sample, BUFFER_SAMPLE_MS);
    return () => clearInterval(timer);
  }, [buffering, player]);

  // 与 WebView 播放器共用同一判据:只在「可见 → 失活」沿暂停一次。
  const lifecycleRef = useRef(createMediaPlayerWebViewLifecycle());
  useEffect(() => {
    if (lifecycleRef.current.onVisibilityChange(visible)) player.pause();
  }, [player, visible]);

  const label =
    bufferedPercent === null
      ? t("files.preview.videoBuffering")
      : t("files.preview.videoBufferingPercent", { percent: bufferedPercent });

  return (
    <View style={[styles.stage, style]} testID={testID}>
      <VideoView
        allowsPictureInPicture={false}
        contentFit="contain"
        fullscreenOptions={{ enable: true, orientation: "default" }}
        nativeControls
        player={player}
        style={StyleSheet.absoluteFill}
      />
      {buffering ? (
        <View
          pointerEvents="none"
          style={styles.hintAnchor}
          testID="filePreview.videoBuffering"
        >
          {liquidGlass ? (
            <GlassView
              colorScheme="dark"
              glassEffectStyle="regular"
              style={styles.hintPill}
            >
              <ActivityIndicator color={HINT_SPINNER} size="small" />
              <Text style={styles.hintText}>{label}</Text>
            </GlassView>
          ) : (
            <View style={[styles.hintPill, styles.hintPillFallback]}>
              <ActivityIndicator color={HINT_SPINNER} size="small" />
              <Text style={styles.hintText}>{label}</Text>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

// 视频画布双模式恒深(与图片 lightbox 同一做法):系统播放控件按深底设计,
// 叠在上面的提示也按恒深配色,不随主题反相。
const styles = StyleSheet.create({
  stage: { backgroundColor: "#000000", flex: 1, overflow: "hidden" },
  hintAnchor: {
    alignItems: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: spacing.lg,
  },
  hintPill: {
    alignItems: "center",
    borderRadius: radius.pill,
    flexDirection: "row",
    gap: spacing.sm,
    overflow: "hidden",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  hintPillFallback: {
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderColor: "rgba(255, 255, 255, 0.22)",
    borderWidth: StyleSheet.hairlineWidth,
  },
  hintText: {
    color: "rgba(255, 255, 255, 0.85)",
    fontSize: typeScale.footnote,
    fontVariant: ["tabular-nums"],
    lineHeight: lineHeight.caption,
  },
});
