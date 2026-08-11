import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'sidebar.showSessionTime';
const DEFAULT_SHOW_SESSION_TIME = true;

let memoryValue: boolean | null = null;
const listeners = new Set<() => void>();

function parseStoredValue(raw: string | null): boolean | null {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/** Read the effective sidebar time visibility without creating a React subscription. */
export function getShowSidebarSessionTime(): boolean {
  if (memoryValue !== null) return memoryValue;

  try {
    const stored = parseStoredValue(localStorage.getItem(STORAGE_KEY));
    if (stored !== null) {
      memoryValue = stored;
      return stored;
    }
  } catch {
    // localStorage can be unavailable in restricted renderer contexts.
  }

  return DEFAULT_SHOW_SESSION_TIME;
}

function setStoredValue(next: boolean): void {
  try {
    if (next === DEFAULT_SHOW_SESSION_TIME) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, String(next));
    }
  } catch {
    // Keep the in-memory preference effective when persistence is unavailable.
  }
}

function setShowSidebarSessionTime(next: boolean): void {
  memoryValue = next;
  setStoredValue(next);
  listeners.forEach((listener) => listener());
}

export function useSidebarSessionTimeVisibility(): {
  showSessionTime: boolean;
  setShowSessionTime: (next: boolean) => void;
  resetShowSessionTime: () => void;
} {
  const [showSessionTime, setShowSessionTimeState] = useState(getShowSidebarSessionTime);

  const setShowSessionTime = useCallback((next: boolean) => {
    setShowSidebarSessionTime(next);
  }, []);

  const resetShowSessionTime = useCallback(() => {
    setShowSidebarSessionTime(DEFAULT_SHOW_SESSION_TIME);
  }, []);

  useEffect(() => {
    const sync = () => setShowSessionTimeState(getShowSidebarSessionTime());
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      memoryValue = parseStoredValue(event.newValue);
      sync();
    };

    listeners.add(sync);
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    showSessionTime,
    setShowSessionTime,
    resetShowSessionTime,
  };
}
