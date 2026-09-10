import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  radius,
  spacing,
  typeScale,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { formatReceiveRate, type DesktopNetworkStats } from "./networkStats";

export function RemoteDesktopNetworkStatus({
  stats,
  video,
  top,
}: {
  stats: DesktopNetworkStats | null;
  video: boolean;
  top: number;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const transport = stats?.transport ?? (video ? "video" : "screenshots");
  const label =
    !stats && !video
      ? "connecting"
      : {
          video: "live",
          direct: "directConnection",
          relay: "videoRelay",
          screenshots: "screenshotRelay",
        }[transport];
  const latency = stats?.latencyMs;
  return (
    <View
      pointerEvents="none"
      style={[styles.badge, { top }]}
      testID="remoteDesktop.network"
    >
      <Text style={styles.text}>{t(`remoteDesktop.${label}`)}</Text>
      <Text style={styles.text}>
        {`↓ ${formatReceiveRate(stats?.bytesPerSecond ?? null)}`}
        {latency != null
          ? ` · ${t(`remoteDesktop.${transport === "screenshots" ? "frameTime" : "roundTrip"}`, { ms: Math.round(latency) })}`
          : ""}
      </Text>
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    badge: {
      position: "absolute",
      right: spacing.sm,
      maxWidth: "75%",
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.control,
      backgroundColor: colors.surfaceTranslucent,
    },
    text: {
      fontSize: typeScale.caption,
      color: colors.textSecondary,
      textAlign: "right",
      fontVariant: ["tabular-nums"],
    },
  });
