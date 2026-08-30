import { useSyncExternalStore } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushStampCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush';

interface MainViewVisibilitySnapshot extends DataOwnerPushStamp {
  readonly hiddenGhostIds: ReadonlySet<string>;
}

let snapshot: MainViewVisibilitySnapshot | null = null;
let revision = 0;
let unsubscribeFromMain: (() => void) | null = null;
const listeners = new Set<() => void>();

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

function emitChange(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function reconcile(
  hiddenGhostIds: readonly string[],
  ownerStamp: DataOwnerPushStamp,
  notify: boolean,
): boolean {
  if (!isDataOwnerPushStampCurrent(ownerStamp)) return false;
  const nextIds = new Set(hiddenGhostIds);
  if (
    snapshot?.dataOwnerId === ownerStamp.dataOwnerId &&
    snapshot.ownerGeneration === ownerStamp.ownerGeneration &&
    sameIds(snapshot.hiddenGhostIds, nextIds)
  ) {
    return false;
  }
  snapshot = { ...ownerStamp, hiddenGhostIds: nextIds };
  if (notify) emitChange();
  else revision += 1;
  return true;
}

function refreshFromMain(notify: boolean): void {
  const latest = window.electronAPI.sidebarSettings.loadSnapshot();
  reconcile(latest.hiddenMainViewGhostIds, latest, notify);
}

function ensureCurrentSnapshot(): void {
  const owner = getDataOwnerGeneration();
  if (
    snapshot?.dataOwnerId === owner.dataOwnerId &&
    snapshot.ownerGeneration === owner.generation
  ) {
    return;
  }
  refreshFromMain(false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!unsubscribeFromMain) {
    unsubscribeFromMain = window.electronAPI.sidebarSettings.onHiddenMainViewGhostIdsChanged(
      (hiddenGhostIds, ownerStamp) => {
        reconcile(hiddenGhostIds, ownerStamp, true);
      },
    );
  }
  // Subscribe before re-reading so a write racing the first render is observed
  // either through the broadcast or through this authoritative snapshot.
  refreshFromMain(true);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeFromMain?.();
      unsubscribeFromMain = null;
    }
  };
}

function getSnapshot(): number {
  ensureCurrentSnapshot();
  return revision;
}

/** Unknown owners and absent overrides preserve the default-visible behavior. */
export function readMainViewSidebarVisible(ownerId: string | null, ghostId: string): boolean {
  ensureCurrentSnapshot();
  const owner = getDataOwnerGeneration();
  if (
    !snapshot ||
    snapshot.dataOwnerId !== ownerId ||
    snapshot.dataOwnerId !== owner.dataOwnerId ||
    snapshot.ownerGeneration !== owner.generation
  ) {
    return true;
  }
  return !snapshot.hiddenGhostIds.has(ghostId);
}

/** Persist through Main so concurrent windows and account generations cannot overwrite each other. */
export async function writeMainViewSidebarVisible(
  owner: DataOwnerGeneration,
  ghostId: string,
  visible: boolean,
): Promise<boolean> {
  if (!owner.dataOwnerId || !isDataOwnerGenerationCurrent(owner)) return false;
  const ownerStamp: DataOwnerPushStamp = {
    dataOwnerId: owner.dataOwnerId,
    ownerGeneration: owner.generation,
  };
  const hiddenGhostIds = await window.electronAPI.sidebarSettings.setMainViewHidden(
    ghostId,
    !visible,
    ownerStamp,
  );
  if (!isDataOwnerGenerationCurrent(owner)) return false;
  reconcile(hiddenGhostIds, ownerStamp, true);
  return true;
}

/** Re-render every main-view projection after the authoritative preference changes. */
export function useMainViewVisibilityRevision(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function currentMainViewVisibilityOwner(): DataOwnerGeneration {
  return getDataOwnerGeneration();
}

export const __testing = {
  reset(): void {
    unsubscribeFromMain?.();
    unsubscribeFromMain = null;
    snapshot = null;
    revision = 0;
    listeners.clear();
  },
};
