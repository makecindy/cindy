export type DesktopNetworkStats = {
  transport: "video" | "direct" | "relay" | "screenshots";
  bytesPerSecond: number | null;
  latencyMs: number | null;
  at: number;
};

export function formatReceiveRate(bytes: number | null): string {
  if (bytes === null) return "— KB/s";
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB/s`
    : `${Math.round(bytes / 1000)} KB/s`;
}

export { DESKTOP_NETWORK_STATS_SCRIPT } from '@cindy/maker-shared/remote-desktop-scripts';
