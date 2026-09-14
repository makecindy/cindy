import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RemoteDesktopVideoSettings } from "@cindy/device-link";
import { useCallback, useEffect, useRef, useState } from "react";

// Only the audio override persists on this phone; video quality stays session-local.
const AUDIO_KEY = "cindy.mobile.remote-desktop.audio.v1";
let writes: Promise<void> = Promise.resolve();

export function useVideoSettingsPreference() {
  const [settings, setSettings] = useState<RemoteDesktopVideoSettings>({
    fps: 30, bitrate: 0, audio: true,
  });
  const [loaded, setLoaded] = useState(false);
  const current = useRef(settings);
  const edited = useRef(false);

  useEffect(() => {
    let active = true;
    void writes
      .then(() => AsyncStorage.getItem(AUDIO_KEY))
      .then((value) => {
        if (!active || edited.current || (value !== "true" && value !== "false")) return;
        current.current = { ...current.current, audio: value === "true" };
        setSettings(current.current);
      })
      .catch(() => undefined)
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  const update = useCallback((value: RemoteDesktopVideoSettings) => {
    edited.current = true;
    if (value.audio !== current.current.audio) {
      writes = writes
        .then(() => AsyncStorage.setItem(AUDIO_KEY, String(value.audio)))
        .catch(() => undefined);
    }
    current.current = value;
    setSettings(value);
  }, []);

  return [settings, update, loaded] as const;
}
