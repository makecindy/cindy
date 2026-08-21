import { useSyncExternalStore } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  readSidebarOwnerStorage,
  removeSidebarOwnerStorage,
  writeSidebarOwnerStorage,
} from '@/lib/sidebarOwnerStorage';

const STORAGE_PREFIX = 'cindy.ghost.mainView.sidebarVisible';

let revision = 0;
const listeners = new Set<() => void>();

function storageKey(ghostId: string): string {
  return `${STORAGE_PREFIX}.${encodeURIComponent(ghostId)}`;
}

function emitChange(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return revision;
}

/** Missing, malformed and future values all preserve the default-visible behavior. */
export function readMainViewSidebarVisible(ownerId: string | null, ghostId: string): boolean {
  return readSidebarOwnerStorage(storageKey(ghostId), ownerId) !== 'false';
}

/** Persist only the non-default value so new Host defaults remain forward compatible. */
export function writeMainViewSidebarVisible(
  owner: DataOwnerGeneration,
  ghostId: string,
  visible: boolean,
): boolean {
  if (!owner.dataOwnerId || !isDataOwnerGenerationCurrent(owner)) return false;

  const ok = visible
    ? removeSidebarOwnerStorage(storageKey(ghostId), owner.dataOwnerId, owner.generation)
    : writeSidebarOwnerStorage(storageKey(ghostId), owner.dataOwnerId, 'false', owner.generation);
  if (!ok || !isDataOwnerGenerationCurrent(owner)) return false;

  emitChange();
  return true;
}

/** Re-render every main-view projection after a visibility preference changes. */
export function useMainViewVisibilityRevision(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function currentMainViewVisibilityOwner(): DataOwnerGeneration {
  return getDataOwnerGeneration();
}

export const __testing = {
  storageKey,
  reset(): void {
    revision = 0;
    listeners.clear();
  },
};
