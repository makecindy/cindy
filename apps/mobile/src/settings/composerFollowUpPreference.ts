import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

export type ComposerFollowUpMode = 'queue' | 'steer';

const storageKey = 'cindy.mobile.composer-follow-up.v1';
let mode: ComposerFollowUpMode = 'queue';
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function loadComposerFollowUpMode(): Promise<void> {
  loaded ??= AsyncStorage.getItem(storageKey).then(value => {
    mode = value === 'steer' ? 'steer' : 'queue';
    listeners.forEach(listener => listener());
  }).catch(() => { loaded = undefined; });
  return loaded;
}

export function getComposerFollowUpMode(): ComposerFollowUpMode {
  return mode;
}

export async function saveComposerFollowUpMode(value: ComposerFollowUpMode): Promise<void> {
  await loadComposerFollowUpMode();
  if (value === 'queue') await AsyncStorage.removeItem(storageKey);
  else await AsyncStorage.setItem(storageKey, value);
  mode = value;
  listeners.forEach(listener => listener());
}

export function useComposerFollowUpMode() {
  useEffect(() => { void loadComposerFollowUpMode(); }, []);
  return useSyncExternalStore(subscribe, getComposerFollowUpMode, getComposerFollowUpMode);
}
