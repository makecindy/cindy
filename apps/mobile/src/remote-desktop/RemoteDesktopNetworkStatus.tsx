import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { spacing, typeScale, useTheme } from "@/theme";
import { formatReceiveRate, type DesktopNetworkStats } from "./networkStats";

// Render inside the viewer, between its backdrop and interactive desktop.
export function RemoteDesktopNetworkStatus({
  stats,
  video,
  top,
  send,
}: {
  stats: DesktopNetworkStats | null;
  video: boolean;
  top: number;
  send: (message: object) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
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
  const text = `${t(`remoteDesktop.${label}`)}\n${formatReceiveRate(stats?.bytesPerSecond ?? null)}${latency != null ? ` · ${Math.round(latency)} ms` : ""}`;
  useEffect(() => {
    send({
      type: "networkStatus",
      text,
      top,
      right: spacing.sm,
      fontSize: typeScale.caption,
      color: colors.textPrimary,
    });
  }, [send, text, top, colors.textPrimary]);
  useEffect(
    () => () => {
      send({ type: "networkStatus", text: "" });
    },
    [send],
  );
  return null;
}
