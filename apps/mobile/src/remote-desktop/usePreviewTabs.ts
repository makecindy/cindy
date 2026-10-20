import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { REMOTE_DESKTOP_CHANNEL } from "@cindy/device-link";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  previewPollDelay,
  readPreviewTabs,
  samePreviewListing,
  type PreviewCapsMemo,
  type PreviewTabListing,
} from "./previewTabsQuery";

/**
 * Plugin preview tabs the computer has open for a task, while `active`.
 * Empty whenever the computer is offline, old, has remote desktop off, or the
 * task has none: the phone cannot tell those apart and shows nothing.
 *
 * Capabilities are read once per run (mount, back to the foreground, computer
 * reconnected); polling only lists tabs. It stops when the app leaves the
 * foreground, the page is not `active` or the computer is offline, and backs
 * off after failures instead of retrying quickly.
 */
export function usePreviewTabs({
  deviceId,
  sessionId,
  active,
}: {
  deviceId: string;
  sessionId: string;
  active: boolean;
}): PreviewTabListing[] {
  const link = useDeviceLink();
  const linkRef = useRef(link);
  linkRef.current = link;
  const online = link.status === "online";
  const [tabs, setTabs] = useState<PreviewTabListing[]>([]);
  useEffect(() => {
    if (!active || !online || !deviceId || !sessionId) {
      setTabs((previous) => (previous.length ? [] : previous));
      return;
    }
    let stopped = false;
    let running = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const memo: PreviewCapsMemo = { checked: false, supported: false };
    const schedule = () => {
      if (stopped || AppState.currentState !== "active") return;
      timer = setTimeout(() => void run(), previewPollDelay(failures));
    };
    const run = async () => {
      timer = null;
      if (stopped || running || AppState.currentState !== "active") return;
      running = true;
      try {
        const next = await readPreviewTabs(
          (message) =>
            linkRef.current.invoke(
              deviceId,
              REMOTE_DESKTOP_CHANNEL,
              [message],
              { background: true },
            ),
          sessionId,
          memo,
        );
        failures = 0;
        if (!stopped)
          setTabs((previous) =>
            samePreviewListing(previous, next) ? previous : next,
          );
      } catch {
        // An unanswered poll is not a closed preview, but a stale entry would
        // lead into a view that cannot start.
        failures += 1;
        if (!stopped) setTabs((previous) => (previous.length ? [] : previous));
      } finally {
        running = false;
        schedule();
      }
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (state !== "active") return;
      // Back in the foreground: ask afresh, since the computer may have changed.
      memo.checked = false;
      failures = 0;
      void run();
    });
    void run();
    return () => {
      stopped = true;
      subscription.remove();
      if (timer) clearTimeout(timer);
    };
  }, [active, online, deviceId, sessionId]);
  return tabs;
}
