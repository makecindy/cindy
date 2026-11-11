import {
  REMOTE_DESKTOP_DEFAULT_IDLE_MINUTES,
  isRemoteDesktopIdleMinutes,
} from "@cindy/device-link";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";

// Non-secret, phone-local override for this computer. Absence follows the current default.
let writes: Promise<void> = Promise.resolve();
export function useLockOnExitPreference(deviceId: string) {
  return useRemoteDesktopPreference(deviceId, "lock-on-exit", true);
}
export function useRemoteDesktopPreference(
  deviceId: string,
  feature: string,
  defaultValue: boolean,
) {
  const key = `cindy.mobile.remote-desktop.${feature}.v1.${encodeURIComponent(deviceId)}`;
  const [state, setState] = useState({ key, enabled: false, loaded: false });
  const edited = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    edited.current = null;
    void writes
      .then(() => AsyncStorage.getItem(key))
      .then((value) => {
        if (active && edited.current !== key)
          setState({
            key,
            enabled: value === null ? defaultValue : value === "true",
            loaded: true,
          });
      })
      .catch(() => {
        // An unreadable override is not an opt-out: follow the current default.
        if (active) setState({ key, enabled: defaultValue, loaded: true });
      });
    return () => {
      active = false;
    };
  }, [key, defaultValue]);
  const update = useCallback(
    (enabled: boolean) => {
      edited.current = key;
      setState({ key, enabled, loaded: true });
      writes = writes
        .then(() => AsyncStorage.setItem(key, String(enabled)))
        .catch(() => undefined);
    },
    [key],
  );
  return [
    state.key === key && state.enabled,
    update,
    state.key === key && state.loaded,
  ] as const;
}

/** Per-computer non-secret override; an absent or invalid value follows the safe default. */
export function useIdleTimeoutPreference(deviceId: string) {
  const key = `cindy.mobile.remote-desktop.idle-timeout.v1.${encodeURIComponent(deviceId)}`;
  const [state, setState] = useState({
    key,
    minutes: REMOTE_DESKTOP_DEFAULT_IDLE_MINUTES,
    loaded: false,
  });
  const edited = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    edited.current = null;
    void writes
      .then(() => AsyncStorage.getItem(key))
      .catch(() => null)
      .then((value) => {
        const minutes =
          value === null || !/^\d+$/.test(value)
            ? REMOTE_DESKTOP_DEFAULT_IDLE_MINUTES
            : Number(value);
        if (active && edited.current !== key)
          setState({
            key,
            minutes: isRemoteDesktopIdleMinutes(minutes)
              ? minutes
              : REMOTE_DESKTOP_DEFAULT_IDLE_MINUTES,
            loaded: true,
          });
      });
    return () => {
      active = false;
    };
  }, [key]);
  const update = useCallback(
    (minutes: number) => {
      if (!isRemoteDesktopIdleMinutes(minutes)) return;
      edited.current = key;
      setState({ key, minutes, loaded: true });
      writes = writes
        .then(() =>
          minutes === REMOTE_DESKTOP_DEFAULT_IDLE_MINUTES
            ? AsyncStorage.removeItem(key)
            : AsyncStorage.setItem(key, String(minutes)),
        )
        .catch(() => undefined);
    },
    [key],
  );
  return [
    state.key === key ? state.minutes : REMOTE_DESKTOP_DEFAULT_IDLE_MINUTES,
    update,
    state.key === key && state.loaded,
  ] as const;
}
