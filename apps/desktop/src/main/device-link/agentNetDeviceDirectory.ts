import type { DeviceView } from '@cindy/device-link';
import type { DeviceView as AgentNetDeviceView } from '@cindy/agent-net-protocol';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { isTemporaryProviderMetadataFailure } from './providerMetadataContinuity.js';
import * as runtime from './agentNetRuntime.js';

/** V2 名册里的一台设备,写成旧版设备目录的样子(界面与设备列表共用一套)。 */
export function projectAgentNetDevice(device: AgentNetDeviceView, selfId: string): DeviceView {
  return {
    deviceId: device.certificate.deviceId,
    name: device.name,
    selfName: device.selfName ?? null,
    deviceInfo: null,
    platform: device.platform ?? null,
    appVersion: device.appVersion ?? null,
    lastSeenAt: typeof device.lastSeenAt === 'number' ? new Date(device.lastSeenAt).toISOString() : null,
    online: device.online,
    busy: device.busy === true,
    remoteControlEnabled: device.remoteControlEnabled,
    isSelf: device.certificate.deviceId === selfId,
  };
}

/** V1 presence cannot describe a peer that has disconnected V1 to use only V2. */
export async function readCurrentDeviceDirectory(
  readLegacy: () => Promise<{ devices: DeviceView[] }>,
  assertRoute: () => void,
  /**
   * 调用方的总期限。它也要管住加密那一腿:加密目录读有自己的 10 秒超时,不带这个
   * signal 的话,调用方到期后这条读还活着,下一次重试会在它还在飞的时候再发一条
   * 物理读(Codex review #9360「Apply the caller deadline to the Agent Net directory read」)。
   */
  signal?: AbortSignal,
): Promise<{ devices: DeviceView[] }> {
  const scope = activeOwnerScopeKey();
  const assertOwner = () => {
    assertRoute();
    if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('DEVICE_LINK_SCOPE_CHANGED');
  };
  assertOwner();
  const selection = runtime.agentNetSelectionKey();
  const assertCurrent = () => {
    assertOwner();
    if (selection !== runtime.agentNetSelectionKey()) throw new Error('DEVICE_LINK_SCOPE_CHANGED');
  };
  const api = runtime.currentAgentNetClient();
  const onlyEncrypted = runtime.agentNetRequiresEncryption();
  if (!api) {
    if (onlyEncrypted) throw new Error('AGENT_NET_ENCRYPTED_IDENTITY_REQUIRED');
    // Preserve the legacy client's own region-aware authentication retry.
    return readLegacy();
  }
  const readEncrypted = async () => {
    const devices = await api.directory(signal);
    assertCurrent();
    // AgentNetClient verifies pinned root, membership, subject and certificates.
    return { devices: devices.map(device => projectAgentNetDevice(device, api.certificate.deviceId)) };
  };
  if (onlyEncrypted) return readEncrypted();
  const [legacy, encrypted] = await Promise.allSettled([readLegacy(), readEncrypted()]);
  assertCurrent();
  // Only transient transport failures can use the other live directory. Never
  // hide a membership denial, invalid certificate or account boundary as fallback.
  if (encrypted.status === 'rejected' && !isTemporaryProviderMetadataFailure(encrypted.reason)) throw encrypted.reason;
  if (legacy.status === 'rejected' && !isTemporaryProviderMetadataFailure(legacy.reason)) throw legacy.reason;
  if (encrypted.status === 'rejected') {
    if (legacy.status === 'rejected') throw encrypted.reason;
    return legacy.value;
  }
  if (legacy.status === 'rejected') return encrypted.value;
  const devices = new Map(legacy.value.devices.map(device => [device.deviceId, device]));
  for (const device of encrypted.value.devices) {
    const old = devices.get(device.deviceId);
    // A paired device can turn V2 off and remain online through V1. An online V2
    // row, including an explicit control-off, is authoritative for its V2 path.
    if (!device.online && old?.online) continue;
    devices.set(device.deviceId, { ...old, ...device, deviceInfo: old?.deviceInfo ?? device.deviceInfo });
  }
  return { ...legacy.value, devices: [...devices.values()] };
}
