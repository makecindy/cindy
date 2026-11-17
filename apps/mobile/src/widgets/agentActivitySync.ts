import { mobileDebugLog } from "@/debug/mobileDebugLog";

export interface AgentActivitySink {
  setState(json: string | null): void;
  markStale(): void;
}

/** Coalesce store bursts without postponing the latest state indefinitely. Undefined
 * means the connection cannot attest to the snapshot; null means no tasks remain. */
export function createAgentActivitySync(
  read: () => string | null | undefined,
  sink: AgentActivitySink,
  canSync: () => boolean = () => true,
) {
  let last: string | null | undefined;
  let lastWrite = -Infinity;
  let stale = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sync = (force = false) => {
    if (disposed) return;
    // Background JS/store state cannot attest to host freshness. Retain the last
    // native deadline instead of ending, renewing or expiring it on suspension.
    // Check here as well as at the event source so queued writes obey this gate.
    if (!canSync()) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    const json = read();
    if (json === undefined) {
      clearTimeout(timer);
      timer = undefined;
      if (!stale) {
        sink.markStale();
        mobileDebugLog("info", "lifecycle", "activity-unverified");
      }
      stale = true;
      return;
    }
    const elapsed = Date.now() - lastWrite;
    // Refresh the native stale deadline while a healthy foreground connection
    // still confirms the same task. No network request is involved.
    if (!force && !stale && json === last && (json === null || elapsed < 60_000)) return;
    if (!force && !stale && json !== null && elapsed < 1_000) {
      timer ??= setTimeout(() => { timer = undefined; sync(); }, 1_000 - elapsed);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    sink.setState(json);
    mobileDebugLog("debug", "lifecycle", "activity-local-sync", {
      outcome: json === null ? "ended" : "confirmed", recovered: stale,
    });
    last = json;
    lastWrite = Date.now();
    stale = false;
  };
  return {
    sync,
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
