import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { FOLD_DESKTOP_SKINS, type FoldDesktopSkin } from "./FoldDesktopSkin";

// Phone-local appearance, shared across remote computers like input mode.
// Persist explicit choices only; absent/unknown values keep the default skin.
const key = "cindy.mobile.remote-desktop.fold-skin.v1";
let writes: Promise<void> = Promise.resolve();

export function useFoldSkinPreference() {
  const [skin, setSkin] = useState<FoldDesktopSkin>("macii");
  const edited = useRef(false);
  useEffect(() => {
    let active = true;
    void writes
      .then(() => AsyncStorage.getItem(key))
      .then((value) => {
        const saved = FOLD_DESKTOP_SKINS.find((skin) => skin === value);
        if (active && !edited.current && saved) setSkin(saved);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const update = useCallback((value: FoldDesktopSkin) => {
    edited.current = true;
    setSkin(value);
    // Preserve rapid swipes and let a newly mounted page await pending saves.
    writes = writes
      .then(() => AsyncStorage.setItem(key, value))
      .catch(() => undefined);
  }, []);
  return [skin, update] as const;
}
