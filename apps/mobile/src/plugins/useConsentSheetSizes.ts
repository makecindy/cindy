import { useReducer, useRef } from "react";
import { emptyConsentSheetSizes, type ConsentSheetSizes } from "./pluginConsentPresentation";

type SizeKey = "identity" | "heading" | "actions";
/**
 * One consent's iOS sheet sizes at one window size and text size, for its layout only (maintainer review 18:13). `layoutKey` names
 * them (`consentLayoutKey`): another consent, a rotation or another text size starts from nothing (the sheet also draws
 * their measured views anew for a new key, so every size is reported again), and a late report made under the previous
 * key is dropped. No size lets Allow answer: both sheets are review first (maintainer reviews 19:34, 08:37).
 */
export function useConsentSheetSizes(layoutKey: string | null) {
  const sizes = useRef<ConsentSheetSizes>(emptyConsentSheetSizes(layoutKey));
  if (sizes.current.for !== layoutKey) sizes.current = emptyConsentSheetSizes(layoutKey);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const owned = () => sizes.current.for === layoutKey;
  return {
    sizes: sizes.current,
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
