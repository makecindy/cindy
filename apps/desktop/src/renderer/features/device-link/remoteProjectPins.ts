import { useSyncExternalStore } from 'react';

import {
  parseSyncedProjectOrderOwnerStamp,
  type SyncedProjectOrderOwnerStamp,
} from '@cindy/maker-shared/project-order-sync';
import {
  isProjectPinsChannelMissing,
  parseHostProjectPinsSnapshot,
  PROJECT_PINS_APPLY_CHANNEL,
  PROJECT_PINS_GET_CHANNEL,
  sameHostProjectPinsSnapshot,
  UNAVAILABLE_PROJECT_PINS,
  type HostProjectPinsSnapshot,
} from '@cindy/maker-shared/project-pin-sync';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerIdCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

export type ProjectPinsByDevice = ReadonlyMap<string, HostProjectPinsSnapshot>;

const EMPTY: ProjectPinsByDevice = new Map();
let snapshots: ProjectPinsByDevice = new Map();
const listeners = new Set<() => void>();
let owner: DataOwnerGeneration | null = null;
const ownerStamps = new Map<string, SyncedProjectOrderOwnerStamp>();
// Accepted pushes and write results bump this; a read issued before them is stale.
const liveRevisions = new Map<string, number>();
// Latest read per device; an older in-flight read never overwrites a newer one.
const readTokens = new Map<string, number>();
let nextReadToken = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(next: ProjectPinsByDevice): void {
  snapshots = next;
  notify();
}

function selectOwner(requestOwner: DataOwnerGeneration): void {
  if (owner && isDataOwnerIdCurrent(owner)) return;
  ownerStamps.clear();
  liveRevisions.clear();
  readTokens.clear();
  owner = requestOwner;
  if (snapshots.size > 0) publish(new Map());
}

function acceptOwnerStamp(deviceId: string, raw: unknown): boolean {
  const stamp = parseSyncedProjectOrderOwnerStamp(raw);
  if (!stamp || stamp.dataOwnerId !== owner?.dataOwnerId) return false;
  const previous = ownerStamps.get(deviceId);
  if (previous && stamp.ownerGeneration < previous.ownerGeneration) return false;
  ownerStamps.set(deviceId, stamp);
  return true;
}

function apply(deviceId: string, snapshot: HostProjectPinsSnapshot): void {
  if (sameHostProjectPinsSnapshot(snapshots.get(deviceId), snapshot)) return;
  const next = new Map(snapshots);
  next.set(deviceId, snapshot);
  publish(next);
}

function noteLiveUpdate(deviceId: string): void {
  liveRevisions.set(deviceId, (liveRevisions.get(deviceId) ?? 0) + 1);
}

/**
 * Renderer mirror of each remote desktop's own project pins. The remote-project
 * synchronizer owns eligibility and connection recovery; hosts own persistence.
 */
export const remoteProjectPins = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: (): ProjectPinsByDevice =>
    owner && isDataOwnerIdCurrent(owner) ? snapshots : EMPTY,
  clear(): void {
    owner = null;
    ownerStamps.clear();
    liveRevisions.clear();
    readTokens.clear();
    if (snapshots.size > 0) publish(new Map());
  },
  /** The device is gone (remote control off, revoked or disabled): forget its pins. */
  remove(deviceId: string): void {
    ownerStamps.delete(deviceId);
    liveRevisions.delete(deviceId);
    readTokens.delete(deviceId);
    if (!snapshots.has(deviceId)) return;
    const next = new Map(snapshots);
    next.delete(deviceId);
    publish(next);
  },
  /** The link dropped: keep the last pins on screen, drop reads and the restart-sensitive watermark. */
  suspend(deviceId: string): void {
    ownerStamps.delete(deviceId);
    readTokens.delete(deviceId);
  },
  acceptPush(
    push: { deviceId: string; payload: unknown },
    localOwnerStamp: unknown,
    isEligible: () => boolean,
  ): boolean {
    const requestOwner = getDataOwnerGeneration();
    if (!requestOwner.dataOwnerId || !isEligible() || !isDataOwnerPushCurrent(localOwnerStamp)) {
      return false;
    }
    selectOwner(requestOwner);
    const snapshot = parseHostProjectPinsSnapshot(push.payload);
    if (!snapshot || !acceptOwnerStamp(push.deviceId, snapshot.ownerStamp)) return false;
    noteLiveUpdate(push.deviceId);
    apply(push.deviceId, snapshot);
    return true;
  },
  refresh(deviceId: string, isEligible: () => boolean): Promise<void> {
    const requestOwner = getDataOwnerGeneration();
    if (!requestOwner.dataOwnerId || !isEligible()) return Promise.resolve();
    selectOwner(requestOwner);
    const token = ++nextReadToken;
    readTokens.set(deviceId, token);
    const revision = liveRevisions.get(deviceId) ?? 0;
    const current = () =>
      readTokens.get(deviceId) === token &&
      isEligible() &&
      isDataOwnerGenerationCurrent(requestOwner) &&
      (liveRevisions.get(deviceId) ?? 0) === revision;
    return Promise.resolve()
      .then(() =>
        window.electronAPI.deviceLink.invoke(deviceId, PROJECT_PINS_GET_CHANNEL, [], {
          background: true,
        }),
      )
      .then(
        (raw) => {
          if (!current()) return;
          const snapshot = parseHostProjectPinsSnapshot(raw);
          if (snapshot && acceptOwnerStamp(deviceId, snapshot.ownerStamp)) apply(deviceId, snapshot);
        },
        (error: unknown) => {
          // Only an older host is conclusive. Offline and timeouts keep the last known pins;
          // reconnect and device recovery read again.
          if (current() && isProjectPinsChannelMissing(error)) {
            apply(deviceId, UNAVAILABLE_PROJECT_PINS);
          }
        },
      )
      .finally(() => {
        if (readTokens.get(deviceId) === token) readTokens.delete(deviceId);
      });
  },
  /** Writes host-local keys on the owning desktop. Throws when that desktop cannot accept it. */
  async setPinned(
    deviceId: string,
    projectKeys: readonly string[],
    pinned: boolean,
  ): Promise<HostProjectPinsSnapshot> {
    const requestOwner = getDataOwnerGeneration();
    const known = owner && isDataOwnerIdCurrent(owner) ? snapshots.get(deviceId) : undefined;
    const ownerStamp = known?.ownerStamp;
    if (!requestOwner.dataOwnerId || !known?.available || !ownerStamp) {
      throw new Error('project pins on this device are unavailable');
    }
    let raw: unknown;
    try {
      raw = await window.electronAPI.deviceLink.invoke(deviceId, PROJECT_PINS_APPLY_CHANNEL, [
        { ...ownerStamp, projectKeys: Array.from(projectKeys), pinned },
      ]);
    } catch (error) {
      if (isProjectPinsChannelMissing(error) && isDataOwnerGenerationCurrent(requestOwner)) {
        apply(deviceId, UNAVAILABLE_PROJECT_PINS);
      }
      throw error;
    }
    const snapshot = parseHostProjectPinsSnapshot(raw);
    if (!snapshot) throw new Error('invalid project pins response');
    if (isDataOwnerGenerationCurrent(requestOwner) && acceptOwnerStamp(deviceId, snapshot.ownerStamp)) {
      noteLiveUpdate(deviceId);
      apply(deviceId, snapshot);
    }
    return snapshot;
  },
};

export function useRemoteProjectPins(): ProjectPinsByDevice {
  return useSyncExternalStore(remoteProjectPins.subscribe, remoteProjectPins.getSnapshot);
}
