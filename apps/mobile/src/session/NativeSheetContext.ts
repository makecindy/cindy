import { createContext } from "react";

/** Present only inside a Material sheet; its dialog owns gestures and detents. */
export const NativeSheetContext = createContext<{
  expand(): void;
  height: number;
} | null>(null);
