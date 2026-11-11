import { FILE_PEER_IDLE_MS } from "./filePeer";

/** Existing command/receive budgets, now shared by route policy and both adapters.
 * These are bounded-wait product budgets, not claims about optimal network speed. */
export const FILE_PEER_COMMAND_TIMEOUT_MS = 15_000;
export const FILE_PEER_RECEIVE_TIMEOUT_MS = 60_000;
export const FILE_PEER_PROGRESS_SAMPLE_MS = 1000;
export type FileTransferPath = "direct" | "relay" | "unknown";

export function fileTransferPath(stats: unknown): FileTransferPath {
  try {
    const value = typeof stats === "string" ? JSON.parse(stats) : stats;
    return value?.path === "relay"
      ? "relay"
      : value?.path === "direct"
        ? "direct"
        : "unknown";
  } catch {
    return "unknown";
  }
}

/** Leave one command budget before the host expires a connection; old hosts use
 * their established 30s controller lifetime. Reject non-finite capability values. */
export function filePeerReuseMs(advertised: unknown, sessionBound?: unknown): number | null {
  // Explicit capability negotiation only: old peers must retain their idle budget.
  if (sessionBound === true) return null;
  return typeof advertised === "number" &&
    Number.isFinite(advertised) &&
    advertised >= FILE_PEER_RECEIVE_TIMEOUT_MS
    ? Math.min(FILE_PEER_IDLE_MS, advertised) - FILE_PEER_COMMAND_TIMEOUT_MS
    : FILE_PEER_RECEIVE_TIMEOUT_MS / 2;
}

/** Only abandon stalled transfers. Receive timeouts bound inactivity, not total
 * duration: large files may take minutes while making steady progress. Without
 * measuring the fallback route, a completion estimate cannot justify discarding
 * bytes already received. The same rule applies to direct and relayed traffic. */
export function createFileTransferWatchdog(now = Date.now) {
  let lastBytes = 0,
    lastProgress = now();
  return (written: number): "stalled" | null => {
    const time = now();
    if (written > lastBytes) {
      lastBytes = written;
      lastProgress = time;
    }
    return time - lastProgress >= FILE_PEER_COMMAND_TIMEOUT_MS ? "stalled" : null;
  };
}

/** Validated by the host on every read; absent on older hosts, disabling reuse. */
export function validFileVersion(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
