/**
 * Controls the Cindy character artwork behind the expanded left sidebar.
 *
 * The product default is hidden. localStorage stores only the user's override,
 * so switching back off removes the key and follows future defaults.
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'sidebar.brandFigure.visible';
const DEFAULT_VISIBLE = false;

let memoryValue: boolean | null = null;
const listeners = new Set<() => void>();

function parseStoredValue(raw: string | null): boolean | null {
  return raw === 'false' ? false : raw === 'true' ? true : null;
}

export function getSidebarBrandFigureVisible(): boolean {
  if (memoryValue !== null) return memoryValue;
  try {
    const stored = parseStoredValue(localStorage.getItem(STORAGE_KEY));
    if (stored !== null) return (memoryValue = stored);
  } catch {
    // localStorage may be unavailable; keep the product default.
  }
  return DEFAULT_VISIBLE;
}

export function useSidebarBrandFigurePreference(): {
  visible: boolean;
  setVisible: (next: boolean) => void;
} {
  const [visible, setVisibleState] = useState(getSidebarBrandFigureVisible);

  const setVisible = useCallback((next: boolean) => {
    memoryValue = next;
    setVisibleState(next);
    try {
      if (next === DEFAULT_VISIBLE) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, String(next));
      }
    } catch {
      // The in-memory preference still applies in this window.
    }
    listeners.forEach((listener) => listener());
  }, []);

  useEffect(() => {
    const sync = () => setVisibleState(getSidebarBrandFigureVisible());
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      memoryValue = parseStoredValue(event.newValue) ?? DEFAULT_VISIBLE;
      sync();
    };

    listeners.add(sync);
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { visible, setVisible };
}

export function _resetSidebarBrandFigurePreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
}
