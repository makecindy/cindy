import { useSyncExternalStore } from 'react';
export type TaskListMode = 'tasks' | 'inbox';
const key = 'sidebar.taskListMode';
let memory: TaskListMode | undefined;
const listeners = new Set<() => void>();
function read(): TaskListMode {
  if (memory) return memory;
  try { return localStorage.getItem(key) === 'inbox' ? 'inbox' : 'tasks'; } catch { return 'tasks'; }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    memory = undefined;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}
function setMode(mode: TaskListMode) {
  memory = mode;
  try { localStorage.setItem(key, mode); } catch { /* Keep the in-memory selection. */ }
  listeners.forEach(listener => listener());
}
export function useTaskListMode() {
  return { mode: useSyncExternalStore(subscribe, read, () => 'tasks' as const), setMode };
}
