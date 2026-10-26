import { useSyncExternalStore } from 'react';
import {
  createProjectAliasMirror,
  type HostProjectAliasesSnapshot,
  type ProjectAliasesByDevice,
} from '@cindy/maker-shared/project-alias-sync';
import {
  parseSyncedProjectOrderOwnerStamp,
  type SyncedProjectOrderOwnerStamp,
} from '@cindy/maker-shared/project-order-sync';

const mirror = createProjectAliasMirror();
let account: { ownerId: string | null; generation: number } = { ownerId: null, generation: -1 };
const ownerStamps = new Map<string, SyncedProjectOrderOwnerStamp>();
const knownDevices = new Set<string>();
const deviceGenerations = new Map<string, number>();

/** Account changes invalidate both the visible map and every outstanding read. */
export function setRemoteProjectAliasesAccount(ownerId: string | null, generation: number): void {
  if (account.ownerId === ownerId && account.generation === generation) return;
  account = { ownerId, generation };
  ownerStamps.clear();
  knownDevices.clear();
  deviceGenerations.clear();
  mirror.clear();
}

export function useRemoteProjectAliases(): ProjectAliasesByDevice {
  return useSyncExternalStore(mirror.subscribe, mirror.getSnapshot, mirror.getSnapshot);
}

export function refreshRemoteProjectAliases(
  deviceId: string,
  read: () => Promise<unknown>,
  isCurrent: () => boolean = () => true,
  invalidated = false,
): Promise<void> {
  const scope = account;
  if (scope.ownerId === null || !isCurrent()) return Promise.resolve();
  knownDevices.add(deviceId);
  const deviceGeneration = deviceGenerations.get(deviceId) ?? 0;
  const current = (snapshot?: HostProjectAliasesSnapshot): boolean => {
    if (account !== scope || (deviceGenerations.get(deviceId) ?? 0) !== deviceGeneration || !isCurrent()) return false;
    const stamp = snapshot?.ownerStamp;
    const previous = ownerStamps.get(deviceId);
    if (snapshot && !stamp) return false;
    if (stamp && (stamp.dataOwnerId !== scope.ownerId
      || (previous && stamp.ownerGeneration < previous.ownerGeneration))) return false;
    // Only an accepted response advances the watermark. A failed reconnect read
    // may retain an old visible snapshot, which is not evidence for this connection.
    if (stamp) ownerStamps.set(deviceId, stamp);
    return true;
  };
  const guardedRead = async () => {
    if (!current()) throw new Error('Project alias read superseded');
    return read();
  };
  return (invalidated ? mirror.invalidate : mirror.refresh)(deviceId, guardedRead, current)
    .catch(() => undefined); // Optional display metadata never fails task-list recovery.
}

/** New alias notifications are always owner-stamped; old hosts have no such channel. */
export function acceptRemoteProjectAliasesChanged(
  deviceId: string,
  ownerStamp: unknown,
  isCurrent: () => boolean = () => true,
): boolean {
  if (!isCurrent()) return false;
  const incoming = parseSyncedProjectOrderOwnerStamp(ownerStamp);
  if (!incoming || account.ownerId === null || incoming.dataOwnerId !== account.ownerId) return false;
  const previous = ownerStamps.get(deviceId);
  if (previous && incoming.ownerGeneration < previous.ownerGeneration) return false;
  ownerStamps.set(deviceId, incoming);
  return true;
}

/** Disconnects fence late reads but retain same-account, last-known display names. */
export function suspendRemoteProjectAliases(deviceId?: string): void {
  if (deviceId) {
    ownerStamps.delete(deviceId);
    deviceGenerations.set(deviceId, (deviceGenerations.get(deviceId) ?? 0) + 1);
    mirror.suspend(deviceId);
  } else {
    ownerStamps.clear();
    for (const id of knownDevices) {
      deviceGenerations.set(id, (deviceGenerations.get(id) ?? 0) + 1);
      mirror.suspend(id);
    }
  }
}

/** The caller supplies only topics whose last owner was released. Other owners keep the read alive. */
export function suspendRemoteProjectAliasesForReleasedTopics(deviceId: string, topics: readonly string[]): void {
  if (topics.includes('sessions')) suspendRemoteProjectAliases(deviceId);
}

export function removeRemoteProjectAliases(deviceId: string): void {
  ownerStamps.delete(deviceId);
  knownDevices.delete(deviceId);
  deviceGenerations.set(deviceId, (deviceGenerations.get(deviceId) ?? 0) + 1);
  mirror.remove(deviceId);
}

export const remoteProjectAliasesSnapshot = mirror.getSnapshot;
