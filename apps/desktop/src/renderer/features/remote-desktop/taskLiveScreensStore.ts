import { useSyncExternalStore } from 'react';
import type { RemoteLiveScreen } from '@cindy/device-link';

/**
 * The devices last read for each task, shared inside one window so the
 * sidebar tab can offer the task's other devices without asking that computer
 * again. A window that does not read the list (a detached sidebar) has none.
 */
const NONE: readonly RemoteLiveScreen[] = [];
const TASKS = 200;
const tasks = new Map<string, readonly RemoteLiveScreen[]>();
const listeners = new Set<() => void>();

export function publishTaskLiveScreens(
  sessionId: string,
  screens: readonly RemoteLiveScreen[],
): void {
  if (tasks.get(sessionId) === screens) return;
  if (!tasks.has(sessionId) && tasks.size >= TASKS)
    tasks.delete(tasks.keys().next().value as string);
  tasks.set(sessionId, screens);
  for (const listener of listeners) listener();
}

export function useKnownTaskLiveScreens(sessionId: string): readonly RemoteLiveScreen[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => tasks.get(sessionId) ?? NONE,
  );
}
