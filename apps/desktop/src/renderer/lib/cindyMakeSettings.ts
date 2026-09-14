import { useSyncExternalStore } from 'react';

// Test-only view state: survives navigation to chat, resets on reload/restart.
// Never persisted as a user preference or inherited by a packaged build.
let forceManagedTools = false;
const listeners = new Set<() => void>();
const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};

export function isCindyMakeForceManagedToolsEnabled(): boolean {
  return import.meta.env.DEV && forceManagedTools;
}

export function setCindyMakeForceManagedTools(enabled: boolean): void {
  forceManagedTools = import.meta.env.DEV && enabled;
  listeners.forEach((listener) => listener());
}

export function useCindyMakeSettings(): {
  forceManagedTools: boolean;
  setForceManagedTools: (enabled: boolean) => void;
} {
  const enabled = useSyncExternalStore(subscribe, isCindyMakeForceManagedToolsEnabled, () => false);
  return { forceManagedTools: enabled, setForceManagedTools: setCindyMakeForceManagedTools };
}
