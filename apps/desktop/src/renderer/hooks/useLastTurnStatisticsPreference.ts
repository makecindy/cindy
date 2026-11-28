import { useSyncExternalStore } from 'react';

const key = 'chat.lastTurnStatistics.enabled';
const listeners = new Set<() => void>();
let memory: boolean | undefined;

function read() {
  if (memory !== undefined) return memory;
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
function notify() { listeners.forEach(listener => listener()); }
function onStorage(event: StorageEvent) {
  if (event.key !== key && event.key !== null) return;
  memory = undefined;
  notify();
}
function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}
function setEnabled(enabled: boolean) {
  memory = enabled;
  try {
    // Only the explicit opt-in is stored; disabling follows the default again.
    if (enabled) localStorage.setItem(key, 'true');
    else localStorage.removeItem(key);
    memory = undefined;
  } catch { /* Keep the preference usable for this window. */ }
  notify();
}

export function useLastTurnStatisticsPreference() {
  const enabled = useSyncExternalStore(subscribe, read, () => false);
  return { enabled, isCustomized: enabled, setEnabled };
}
