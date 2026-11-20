import { useSyncExternalStore } from 'react';
import { useTaskListMode, type TaskListMode } from './useTaskListMode';
import { sidebarModeKey } from './sidebarModeKey';

/** The menu and all visible rows share one snapshot per mode and one storage listener. */
export function createSidebarModePreference<T>(
  key: string,
  load: (mode: TaskListMode) => T,
  persist: (value: T, mode: TaskListMode) => void,
) {
  function createStore(mode: TaskListMode) {
    const listeners = new Set<() => void>();
    const storageKey = sidebarModeKey(key, mode);
    let cached: T | undefined;
    let listening = false;
    const notify = () => listeners.forEach(listener => listener());
    const get = () => (cached ??= load(mode));
    const subscribe = (listener: () => void) => {
      if (!listening) {
        listening = true;
        // Keep the cache current even while this mode has no mounted rows.
        window.addEventListener('storage', event => {
          if (event.key !== null && event.key !== storageKey) return;
          cached = undefined;
          notify();
        });
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    const set = (value: T) => {
      cached = value;
      persist(value, mode);
      notify();
    };
    return { get, set, subscribe };
  }
  const stores = { tasks: createStore('tasks'), inbox: createStore('inbox') };
  return function usePreference() {
    const { mode } = useTaskListMode();
    const store = stores[mode];
    const value = useSyncExternalStore(store.subscribe, store.get, store.get);
    return { value, store };
  };
}
