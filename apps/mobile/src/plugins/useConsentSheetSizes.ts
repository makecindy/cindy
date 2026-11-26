import { useReducer, useRef } from "react";
import { emptyConsentSheetSizes, type ConsentSheetSizes } from "./pluginConsentPresentation";

type SizeKey = "identity" | "heading" | "actions" | "visible" | "content";
/**
 * One consent's sheet sizes at one window size and text size, both sheets (maintainer review 18:13). `layoutKey` names
 * them (`consentLayoutKey`): another consent, a rotation or another text size starts from nothing (the sheets also draw
 * their measured views anew for a new key, so every size is reported again), and a late report made under the previous
 * key is dropped. `latest()` is read when Allow is pressed: a report lands in it at once, before the render it schedules.
 */
export function useConsentSheetSizes(layoutKey: string | null) {
  const sizes = useRef<ConsentSheetSizes>(emptyConsentSheetSizes(layoutKey));
  if (sizes.current.for !== layoutKey) sizes.current = emptyConsentSheetSizes(layoutKey);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const owned = () => sizes.current.for === layoutKey;
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
