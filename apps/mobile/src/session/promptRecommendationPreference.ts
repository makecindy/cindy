import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'cindy.mobile.prompt-recommendation.v1';
// Adding an opt-out must preserve the existing enabled behavior.
const DEFAULT_ENABLED = true;
const initial = { ready: false, enabled: false, customized: false };
let snapshot = initial;
let loaded: Promise<void> | undefined;
let revision = 0;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => snapshot;

function load(): Promise<void> {
  if (!loaded) {
    const startedAt = revision;
    loaded = AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (startedAt !== revision) return;
      const override = raw === 'true' ? true : raw === 'false' ? false : null;
      snapshot = { ready: true, enabled: override ?? DEFAULT_ENABLED, customized: override !== null };
      notify();
    }).catch(() => {
      // A failed read must not start paid predictions over a saved opt-out.
      if (startedAt === revision) {
        snapshot = { ...initial, ready: true };
        loaded = undefined;
        notify();
      }
    });
  }
  return loaded;
}

/** Phone-local choice, independent of the controlled computer. Null removes the override. */
export function savePromptRecommendationPreference(enabled: boolean | null): Promise<void> {
  const writeRevision = ++revision;
  loaded ??= Promise.resolve();
  // Keep reset available until its persisted override is actually removed.
  snapshot = { ready: true, enabled: enabled ?? DEFAULT_ENABLED, customized: enabled !== null || snapshot.customized };
  notify();
  const write = writes.catch(() => undefined).then(async () => {
    if (enabled === null) {
      await AsyncStorage.removeItem(STORAGE_KEY);
      if (writeRevision === revision) {
        snapshot = { ...snapshot, customized: false };
        notify();
      }
    } else {
      await AsyncStorage.setItem(STORAGE_KEY, String(enabled));
    }
  });
  writes = write;
  // Keep the choice active for this process on failure; the settings UI reports
  // that it was not saved. Serialize writes so a quick toggle cannot undo it.
  return write;
}

export function usePromptRecommendationPreference() {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { void load(); }, []);
  return value;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  reset() {
    snapshot = initial;
    loaded = undefined;
    revision = 0;
    writes = Promise.resolve();
    listeners.clear();
  },
};
