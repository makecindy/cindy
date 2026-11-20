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
let hydration: Promise<boolean> | null = null;
// Unacknowledged identity changes survive a failed write. Coalesce snapshots behind
// one in-flight write so the same removal is not replayed after a successful receipt.
let pendingRetirements = new Map<string, { version: number; fence: number | undefined }>();
let pendingRevivals = new Map<string, { version: number; fence: number | undefined }>();
let pendingWrite: CompanionCloudSnapshot | null = null;
let writing: object | null = null;
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

function persist(): void {
  if (writing || !pendingWrite) return;
  const next = pendingWrite;
  pendingWrite = null;
  // A queued deletion predates a newer receipt. Rehydrate and obtain another
  // authoritative roster before assigning it that receipt's revision.
  if ([...pendingRetirements.values()].some(intent => intent.fence !== retirementRevision)) {
    hydratedOwner = '';
    return;
  }
  const requestOwner = owner;
  const flight = writing = {};
  const retirements = [...pendingRetirements];
  // Do not rebase a revival observed before another window's newer deletion.
  for (const [id, intent] of pendingRevivals) if (intent.fence !== retirementRevision) pendingRevivals.delete(id);
  const revivals = [...pendingRevivals];
  void Promise.resolve().then(() => {
    if (!isDataOwnerGenerationCurrent(requestOwner) || writing !== flight) return null;
    return companionCloudApi()?.chatDisplayCache?.({ action: 'write', key: 'cloud-homes', owner: requestOwner,
      value: { ...next, retiredBotIds: [...retiredBotIds], newlyRetiredBotIds: retirements.map(([id]) => id),
        revivedBotIds: revivals.map(([id]) => id), retirementRevision } });
  }).then(value => {
    if (!isDataOwnerGenerationCurrent(requestOwner) || writing !== flight) return;
    const receipt = value as { retiredBotIds?: unknown; retirementRevision?: number } | null;
    retirementRevision = receipt?.retirementRevision;
    // A newer removal/revival of the same identity still needs its own receipt.
    for (const [id, version] of retirements) if (pendingRetirements.get(id) === version) pendingRetirements.delete(id);
    for (const [id, version] of revivals) if (pendingRevivals.get(id) === version) pendingRevivals.delete(id);
    const persisted = receipt?.retiredBotIds;
    if (!Array.isArray(persisted)) return;
    const merged = new Set(persisted.filter((id): id is string => typeof id === 'string'));
    for (const id of pendingRetirements.keys()) merged.add(id);
    for (const id of pendingRevivals.keys()) merged.delete(id);
    const changed = merged.size !== retiredBotIds.size || [...merged].some(id => !retiredBotIds.has(id));
    retiredBotIds = merged;
    if (changed) apply({ ...snapshot, actors: snapshot.actors.filter(actor => !retiredBotIds.has(actor.externalId)) });
  }).catch(() => {
    if (!isDataOwnerGenerationCurrent(requestOwner) || writing !== flight) return;
    // Main can reject an obsolete deletion fence, or disk I/O can fail. Keep
    // the intents, but require a new read + authoritative update before retry.
    hydratedOwner = '';
    pendingWrite = null;
  }).finally(() => {
    if (!isDataOwnerGenerationCurrent(requestOwner) || writing !== flight) return;
    writing = null;
    // Only a newer accepted update queues another attempt; failure alone never spins.
    persist();
  });
}

function accept(next: CompanionCloudSnapshot): void {
  // A process starts with an empty registry before /me and /actors return.
  // That is not an authoritative deletion of the saved companion list.
  if (!next.enabled && !next.humanActorId && snapshot.actors.length) return;
  const revision = ++accepted;
  if (next.enabled) {
    const ids = new Set(next.actors.map(actor => actor.externalId));
    for (const actor of snapshot.actors) if (!ids.has(actor.externalId)) {
      retiredBotIds.add(actor.externalId);
      pendingRetirements.set(actor.externalId, { version: revision, fence: retirementRevision });
      pendingRevivals.delete(actor.externalId);
      void companionCloudApi()?.chatDisplayCache?.({ action: 'remove', key: `companion:${actor.externalId}`, owner }).catch(() => undefined);
    }
    for (const id of ids) {
      const wasRetired = retiredBotIds.delete(id);
      const hadPendingRetirement = pendingRetirements.delete(id);
      if (wasRetired) pendingRevivals.set(id, { version: revision, fence: retirementRevision });
      else if (hadPendingRetirement) pendingRevivals.delete(id);
    }
    for (const id of pendingRetirements.keys()) if (!ids.has(id))
      pendingRetirements.set(id, { version: revision, fence: retirementRevision });
  }
  apply(next);
  if (next.enabled || next.humanActorId) {
    pendingWrite = next;
    persist();
  }
}

function hydrate(): Promise<boolean> {
  const stamp = JSON.stringify(owner);
  if (!owner.dataOwnerId) return Promise.resolve(false);
  if (hydratedOwner === stamp) return Promise.resolve(true);
  if (hydration) return hydration;
  const requestOwner = owner;
  const reading = Promise.resolve().then(() => companionCloudApi()?.chatDisplayCache?.({ action: 'read', key: 'cloud-homes', owner: requestOwner })).then(value => {
    const cached = value as (CompanionCloudSnapshot & { retirementRevision?: number }) | null;
    if (!isDataOwnerGenerationCurrent(requestOwner)) return false;
    hydratedOwner = stamp;
    retirementRevision = cached?.retirementRevision;
    if (!isDataOwnerGenerationCurrent(requestOwner) || snapshot.enabled || snapshot.humanActorId
      || !cached || !Array.isArray(cached.actors) || !Array.isArray(cached.demotedBotIds)
      || !cached.actors.every(actor => actor && typeof actor.id === 'string' && typeof actor.externalId === 'string' && typeof actor.name === 'string')) return true;
    const retired = (cached as CompanionCloudSnapshot & { retiredBotIds?: unknown }).retiredBotIds;
    retiredBotIds = new Set(Array.isArray(retired) ? retired.filter((id): id is string => typeof id === 'string') : []);
    // Another window may have written an older actor list without knowing these deletions.
    apply({ ...cached, actors: cached.actors.filter(actor => !retiredBotIds.has(actor.externalId)) });
    return true;
  }).catch(() => false).finally(() => {
    if (hydration === reading) hydration = null;
  });
  hydration = reading;
  return reading;
}

function ensureOwner(): void {
  if (isDataOwnerGenerationCurrent(owner)) return;
  owner = getDataOwnerGeneration();
  snapshot = EMPTY_COMPANION_CLOUD_SNAPSHOT;
  retiredBotIds = new Set();
  retirementRevision = undefined;
  hydratedOwner = '';
  hydration = null;
  pendingRetirements = new Map();
  pendingRevivals = new Map();
  pendingWrite = null;
  writing = null;
}

/** Re-reads the snapshot; resolves once the answer is applied (or dropped as superseded), never rejects. */
export function refreshCompanionCloudSettled(): Promise<void> {
  ensureOwner();
  const api = companionCloudApi();
  if (!api) return Promise.resolve();
  const hydrated = hydrate();
  const requestOwner = owner;
  const requestPushes = pushes;
  return hydrated.then(ready => {
    if (!ready || !isDataOwnerGenerationCurrent(requestOwner) || pushes !== requestPushes) return null;
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
        void hydrate().then(ready => {
          if (ready && isDataOwnerGenerationCurrent(requestOwner) && pushes === requestPushes) accept(next);
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
  pendingRetirements = new Map();
  pendingRevivals = new Map();
  pendingWrite = null;
  writing = null;
  apply(next);
}
