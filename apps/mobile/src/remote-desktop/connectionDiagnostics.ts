import { mobileDebugLog } from "@/debug/mobileDebugLog";

type Stage =
  | "connect"
  | "link-ready"
  | "capabilities"
  | "capture-started"
  | "control-ready"
  | "screenshot-presented"
  | "video-frame-ready"
  | "video-presented"
  | "stopped";
/** One sample per milestone, with no host IDs or media/credential content. */
export function connectionDiagnostics(
  attempt: number,
  now = () => performance.now(),
) {
  const started = now();
  const seen = new Set<Stage>();
  let stopped = false;
  return (stage: Stage) => {
    if (stopped || seen.has(stage)) return;
    seen.add(stage);
    if (stage === "stopped") stopped = true;
    mobileDebugLog("info", "device-link", "remote-desktop-timing", {
      attempt,
      stage,
      elapsedMs: Math.max(0, Math.round(now() - started)),
    });
  };
}
