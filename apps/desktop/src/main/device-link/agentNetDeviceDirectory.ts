import type { DeviceView } from '@cindy/device-link';
import type { DeviceView as AgentNetDeviceView } from '@cindy/agent-net-protocol';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { PROVIDER_METADATA_TRUST_MS } from '@cindy/device-link';
import { isTemporaryProviderMetadataFailure, providerDirectoryGeneration } from './providerMetadataContinuity.js';
import * as runtime from './agentNetRuntime.js';

/** V2 名册里的一台设备,写成旧版设备目录的样子(界面与设备列表共用一套)。 */
export function projectAgentNetDevice(device: AgentNetDeviceView, selfId: string): DeviceView {
  return {
    deviceId: device.certificate.deviceId,
    name: device.name,
    selfName: device.selfName ?? null,
    deviceInfo: null,
    platform: device.platform ?? null,
    app: device.app,
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

/**
 * 响应头**已经表态**的中止不是「连不上」。
 *
 * fetch 层在「响应头已到、正文卡到调用方期限」时会把已知的非 OK 状态贴在中止原因上
 * (`httpStatus`,见 serverApiClient 的 attachAbortMetadata)。这种中止带着权威拒绝:
 * 403 / 404 这类终态必须原样抛给上层,让它恢复状态(403 广播目录失效、404 停掉重读),
 * 不能被「期限到点 = 暂时性失败」的兜底吞掉 —— 吞掉之后一条腿成功就把整次读变成
 * `partial`,上层再也看不到那个状态(Greptile review #9360「已知拒绝被当成超时」)。
 */
function knownRejectionStatus(error: unknown): number | null {
  const status = (error as { httpStatus?: unknown } | null | undefined)?.httpStatus;
  return typeof status === 'number' && Number.isFinite(status) && status >= 400 ? status : null;
}

/** 仅测试:清掉记住的完整目录,避免上一个用例的并集漏进下一个用例。 */
export function __resetDeviceDirectoryUnionForTests(): void {
  lastCompleteDirectory = null;
}

/**
 * 上一次**两条腿都读到**的完整目录。
 *
 * 只有一条腿读到时,那次回答证明不了另一条腿上的设备已经不在了:配对的设备可以关掉
 * V2 只走 V1(反过来也一样),把这份「缺席」当成权威就会把那些设备从目录里抹掉
 * (Codex review #9360「Keep one-leg hybrid results non-authoritative」)。这里留一份
 * 完整目录,部分目录按它把**身份**并回来 —— 在场状态仍以本次读到的为准,这份并集只
 * 保证「不因一条腿卡住就少设备」。
 *
 * 这份并集有三个围栏,外加一个期限:改了名 / 删了设备(目录代次)、换了线路(账号 scope +
 * 中转 / agent-net 选择)、超过 30 分钟 —— 任何一条不满足就不再并集。没有这些围栏,被
 * 删掉的设备会因为每次部分读都续一次 30 分钟预算而一直复活(Codex review #9360
 * 「Fence the remembered union to the active directory」)。
 */
interface RememberedDirectory {
  /** 账号 scope + 当前线路。 */
  key: string;
  /** 目录代次:改名 / 删除设备后作废。 */
  generation: number;
  /** 记住的时刻:超过 30 分钟不再并集。 */
  at: number;
  devices: DeviceView[];
}
let lastCompleteDirectory: RememberedDirectory | null = null;

/** 并集的身份:账号 scope + 当前线路。 */
function unionKey(scope: string, selection: string): string {
  return JSON.stringify([scope, selection]);
}

/** 当前仍然有效的完整目录并集;围栏不满足时连同这份记忆一起丢掉。 */
function rememberedUnion(scope: string, selection: string): { devices: DeviceView[]; until: number } | null {
  const union = lastCompleteDirectory;
  if (!union) return null;
  if (union.key !== unionKey(scope, selection)) return null;
  if (union.generation !== providerDirectoryGeneration()) { lastCompleteDirectory = null; return null; }
  if (Date.now() - union.at > PROVIDER_METADATA_TRUST_MS) { lastCompleteDirectory = null; return null; }
  // 这份并集的可信期限:从上一次**完整**读算起,过了 30 分钟就不再并集。
  return { devices: union.devices, until: union.at + PROVIDER_METADATA_TRUST_MS };
}

/**
 * 只有一条腿读到时的目录:**不能证明缺席**。
 *
 * 返回的行 = 本次读到的那条腿 + 上一次完整目录里的其余行(身份保留);并标成 `partial`,
 * 上层据此不把它当成权威目录(不据此剪枝、不据此清掉限流期限,继续追问缺的那条腿)。
 *
 * `rememberedUntilMs` = 并进来的**旧行**到什么时候为止可信。这份期限要跟着答案一起
 * 往上走:连续性缓存的预算按它算,不能让一次部分成功给旧行续一整份 30 分钟
 * (Greptile review #9360「旧目录被重新计时」)。
 */
function partialDirectory(
  scope: string,
  selection: string,
  devices: DeviceView[],
): { devices: DeviceView[]; partial: true; rememberedUntilMs?: number } {
  const remembered = rememberedUnion(scope, selection);
  if (!remembered || remembered.devices.length === 0) return { devices, partial: true };
  const merged = new Map(remembered.devices.map((device) => [device.deviceId, device]));
  for (const device of devices) {
    const old = merged.get(device.deviceId);
    // 活下来的那条腿说不了另一条路的账:它可能只是因为对端关掉了 V2 才把对方列成离线。
    // 没有当前数据通路的权威证据时,不要用「离线」覆盖「活着」(与完整合并同一道护栏)。
    if (!device.online && old?.online) continue;
    merged.set(device.deviceId, old
      ? { ...old, ...device, deviceInfo: old.deviceInfo ?? device.deviceInfo }
      : device);
  }
  return { devices: [...merged.values()], partial: true, rememberedUntilMs: remembered.until };
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
): Promise<{ devices: DeviceView[]; partial?: boolean; rememberedUntilMs?: number }> {
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
  // A device removed in Device Link stays in the official Agent-Net directory: it is not part of this account until it
  // signs in again there (packages/agent-net/src/membership.ts), so it is not listed from there either. Everyone on a self-hosted relay.
  // Also the rows a partial directory takes from the remembered complete one: a device deleted on another computer since
  // would come back there for up to 30 minutes.
  const withoutRefused = <T extends { devices: DeviceView[] }>(value: T): T =>
    ({ ...value, devices: value.devices.filter(device => device.isSelf || runtime.agentNetDeviceAccepted(device.deviceId)) });
  if (onlyEncrypted) return withoutRefused(await readEncrypted());
  const startedAt = Date.now();
  const [legacy, encrypted] = await Promise.allSettled([readLegacy(), readEncrypted()]);
  assertCurrent();
  // The Device Link list is the account's device list; the Agent-Net entries are judged against it (filtered below).
  if (legacy.status === 'fulfilled') runtime.agentNetNoteDeviceLinkDevices(legacy.value.devices.map(device => ({ deviceId: device.deviceId, platform: device.platform })), startedAt);
  if (encrypted.status === 'fulfilled') encrypted.value.devices = withoutRefused(encrypted.value).devices;
  // Only transient transport failures can use the other live directory. Never
  // hide a membership denial, invalid certificate or account boundary as fallback.
  // 期限到点的中止按**暂时性**失败处理:两条腿里只要有一条读成了,就用那条结果。
  // 但「响应头已表态」的中止例外:它带着权威拒绝(403 / 404 / 429 / 5xx),必须先按
  // 已知状态判断 —— 429 与 5xx 仍是暂时性(服务端明确说了限流 / 故障),其余终态原样
  // 抛给上层,否则上层永远看不到那个状态(目录失效不广播、终态不停重读)
  // (Greptile review #9360「已知拒绝被当成超时」)。
  const legIsTemporary = (reason: unknown): boolean => {
    const known = knownRejectionStatus(reason);
    if (known !== null) return known === 429 || (known >= 500 && known < 600);
    return isTemporaryProviderMetadataFailure(reason) || isDeadlineAbort(reason);
  };
  if (encrypted.status === 'rejected' && !legIsTemporary(encrypted.reason)) throw encrypted.reason;
  if (legacy.status === 'rejected' && !legIsTemporary(legacy.reason)) throw legacy.reason;
  if (encrypted.status === 'rejected') {
    if (legacy.status === 'rejected') throw encrypted.reason;
    return withoutRefused(partialDirectory(scope, selection, legacy.value.devices));
  }
  if (legacy.status === 'rejected') return withoutRefused(partialDirectory(scope, selection, encrypted.value.devices));
  const devices = new Map(legacy.value.devices.map(device => [device.deviceId, device]));
  for (const device of encrypted.value.devices) {
    const old = devices.get(device.deviceId);
    // A paired device can turn V2 off and remain online through V1. An online V2
    // row, including an explicit control-off, is authoritative for its V2 path.
    if (!device.online && old?.online) {
      // Liveness can come from V1 while App identity remains durable V2 metadata.
      if (device.app !== undefined) devices.set(device.deviceId, { ...old, app: device.app });
      continue;
    }
    devices.set(device.deviceId, { ...old, ...device, deviceInfo: old?.deviceInfo ?? device.deviceInfo });
  }
  const complete = { ...legacy.value, devices: [...devices.values()] };
  // 只有两条腿都读到才是**完整**目录:它是下一次部分目录的并集来源。
  lastCompleteDirectory = {
    key: unionKey(scope, selection),
    generation: providerDirectoryGeneration(),
    at: Date.now(),
    devices: complete.devices,
  };
  return complete;
}
