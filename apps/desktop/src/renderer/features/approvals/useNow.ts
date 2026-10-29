import { useSyncExternalStore } from 'react';

/**
 * One shared 1 s clock for every "Seen … ago" label and the account check. The timer exists only
 * while something is subscribed. Snapshots are quantised to whole seconds so repeated reads between
 * ticks are identical, as useSyncExternalStore requires.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

const snapshot = () => Math.floor(Date.now() / 1000) * 1000;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(() => { for (const fn of [...listeners]) fn(); }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
