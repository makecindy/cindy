/**
 * Renderer mirror of where each companion runs (docs/product-rules/cloud-companions.md).
 * Main owns the truth; this keeps the latest snapshot, re-reads on owner change and
 * follows `onCompanionCloudChanged`. Old-owner responses and pushes are dropped, and so is a
 * refresh answered after a newer push.
 */
import { useEffect, useSyncExternalStore } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  EMPTY_COMPANION_CLOUD_SNAPSHOT,
  type CompanionCloudSnapshot,
} from '../../../shared/companionCloud';

type MakerApi = Window['electronAPI']['maker'];

let snapshot: CompanionCloudSnapshot = EMPTY_COMPANION_CLOUD_SNAPSHOT;
let owner = getDataOwnerGeneration();
// Counts pushes: a refresh answered after a push may carry the older snapshot.
let pushes = 0;
let users = 0;
let unsubscribePush: (() => void) | null = null;
const listeners = new Set<() => void>();

export function companionCloudApi(): MakerApi | null {
  if (typeof window === 'undefined') return null;
  const maker = window.electronAPI?.maker;
  return maker && typeof maker.getCompanionCloudState === 'function' ? maker : null;
}

function apply(next: CompanionCloudSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function ensureOwner(): void {
  if (isDataOwnerGenerationCurrent(owner)) return;
  owner = getDataOwnerGeneration();
  snapshot = EMPTY_COMPANION_CLOUD_SNAPSHOT;
}

/** Re-reads the snapshot; resolves once the answer is applied (or dropped as superseded), never rejects. */
export function refreshCompanionCloudSettled(): Promise<void> {
  ensureOwner();
  const api = companionCloudApi();
  if (!api) return Promise.resolve();
  const requestOwner = owner;
  const requestPushes = pushes;
  return Promise.resolve().then(() => api.getCompanionCloudState()).then((next) => {
    if (isDataOwnerGenerationCurrent(requestOwner) && pushes === requestPushes && next) apply(next);
  }).catch(() => undefined);
}

export function refreshCompanionCloud(): void {
  void refreshCompanionCloudSettled();
}

function start(): () => void {
  users += 1;
  if (users === 1) {
    const api = companionCloudApi();
    if (api && typeof api.onCompanionCloudChanged === 'function') {
      unsubscribePush = api.onCompanionCloudChanged((next, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp)) return;
        ensureOwner();
        pushes += 1;
        apply(next);
      });
    }
    refreshCompanionCloud();
  }
  return () => {
    users = Math.max(0, users - 1);
    if (users === 0) {
      unsubscribePush?.();
      unsubscribePush = null;
    }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function read(): CompanionCloudSnapshot {
  ensureOwner();
  return snapshot;
}

/** Live companion homes; inert (`enabled: false`) on servers without the feature. */
export function useCompanionCloud(): CompanionCloudSnapshot {
  useEffect(() => start(), []);
  return useSyncExternalStore(subscribe, read, read);
}

/** Latest snapshot outside React (e.g. while waiting for a companion to arrive here). */
export function getCompanionCloudSnapshot(): CompanionCloudSnapshot {
  return read();
}

/** Test-only reset of the module mirror. */
export function resetCompanionCloudStoreForTests(next: CompanionCloudSnapshot = EMPTY_COMPANION_CLOUD_SNAPSHOT): void {
  owner = getDataOwnerGeneration();
  apply(next);
}
