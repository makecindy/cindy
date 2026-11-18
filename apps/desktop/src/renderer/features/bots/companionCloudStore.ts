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
let accepted = 0;
let hydratedOwner = '';
let hydration: Promise<void> | null = null;
let retiredBotIds = new Set<string>();
let retirementRevision: number | undefined;
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

function accept(next: CompanionCloudSnapshot): void {
  // A process starts with an empty registry before /me and /actors return.
  // That is not an authoritative deletion of the saved companion list.
  if (!next.enabled && !next.humanActorId && snapshot.actors.length) return;
  const revivedBotIds: string[] = [];
  if (next.enabled) {
    const ids = new Set(next.actors.map(actor => actor.externalId));
    for (const actor of snapshot.actors) if (!ids.has(actor.externalId)) {
      retiredBotIds.add(actor.externalId);
      void companionCloudApi()?.chatDisplayCache?.({ action: 'remove', key: `companion:${actor.externalId}`, owner }).catch(() => undefined);
    }
    for (const id of ids) if (retiredBotIds.delete(id)) revivedBotIds.push(id);
  }
  const requestOwner = owner;
  const revision = ++accepted;
  apply(next);
  if (next.enabled || next.humanActorId) {
    void companionCloudApi()?.chatDisplayCache?.({ action: 'write', key: 'cloud-homes', owner,
      value: { ...next, retiredBotIds: [...retiredBotIds], revivedBotIds, retirementRevision } }).then(value => {
        if (!isDataOwnerGenerationCurrent(requestOwner) || accepted !== revision) return;
        // Main may know a deletion this window missed while it had no subscribers.
        const receipt = value as { retiredBotIds?: unknown; retirementRevision?: number } | null;
        retirementRevision = receipt?.retirementRevision;
        const persisted = receipt?.retiredBotIds;
        if (!Array.isArray(persisted)) return;
        let changed = false;
        for (const id of persisted) if (typeof id === 'string' && !retiredBotIds.has(id)) {
          retiredBotIds.add(id);
          changed = true;
        }
        if (changed) apply({ ...snapshot, actors: snapshot.actors.filter(actor => !retiredBotIds.has(actor.externalId)) });
      }).catch(() => undefined);
  }
}

function hydrate(): Promise<void> {
  const stamp = JSON.stringify(owner);
  if (!owner.dataOwnerId || hydratedOwner === stamp) return hydration ?? Promise.resolve();
  hydratedOwner = stamp;
  const requestOwner = owner;
  hydration = Promise.resolve(companionCloudApi()?.chatDisplayCache?.({ action: 'read', key: 'cloud-homes', owner })).then(value => {
    const cached = value as (CompanionCloudSnapshot & { retirementRevision?: number }) | null;
    if (!isDataOwnerGenerationCurrent(requestOwner)) return;
    retirementRevision = cached?.retirementRevision;
    if (!isDataOwnerGenerationCurrent(requestOwner) || snapshot.enabled || snapshot.humanActorId
      || !cached || !Array.isArray(cached.actors) || !Array.isArray(cached.demotedBotIds)
      || !cached.actors.every(actor => actor && typeof actor.id === 'string' && typeof actor.externalId === 'string' && typeof actor.name === 'string')) return;
    const retired = (cached as CompanionCloudSnapshot & { retiredBotIds?: unknown }).retiredBotIds;
    retiredBotIds = new Set(Array.isArray(retired) ? retired.filter((id): id is string => typeof id === 'string') : []);
    // Another window may have written an older actor list without knowing these deletions.
    apply({ ...cached, actors: cached.actors.filter(actor => !retiredBotIds.has(actor.externalId)) });
  }).catch(() => undefined);
  return hydration;
}

function ensureOwner(): void {
  if (isDataOwnerGenerationCurrent(owner)) return;
  owner = getDataOwnerGeneration();
  snapshot = EMPTY_COMPANION_CLOUD_SNAPSHOT;
  retiredBotIds = new Set();
  retirementRevision = undefined;
  hydratedOwner = '';
  hydration = null;
}

/** Re-reads the snapshot; resolves once the answer is applied (or dropped as superseded), never rejects. */
export function refreshCompanionCloudSettled(): Promise<void> {
  ensureOwner();
  const api = companionCloudApi();
  if (!api) return Promise.resolve();
  const hydrated = hydrate();
  const requestOwner = owner;
  const requestPushes = pushes;
  return hydrated.then(() => {
    if (!isDataOwnerGenerationCurrent(requestOwner) || pushes !== requestPushes) return null;
    return api.getCompanionCloudState();
  }).then((next) => {
    if (isDataOwnerGenerationCurrent(requestOwner) && pushes === requestPushes && next) accept(next);
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
        const requestOwner = owner;
        const requestPushes = ++pushes;
        void hydrate().then(() => {
          if (isDataOwnerGenerationCurrent(requestOwner) && pushes === requestPushes) accept(next);
        });
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

/** Removed cloud identities, scoped to the current login; ordinary device-only bots are absent. */
export function getRetiredCompanionBotIds(): ReadonlySet<string> {
  ensureOwner();
  return retiredBotIds;
}

/** Test-only reset of the module mirror. */
export function resetCompanionCloudStoreForTests(next: CompanionCloudSnapshot = EMPTY_COMPANION_CLOUD_SNAPSHOT): void {
  owner = getDataOwnerGeneration();
  hydratedOwner = '';
  hydration = null;
  retiredBotIds = new Set();
  retirementRevision = undefined;
  apply(next);
}
