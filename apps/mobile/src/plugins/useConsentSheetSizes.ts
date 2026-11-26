import { useReducer, useRef } from "react";
import { emptyConsentSheetSizes, type ConsentSheetSizes } from "./pluginConsentPresentation";

type SizeKey = "identity" | "heading" | "actions" | "visible" | "content";
/**
 * One consent's sheet sizes, both sheets (maintainer review 18:13). Kept per requestId: another consent starts from
 * nothing, and a late report from the previous consent's views is dropped. `latest()` is read when Allow is pressed: a
 * report lands in it at once, before the render it schedules.
 */
export function useConsentSheetSizes(requestId: string | null) {
  const sizes = useRef<ConsentSheetSizes>(emptyConsentSheetSizes(requestId));
  if (sizes.current.for !== requestId) sizes.current = emptyConsentSheetSizes(requestId);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const owned = () => sizes.current.for === requestId;
  return {
    sizes: sizes.current,
    latest: () => sizes.current,
    report: (key: SizeKey, height: number) => {
      const value = Math.ceil(height);
      if (!owned() || sizes.current[key] === value) return;
      sizes.current = { ...sizes.current, [key]: value };
      rerender();
    },
    reportLine: (index: number, height: number) => {
      const value = Math.ceil(height);
      if (!owned() || sizes.current.lines[index] === value) return;
      sizes.current = { ...sizes.current, lines: Object.assign([...sizes.current.lines], { [index]: value }) };
      rerender();
    },
  };
}
