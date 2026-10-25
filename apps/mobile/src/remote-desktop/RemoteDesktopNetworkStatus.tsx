import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { spacing, typeScale, useTheme } from "@/theme";
import { formatReceiveRate, type DesktopNetworkStats } from "./networkStats";

/** "Direct to computer" plus the receive rate and latency, on two lines. */
export function desktopNetworkStatusText(
  t: (key: string) => string,
  stats: DesktopNetworkStats | null,
  video: boolean,
): string {
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
  return `${t(`remoteDesktop.${label}`)}\n${formatReceiveRate(stats?.bytesPerSecond ?? null)}${latency != null ? ` · ${Math.round(latency)} ms` : ""}`;
}

// Render inside the viewer, between its backdrop and interactive desktop.
export function RemoteDesktopNetworkStatus({
  stats,
  video,
  top,
  send,
  foreground,
}: {
  stats: DesktopNetworkStats | null;
  video: boolean;
  top: number;
  send: (message: object) => void;
  foreground?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const textColor = foreground ?? colors.textPrimary;
  const text = desktopNetworkStatusText(t, stats, video);
  useEffect(() => {
    send({
      type: "networkStatus",
      text,
      top,
      right: spacing.sm,
      fontSize: typeScale.caption,
      color: textColor,
    });
  }, [send, text, top, textColor]);
  useEffect(
    () => () => {
      send({ type: "networkStatus", text: "" });
    },
    [send],
  );
  return null;
}
