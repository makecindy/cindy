import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";

// Device-local display preference, shared across remote computers. Absence means
// the default (off); only an explicit toggle writes a boolean override.
const STORAGE_KEY = "cindy.mobile.remote-desktop.show-mouse-buttons.v1";
let writes: Promise<void> = Promise.resolve();

export function useMouseButtonsPreference() {
  const [enabled, setEnabled] = useState(false);
  const edited = useRef(false);

  useEffect(() => {
    let active = true;
    void writes
      .then(() => AsyncStorage.getItem(STORAGE_KEY))
      .then((value) => {
        if (active && !edited.current) setEnabled(value === "true");
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback((value: boolean) => {
    edited.current = true;
    setEnabled(value);
    // Preserve toggle order, including a quick exit and re-entry into the page.
    writes = writes
      .then(() => AsyncStorage.setItem(STORAGE_KEY, String(value)))
      .catch(() => undefined);
  }, []);

  return [enabled, update] as const;
}
