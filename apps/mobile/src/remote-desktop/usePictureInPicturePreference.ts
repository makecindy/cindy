import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";

// Phone-local override. The default is off; closing the floating window is not
// a preference change. Serialize writes across navigation/remounts.
const key = "cindy.mobile.remote-desktop.picture-in-picture.v1";
let writes: Promise<void> = Promise.resolve();
export function usePictureInPicturePreference() {
  const [enabled, setEnabled] = useState(false);
  const edited = useRef(false);
  useEffect(() => {
    let current = true;
    void writes
      .then(() => AsyncStorage.getItem(key))
      .then((value) => {
        if (current && !edited.current) setEnabled(value === "true");
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  const update = useCallback((value: boolean) => {
    edited.current = true;
    setEnabled(value);
    writes = writes
      .then(() => AsyncStorage.setItem(key, String(value)))
      .catch(() => {});
  }, []);
  return [enabled, update] as const;
}
