import {
  getDataOwnerGeneration,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';

import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../../shared/dataOwnerPush';

/** Last stamped source boundary observed from each controlled device. */
const remoteOwnerStamps = new Map<string, DataOwnerPushStamp>();
/** Devices that have emitted at least one stamped frame in this connection. */
const remoteStampedDevices = new Set<string>();

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
): boolean {
  const current = getDataOwnerGeneration();
  if (current.dataOwnerId === null) return false;
  if (!ownerStampPresent) return !remoteStampedDevices.has(remoteDeviceId);
  if (!isDataOwnerPushStamp(ownerStamp)) return false;

  remoteStampedDevices.add(remoteDeviceId);
  if (ownerStamp.dataOwnerId !== current.dataOwnerId) return false;

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
  push: { deviceId: string; ownerStamp?: unknown },
  localOwnerStamp: unknown,
): boolean {
  if (!isDataOwnerPushCurrent(localOwnerStamp)) return false;
  return isRemoteDataOwnerPushCurrent(
    push.deviceId,
    push.ownerStamp,
    Object.prototype.hasOwnProperty.call(push, 'ownerStamp'),
  );
}

export function resetRemoteDataOwnerPushFence(remoteDeviceId?: string): void {
  if (remoteDeviceId !== undefined) {
    remoteOwnerStamps.delete(remoteDeviceId);
    remoteStampedDevices.delete(remoteDeviceId);
    return;
  }
  remoteOwnerStamps.clear();
  remoteStampedDevices.clear();
}

export const __testing = {
  reset: resetRemoteDataOwnerPushFence,
};
