/**
 * useIsCindyTheme — observe the live `data-theme` value on <html>.
 *
 * The CINDY surface rules (sidebar frost, window backing) are keyed on
 * `[data-theme='cindy-light']` / `[data-theme='cindy-dark']` rather than on a
 * ThemeProvider value, so surfaces that need to know whether those rules apply
 * must read the same signal. MutationObserver keeps it live across theme family
 * switches without coupling such surfaces to the theme store or requiring a
 * provider (settings sections render standalone in tests).
 */

import { useEffect, useState } from 'react';

const CINDY_THEME_PREFIX = 'cindy-';

function readIsCindyTheme(): boolean {
  if (typeof document === 'undefined') return false;
  return (document.documentElement.dataset.theme ?? '').startsWith(CINDY_THEME_PREFIX);
}

export function useIsCindyTheme(): boolean {
  const [isCindy, setIsCindy] = useState(readIsCindyTheme);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setIsCindy(readIsCindyTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    setIsCindy(readIsCindyTheme());
    return () => observer.disconnect();
  }, []);

  return isCindy;
}
