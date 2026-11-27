import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";

// Phone-local override. The default is off; closing the floating window is not
// a preference change. Serialize writes across navigation/remounts. A device
// screen (a simulator) keeps its own choice, apart from the computer's.
const keys = {
  desktop: "cindy.mobile.remote-desktop.picture-in-picture.v1",
  liveScreen: "cindy.mobile.live-screen.picture-in-picture.v1",
} as const;
let writes: Promise<void> = Promise.resolve();
export function usePictureInPicturePreference(
  scope: keyof typeof keys = "desktop",
) {
  const key = keys[scope];
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
  }, [key]);
  const update = useCallback(
    (value: boolean) => {
      edited.current = true;
      setEnabled(value);
      writes = writes
        .then(() => AsyncStorage.setItem(key, String(value)))
        .catch(() => {});
    },
    [key],
  );
  return [enabled, update] as const;
}
