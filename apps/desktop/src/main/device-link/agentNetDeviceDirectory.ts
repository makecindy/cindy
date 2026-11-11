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

/**
 * 一次**期限**到点的中止不是权威拒绝:调用方的总期限到了,或者这一腿自己的传输超时。
 * 中止错误不带 code / status,`isTemporaryProviderMetadataFailure` 认不出来 —— 于是一条腿
 * 卡到期限会把另一条已经读成的腿一起拖掉:健康的线路在同伴卡住时变得不可用
 * (Codex review #9360「Classify deadline aborts before hybrid fallback」)。
 */
function isDeadlineAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** 仅测试:清掉记住的完整目录,避免上一个用例的并集漏进下一个用例。 */
export function __resetDeviceDirectoryUnionForTests(): void {
  lastCompleteDirectory = null;
}

/**
 * 上一次**两条腿都读到**的完整目录(按 owner scope 记一份)。
 *
 * 只有一条腿读到时,那次回答证明不了另一条腿上的设备已经不在了:配对的设备可以关掉
 * V2 只走 V1(反过来也一样),把这份「缺席」当成权威就会把那些设备从目录里抹掉
 * (Codex review #9360「Keep one-leg hybrid results non-authoritative」)。这里留一份
 * 完整目录,部分目录按它把**身份**并回来 —— 在场状态仍以本次读到的为准,这份并集只
 * 保证「不因一条腿卡住就少设备」。
 */
let lastCompleteDirectory: { scope: string; devices: DeviceView[] } | null = null;

/**
 * 只有一条腿读到时的目录:**不能证明缺席**。
 *
 * 返回的行 = 本次读到的那条腿 + 上一次完整目录里的其余行(身份保留);并标成 `partial`,
 * 上层据此不把它当成权威目录(不据此剪枝、不据此清掉限流期限,继续追问缺的那条腿)。
 */
function partialDirectory(scope: string, devices: DeviceView[]): { devices: DeviceView[]; partial: true } {
  const remembered = lastCompleteDirectory?.scope === scope ? lastCompleteDirectory.devices : [];
  if (remembered.length === 0) return { devices, partial: true };
  const merged = new Map(remembered.map((device) => [device.deviceId, device]));
  for (const device of devices) {
    const old = merged.get(device.deviceId);
    merged.set(device.deviceId, old
      ? { ...old, ...device, deviceInfo: old.deviceInfo ?? device.deviceInfo }
      : device);
  }
  return { devices: [...merged.values()], partial: true };
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
): Promise<{ devices: DeviceView[]; partial?: boolean }> {
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
  // 期限到点的中止按**暂时性**失败处理:两条腿里只要有一条读成了,就用那条结果。
  const legIsTemporary = (reason: unknown): boolean =>
    isTemporaryProviderMetadataFailure(reason) || isDeadlineAbort(reason);
  if (encrypted.status === 'rejected' && !legIsTemporary(encrypted.reason)) throw encrypted.reason;
  if (legacy.status === 'rejected' && !legIsTemporary(legacy.reason)) throw legacy.reason;
  if (encrypted.status === 'rejected') {
    if (legacy.status === 'rejected') throw encrypted.reason;
    return partialDirectory(scope, legacy.value.devices);
  }
  if (legacy.status === 'rejected') return partialDirectory(scope, encrypted.value.devices);
  const devices = new Map(legacy.value.devices.map(device => [device.deviceId, device]));
  for (const device of encrypted.value.devices) {
    const old = devices.get(device.deviceId);
    // A paired device can turn V2 off and remain online through V1. An online V2
    // row, including an explicit control-off, is authoritative for its V2 path.
    if (!device.online && old?.online) continue;
    devices.set(device.deviceId, { ...old, ...device, deviceInfo: old?.deviceInfo ?? device.deviceInfo });
  }
  const complete = { ...legacy.value, devices: [...devices.values()] };
  // 只有两条腿都读到才是**完整**目录:它是下一次部分目录的并集来源。
  lastCompleteDirectory = { scope, devices: complete.devices };
  return complete;
}
