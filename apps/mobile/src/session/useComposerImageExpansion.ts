import { useCallback, useEffect, useRef, useState } from "react";

/** Newly added images open the card; completing uploads respect an explicit collapse. */
export function useComposerImageExpansion(
  imageCount: number,
  imageSelectionRevision: number,
) {
  const previousSelectionRevision = useRef(imageSelectionRevision);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // Selection and completion can cancel each other out in the pending count.
    // The upload hook reports actual additions, including native paste starts.
    if (
      imageSelectionRevision !== previousSelectionRevision.current ||
      imageCount === 0
    ) {
      setCollapsed(false);
    }
    previousSelectionRevision.current = imageSelectionRevision;
  }, [imageCount, imageSelectionRevision]);
  const collapse = useCallback(() => setCollapsed(true), []);
  return { active: imageCount > 0 && !collapsed, collapse };
}
