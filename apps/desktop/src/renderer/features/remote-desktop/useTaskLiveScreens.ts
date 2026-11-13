import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  REMOTE_DESKTOP_CHANNEL,
  taskLiveScreens,
  type RemoteDesktopCapabilities,
  type RemoteLiveScreen,
} from '@cindy/device-link';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';

/** Same pace as Mobile's task page. */
const REFRESH_MS = 15_000;
/** Switching back and forth between windows does not ask again sooner than this. */
const REFOCUS_MS = 3_000;
const NONE: RemoteLiveScreen[] = [];

export interface TaskLiveScreens {
  screens: RemoteLiveScreen[];
  /** The list was just read from that computer: an empty one means no device, not "unknown". */
  loaded: boolean;
}
const UNKNOWN: TaskLiveScreens = { screens: NONE, loaded: false };

/**
 * Plugin live screens (such as simulators) that the task's computer has bound
 * to this task, for the entries beside the remote desktop button. A computer
 * with two copies of one plugin lists a device once per copy. Only a
 * reachable computer advertising `liveScreens` is asked, and only while this
 * window is in front: every read makes that computer ask its plugins, so a
 * window left open in the background stays quiet and reads again once the user
 * returns to it. An older computer or a failed read shows no entry.
 */
export function useTaskLiveScreens(
  deviceId: string | null | undefined,
  sessionId: string | null | undefined,
): TaskLiveScreens {
  const devices = useDeviceLinkDeviceList();
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  const unresponsive = useSyncExternalStore(
    unresponsiveDevicesStore.subscribe,
    unresponsiveDevicesStore.getSnapshot,
  );
  const device = deviceId ? devices?.find((entry) => entry.deviceId === deviceId) : undefined;
  const reachable =
    !!device &&
    !device.isSelf &&
    !isMobilePlatform(device.platform) &&
    device.online &&
    device.controlEnabled &&
    device.remoteControlEnabled &&
    !revoked.has(device.deviceId) &&
    !unresponsive.has(device.deviceId);
  const key = reachable && deviceId && sessionId ? `${deviceId}:${sessionId}` : '';
  const [state, setState] = useState<{ key: string; value: TaskLiveScreens }>({
    key: '',
    value: UNKNOWN,
  });
  useEffect(() => {
    if (!key || !deviceId || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let readAt = 0;
    let supported: boolean | null = null;
    const publish = (screens: RemoteLiveScreen[], loaded = true) => {
      if (cancelled) return;
      setState((current) =>
        current.key === key &&
        current.value.loaded === loaded &&
        JSON.stringify(current.value.screens) === JSON.stringify(screens)
          ? current
          : { key, value: { screens, loaded } },
      );
    };
    const invoke = (op: 'capabilities' | 'screens') =>
      window.electronAPI.deviceLink.invoke(deviceId, REMOTE_DESKTOP_CHANNEL, [{ op }]);
    const inFront = () => !document.hidden && document.hasFocus();
    const refresh = async () => {
      clearTimeout(timer);
      if (cancelled || busy || !inFront()) return;
      busy = true;
      readAt = Date.now();
      try {
        if (supported === null) {
          const caps = (await invoke('capabilities')) as RemoteDesktopCapabilities | null;
          supported = caps?.version === 1 && caps.enabled && caps.liveScreens === true;
        }
        if (!supported) {
          publish(NONE);
          return;
        }
        publish(taskLiveScreens(await invoke('screens'), sessionId));
      } catch {
        // Ask again next time: the computer may have been busy or reconnecting.
        supported = null;
        publish(NONE, false);
      } finally {
        busy = false;
        if (!cancelled) timer = setTimeout(() => void refresh(), REFRESH_MS);
      }
    };
    const returned = () => {
      if (cancelled || busy || !inFront()) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), Math.max(0, readAt + REFOCUS_MS - Date.now()));
    };
    document.addEventListener('visibilitychange', returned);
    window.addEventListener('focus', returned);
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', returned);
      window.removeEventListener('focus', returned);
    };
  }, [key, deviceId, sessionId]);
  return key && state.key === key ? state.value : UNKNOWN;
}
