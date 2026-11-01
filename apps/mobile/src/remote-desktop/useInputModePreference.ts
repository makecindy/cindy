import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";

export type InputMode = "touch" | "pointer" | "handle";
/** 操作方式的展示顺序,也是分段控件的索引顺序。 */
export const INPUT_MODES: readonly InputMode[] = ["touch", "pointer", "handle"];
// Phone-local preference shared across remote computers. Only explicit choices
// are persisted; absent or invalid values follow the default touch mode.
const STORAGE_KEY = "cindy.mobile.remote-desktop.input-mode.v1";
let writes: Promise<void> = Promise.resolve();

export function useInputModePreference() {
  const [mode, setMode] = useState<InputMode>("touch");
  const edited = useRef(false);

  useEffect(() => {
    let active = true;
    void writes
      .then(() => AsyncStorage.getItem(STORAGE_KEY))
      .then((value) => {
        if (active && !edited.current && INPUT_MODES.includes(value as InputMode)) {
          setMode(value as InputMode);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback((value: InputMode) => {
    edited.current = true;
    setMode(value);
    // Serialize rapid changes and let a newly mounted screen await pending saves.
    writes = writes
      .then(() => AsyncStorage.setItem(STORAGE_KEY, value))
      .catch(() => undefined);
  }, []);

  return [mode, update] as const;
}
