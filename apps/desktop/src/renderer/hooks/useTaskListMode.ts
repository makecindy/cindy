import { createContext, useSyncExternalStore } from 'react';
export const InboxUnreadReporter = createContext<((unread: boolean) => void) | null>(null);

export type TaskListMode = 'tasks' | 'inbox';
const key = 'sidebar.taskListMode';
let memory: TaskListMode | undefined;
const listeners = new Set<() => void>();
let storageListenerBound = false;
function read(): TaskListMode {
  if (memory) return memory;
  try {
    const mode = localStorage.getItem(key) === 'inbox' ? 'inbox' : 'tasks';
    if (storageListenerBound) memory = mode;
    return mode;
  } catch { return 'tasks'; }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!storageListenerBound) {
    storageListenerBound = true;
    window.addEventListener('storage', event => {
      if (event.key !== key && event.key !== null) return;
      memory = undefined;
      listeners.forEach(notify => notify());
    });
  }
  return () => { listeners.delete(listener); };
}
function setMode(mode: TaskListMode) {
  memory = mode;
  try { localStorage.setItem(key, mode); } catch { /* Keep the in-memory selection. */ }
  listeners.forEach(listener => listener());
}
export function useTaskListMode() {
  return { mode: useSyncExternalStore(subscribe, read, () => 'tasks' as const), setMode };
}
