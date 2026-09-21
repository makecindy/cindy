import { useCallback, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { getMobileAuthOwner } from '@/auth/authOwnerGeneration';

/** Ephemeral Home state shared by its full-width and sidebar presentations.
 * No task data or disk writes; changing account ownership drops the entire view. */
export class HomeViewSession {
  private values = new Map<string, unknown>();
  private listeners = new Map<string, Set<() => void>>();
  has(key: string): boolean { return this.values.has(key); }
  read<T>(key: string, fallback: T | (() => T)): T {
    if (!this.values.has(key)) {
      this.values.set(key, typeof fallback === 'function' ? (fallback as () => T)() : fallback);
    }
    return this.values.get(key) as T;
  }
  write<T>(key: string, value: T): void {
    if (Object.is(this.values.get(key), value) && this.values.has(key)) return;
    this.values.set(key, value);
    this.listeners.get(key)?.forEach((listener) => listener());
  }
  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }
}
let owner = getMobileAuthOwner();
let current = new HomeViewSession();
export function getHomeViewSession(): HomeViewSession {
  const next = getMobileAuthOwner();
  if (next !== owner) { owner = next; current = new HomeViewSession(); }
  return current;
}

/** Retain committed interactions synchronously, before navigation can mount Home elsewhere. */
export function useRetainedHomeState<T>(session: HomeViewSession | undefined, key: string, initial: T | (() => T)):
  [T, Dispatch<SetStateAction<T>>] {
  const [localValue, setValue] = useState<T>(() => session
    ? session.read(key, initial)
    : typeof initial === 'function' ? (initial as () => T)() : initial);
  // Home remains mounted behind the task. Sidebar edits must update that same
  // state before it is uncovered; remounting is no longer the synchronization mechanism.
  const subscribe = useCallback((listener: () => void) => session?.subscribe(key, listener) ?? (() => {}), [session, key]);
  const getSnapshot = useCallback(() => session ? session.read(key, localValue) : localValue, [session, key, localValue]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const latest = useRef(value);
  latest.current = value;
  const update = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const next = typeof action === 'function' ? (action as (previous: T) => T)(latest.current) : action;
    latest.current = next;
    session?.write(key, next);
    setValue(next);
  }, [session, key]);
  return [value, update];
}
