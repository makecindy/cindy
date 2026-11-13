import { useEffect, useState } from "react";
import {
  REMOTE_DESKTOP_CHANNEL,
  taskLiveScreens,
  type RemoteDesktopCapabilities,
  type RemoteLiveScreen,
} from "@cindy/device-link";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";

const REFRESH_MS = 15_000;

export { taskLiveScreens };

/**
 * Plugin live screens (such as simulators) of this task on its computer, for
 * the task page's entries. Only computers advertising `liveScreens` are asked;
 * an older computer, an unreachable one or a failed read shows no entry.
 */
export function useTaskLiveScreens(
  deviceId: string | undefined,
  sessionId: string | undefined,
  active: boolean,
): RemoteLiveScreen[] {
  const link = useDeviceLink();
  const online = link.status === "online";
  const invoke = link.invoke;
  const [state, setState] = useState<{
    key: string;
    screens: RemoteLiveScreen[];
  }>({
    key: "",
    screens: [],
  });
  const key = `${deviceId ?? ""}:${sessionId ?? ""}`;
  useEffect(() => {
    if (!active || !online || !deviceId || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let supported: boolean | null = null;
    const publish = (screens: RemoteLiveScreen[]) => {
      if (cancelled) return;
      setState((current) =>
        current.key === key &&
        JSON.stringify(current.screens) === JSON.stringify(screens)
          ? current
          : { key, screens },
      );
    };
    const refresh = async () => {
      try {
        if (supported === null) {
          const caps = await invoke<RemoteDesktopCapabilities>(
            deviceId,
            REMOTE_DESKTOP_CHANNEL,
            [{ op: "capabilities" }],
          );
          supported =
            caps?.version === 1 && caps.enabled && caps.liveScreens === true;
        }
        if (!supported) {
          publish([]);
          return;
        }
        const result = await invoke<unknown>(deviceId, REMOTE_DESKTOP_CHANNEL, [
          { op: "screens" },
        ]);
        publish(taskLiveScreens(result, sessionId));
      } catch {
        // Ask again next time: the computer may have been busy or reconnecting.
        supported = null;
        publish([]);
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), REFRESH_MS);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, online, deviceId, sessionId, key, invoke]);
  return active && online && state.key === key ? state.screens : [];
}
