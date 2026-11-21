import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { gitReviewApiFor } from '@/lib/gitReviewTransport';
import type { ReviewData } from '@/lib/gitReview.types';
import { createLogger } from '@/lib/logger';
import {
  buildWorkdirGitMaps,
  EMPTY_WORKDIR_GIT_MAPS,
  type WorkdirGitDirectoryChange,
  type WorkdirGitFileChange,
} from '../lib/workdirGitStatus';

const log = createLogger('workdir.gitStatus');
const REFRESH_DEBOUNCE_MS = 300;
const MAX_STORES = 12;

interface WorkdirGitSnapshot {
  data: ReviewData | null;
  files: ReadonlyMap<string, WorkdirGitFileChange>;
  directories: ReadonlyMap<string, WorkdirGitDirectoryChange>;
  changedLines: ReadonlyMap<string, ReadonlySet<number>>;
  loading: boolean;
  error: string | null;
}

const EMPTY_SNAPSHOT: WorkdirGitSnapshot = {
  data: null,
  ...EMPTY_WORKDIR_GIT_MAPS,
  loading: false,
  error: null,
};

interface WorkdirGitStore {
  key: string;
  sessionId: string;
  workdir: string;
  deviceId: string | null;
  snapshot: WorkdirGitSnapshot;
  listeners: Set<() => void>;
  loadPromise: Promise<void> | null;
  refreshTimer: number | null;
}

const stores = new Map<string, WorkdirGitStore>();

function storeKey(sessionId: string, workdir: string, deviceId: string | null): string {
  return `${deviceId ?? 'local'}:${sessionId}:${workdir}`;
}

function getStore(sessionId: string, workdir: string, deviceId: string | null): WorkdirGitStore {
  const key = storeKey(sessionId, workdir, deviceId);
  const existing = stores.get(key);
  if (existing) return existing;
  if (stores.size >= MAX_STORES) {
    for (const [candidateKey, candidate] of stores) {
      if (candidate.listeners.size > 0 || candidate.loadPromise) continue;
      stores.delete(candidateKey);
      break;
    }
  }
  const store: WorkdirGitStore = {
    key,
    sessionId,
    workdir,
    deviceId,
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    loadPromise: null,
    refreshTimer: null,
  };
  stores.set(key, store);
  return store;
}

function emit(store: WorkdirGitStore): void {
  for (const listener of store.listeners) listener();
}

function setSnapshot(store: WorkdirGitStore, next: WorkdirGitSnapshot): void {
  store.snapshot = next;
  emit(store);
}

function load(store: WorkdirGitStore): Promise<void> {
  if (store.loadPromise) return store.loadPromise;
  setSnapshot(store, { ...store.snapshot, loading: true });
  const api = window.electronAPI?.gitReview;
  const request = api
    ? gitReviewApiFor(store.deviceId).get({ sessionId: store.sessionId })
    : Promise.reject(new Error('gitReview IPC not available'));
  const promise = request
    .then((data) => {
      const maps = buildWorkdirGitMaps(data, store.workdir);
      setSnapshot(store, {
        data,
        ...maps,
        loading: false,
        error: null,
      });
    })
    .catch((error) => {
      log.warn('load failed', {
        sessionId: store.sessionId,
        deviceId: store.deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
      setSnapshot(store, {
        ...store.snapshot,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (store.loadPromise === promise) store.loadPromise = null;
    });
  store.loadPromise = promise;
  return promise;
}

function scheduleLoad(store: WorkdirGitStore): void {
  if (store.refreshTimer !== null) window.clearTimeout(store.refreshTimer);
  store.refreshTimer = window.setTimeout(() => {
    store.refreshTimer = null;
    void load(store);
  }, REFRESH_DEBOUNCE_MS);
}

export function useWorkdirGitChanges(
  sessionId: string | null | undefined,
  workdir: string,
  deviceId: string | null = null,
): WorkdirGitSnapshot & {
  refresh: () => void;
  scheduleRefresh: () => void;
} {
  const store = sessionId && workdir ? getStore(sessionId, workdir, deviceId) : null;
  const snapshot = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        if (!store) return () => {};
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      [store],
    ),
    () => store?.snapshot ?? EMPTY_SNAPSHOT,
    () => EMPTY_SNAPSHOT,
  );

  useEffect(() => {
    if (!store) return;
    void load(store);
    const onFocus = () => scheduleLoad(store);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (store.refreshTimer !== null) {
        window.clearTimeout(store.refreshTimer);
        store.refreshTimer = null;
      }
    };
  }, [store]);

  const refresh = useCallback(() => {
    if (store) void load(store);
  }, [store]);
  const scheduleRefresh = useCallback(() => {
    if (store) scheduleLoad(store);
  }, [store]);

  return { ...snapshot, refresh, scheduleRefresh };
}
