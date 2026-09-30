import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { parseSharedTaskPeer } from '@cindy/device-link';

import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../../shared/dataOwnerPush';

/** Last stamped source boundary observed from each controlled device. */
const remoteOwnerStamps = new Map<string, DataOwnerPushStamp>();
/** Devices that have emitted at least one stamped frame in this connection. */
const remoteStampedDevices = new Set<string>();
const sharedTaskOwners = new Map<string, { owner: DataOwnerGeneration; hostAccountId: string }>();
/** Main's verified host-stream epochs; independent of either account generation. */
const sharedHostSourceEpochs = new Map<string, number>();

/** Only call with a current authenticated sharedTask list/detail response, before linking. */
export function bindSharedTaskPushOwner(peer: string, hostAccountId: string): void {
  if (parseSharedTaskPeer(peer)?.role !== 'host' || !hostAccountId) return;
  const owner = getDataOwnerGeneration();
  if (!owner.dataOwnerId) return;
  const previous = sharedTaskOwners.get(peer);
  if (previous && isDataOwnerGenerationCurrent(previous.owner) && previous.hostAccountId !== hostAccountId) return;
  sharedTaskOwners.set(peer, { owner, hostAccountId });
}

/**
 * Validate a controlled-device push against the renderer's current account.
 *
 * Owner generations are local to each controlled process, so they must only
 * be compared with earlier generations from the same remote device. Legacy
 * unstamped frames remain compatible until that device proves stamp support.
 */
export function isRemoteDataOwnerPushCurrent(
  remoteDeviceId: string,
  ownerStamp: unknown,
  ownerStampPresent = ownerStamp !== undefined,
  sourceEpoch?: number,
): boolean {
  const current = getDataOwnerGeneration();
  if (current.dataOwnerId === null) return false;
  const sharedTaskPeer = parseSharedTaskPeer(remoteDeviceId);
  const sharedOwner = sharedTaskPeer ? sharedTaskOwners.get(remoteDeviceId) : undefined;
  if (sharedTaskPeer && (sharedTaskPeer.role !== 'host' || !sharedOwner ||
      !isDataOwnerGenerationCurrent(sharedOwner.owner) || !ownerStampPresent)) return false;
  if (!ownerStampPresent) return !remoteStampedDevices.has(remoteDeviceId);
  if (!isDataOwnerPushStamp(ownerStamp)) return false;

  remoteStampedDevices.add(remoteDeviceId);
  if (ownerStamp.dataOwnerId !== (sharedOwner?.hostAccountId ?? current.dataOwnerId)) return false;
  if (sharedTaskPeer && sourceEpoch !== undefined) {
    if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch < 1) return false;
    const previousEpoch = sharedHostSourceEpochs.get(remoteDeviceId);
    if (previousEpoch !== undefined && sourceEpoch < previousEpoch) return false;
    if (previousEpoch !== sourceEpoch) {
      // The host restarted. Keep the authenticated membership binding while
      // dropping only the old process's generation watermark.
      remoteOwnerStamps.delete(remoteDeviceId);
      sharedHostSourceEpochs.set(remoteDeviceId, sourceEpoch);
    }
  } else if (sharedTaskPeer && sharedHostSourceEpochs.has(remoteDeviceId)) return false;

  const previous = remoteOwnerStamps.get(remoteDeviceId);
  if (
    previous &&
    previous.dataOwnerId === ownerStamp.dataOwnerId &&
    ownerStamp.ownerGeneration < previous.ownerGeneration
  ) {
    return false;
  }

  remoteOwnerStamps.set(remoteDeviceId, ownerStamp);
  return true;
}

/** Validate both the controller's local owner boundary and the controlled device's source owner. */
export function isDeviceLinkRemotePushCurrent(
  push: { deviceId: string; ownerStamp?: unknown; sourceEpoch?: number },
  localOwnerStamp: unknown,
): boolean {
  if (!isDataOwnerPushCurrent(localOwnerStamp)) return false;
  return isRemoteDataOwnerPushCurrent(
    push.deviceId,
    push.ownerStamp,
    Object.prototype.hasOwnProperty.call(push, 'ownerStamp'),
    push.sourceEpoch,
  );
}

export function resetRemoteDataOwnerPushFence(remoteDeviceId?: string): void {
  if (remoteDeviceId !== undefined) {
    sharedTaskOwners.delete(remoteDeviceId);
    sharedHostSourceEpochs.delete(remoteDeviceId);
    remoteOwnerStamps.delete(remoteDeviceId);
    remoteStampedDevices.delete(remoteDeviceId);
    return;
  }
  remoteOwnerStamps.clear();
  remoteStampedDevices.clear();
  sharedTaskOwners.clear();
  sharedHostSourceEpochs.clear();
}

export const __testing = {
  reset: resetRemoteDataOwnerPushFence,
};
