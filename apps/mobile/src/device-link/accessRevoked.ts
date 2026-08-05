import type { Envelope, LinkClosePayload } from '@cindy/device-link';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { evictDeviceProviders } from '@/device-link/deviceProvidersCache';
import { evictDeviceModelMeta } from '@/device-link/deviceModelMetaCache';
import { evictAgentCapabilitiesForDevice } from '@/session/agentCapabilitiesCache';
import { evictComposerPaletteCacheForDevice } from '@/session/composerPaletteCache';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import { clearDeviceResponsivenessTrackingFor } from '@/device-link/unresponsiveDevicesStore';
import { remoteScheduleEventStore } from '@/scheduler/remoteScheduleEvents';
import { invalidateScheduleIndexForDevice } from '@/session/scheduleIndex';
import {
  isAccessRevokedRemoteError,
} from '@cindy/maker-shared/device-link-contract';

export function markDeviceAccessRevoked(deviceId: string): void {
  revokedDevicesStore.markRevoked(deviceId);
  // 撤权优先于熔断(review P1):清掉该设备的 unresponsive 状态,撤权走自己的
  // 专属 UI;后续在途请求的超时也由 settleDeviceSend 按已撤权降级为不定论。
  clearDeviceResponsivenessTrackingFor(deviceId);
  invalidateScheduleIndexForDevice(deviceId);
  remoteScheduleEventStore.clearDevice(deviceId);
  remoteScheduleEventStore.clearDeviceMirrorInvalidation(deviceId);
  remoteSessionStore.removeDevice(deviceId);
  evictDeviceProviders(deviceId);
  evictDeviceModelMeta(deviceId);
  evictAgentCapabilitiesForDevice(deviceId);
  evictComposerPaletteCacheForDevice(deviceId);
}

export function clearDeviceAccessRevoked(deviceId: string): void {
  revokedDevicesStore.clearRevoked(deviceId);
}

export function applyAccessRevokedFrame(env: Envelope): boolean {
  if (env.kind !== 'link-close' || !env.src) return false;
  const payload = env.payload as LinkClosePayload | undefined;
  if (payload?.reason !== 'revoked') return false;
  markDeviceAccessRevoked(env.src);
  return true;
}

export function isAccessRevokedError(err: unknown): boolean {
  return isAccessRevokedRemoteError(err);
}

export async function withAccessRevokedHandling<T>(
  deviceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    clearDeviceAccessRevoked(deviceId);
    return result;
  } catch (err) {
    if (isAccessRevokedError(err)) markDeviceAccessRevoked(deviceId);
    throw err;
  }
}
