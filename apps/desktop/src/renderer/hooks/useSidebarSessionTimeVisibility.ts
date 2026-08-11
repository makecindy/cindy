import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'sidebar.showSessionTime';
const DEFAULT_SHOW_SESSION_TIME = true;

let memoryValue: boolean | null = null;
const listeners = new Set<() => void>();
let storageListenerAttached = false;

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

function handleStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  memoryValue = parseStoredValue(event.newValue);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListenerAttached) {
    window.addEventListener('storage', handleStorage);
    storageListenerAttached = true;
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageListenerAttached) {
      window.removeEventListener('storage', handleStorage);
      storageListenerAttached = false;
    }
  };
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
    return subscribe(sync);
  }, []);

  return {
    showSessionTime,
    setShowSessionTime,
    resetShowSessionTime,
  };
}
