import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";

// Non-secret, phone-local override for this computer. Absence follows default off.
let writes: Promise<void> = Promise.resolve();
export function useLockOnExitPreference(deviceId: string) {
  return useRemoteDesktopPreference(deviceId, "lock-on-exit", false);
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
        if (active) setState({ key, enabled: false, loaded: true });
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
