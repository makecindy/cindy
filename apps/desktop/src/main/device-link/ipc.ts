/**
 * device-link 的 IPC handler 注册。
 *
 * handler 业务体抽成可注入依赖的纯函数(规则:main 业务逻辑默认带测试,
 * ipcMain.handle 只做 adapter),__tests__ 用内存 harness 直接调 handler body。
 */

import { ipcMain } from 'electron';
import {
  DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
  DeviceLinkError,
  type InvokeResultPayload,
  type LinkAcceptPayload,
} from '@cindy/device-link';
import { serverApiFetch, ServerApiError } from '../serverApiClient';
import { throwIpcError } from '../utils/ipcValidate';
import type { IpcErrorCode } from '../../shared/ipc-errors';
import {
  DEVICE_LINK_INVOKE,
  DEVICE_LINK_PUSH,
  type DeviceLinkDeviceView,
  type DeviceLinkState,
} from '../../shared/deviceLinkIpc';
import {
  getDeviceLinkStatus,
  getDeviceLinkConnectionIssue,
  setRemoteControlEnabled,
  setKeepAwakeEnabled,
  openRemoteLink,
  closeRemoteLink,
  remoteInvoke,
  remoteSubscribe,
  remoteUnsubscribe,
  disconnectAllControllers,
  revokeController,
  restoreController,
  broadcast,
  deviceLinkApiBase,
} from './index';
import { getActiveControllers } from './dispatch';
import { rewriteOutboundMedia } from './outboundMedia';
import {
  outboundSessionReferencesRequested,
  rewriteOutboundSessionReferences,
} from './outboundSessionReferences';
import {
  isPlaceholderDeviceName,
  readDeviceLinkSettings,
  readLastKnownDeviceNames,
  rememberLastKnownDeviceName,
  setDeviceControlEnabled,
} from './settings-store';
import {
  recordSubscribe,
  recordUnsubscribe,
  recordWindowGone,
  resetDevice as resetSubscriptionRefcountForDevice,
  resetAll as resetSubscriptionRefcount,
} from './subscriptionRefcount';
import { createLogger } from '../logger';
import { getAppCapabilities } from '../appCapabilities.js';

const log = createLogger('device-link:ipc');

function requireDeviceLinkCapability(): void {
  if (!getAppCapabilities().canUseDeviceLink) {
    throwIpcError('PERMISSION_DENIED', 'Device Link requires a Cindy account.');
  }
}

type DeviceLinkServerDeviceView = Omit<DeviceLinkDeviceView, 'controlEnabled'> & {
  controlEnabled?: boolean;
};

/** handler 依赖注入面(测试替身用) */
export interface DeviceLinkIpcDeps {
  getState(): DeviceLinkState;
  setEnabled(enabled: boolean): Promise<void>;
  setKeepAwake(enabled: boolean): Promise<void>;
  apiFetch<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T>;
  openLink(deviceId: string): Promise<LinkAcceptPayload>;
  closeLink(deviceId: string): void;
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
  subscribe(deviceId: string, topics: string[]): Promise<InvokeResultPayload>;
  unsubscribe(deviceId: string, topics: string[]): Promise<InvokeResultPayload>;
  disconnectAll(): void;
  revoke(deviceId: string): Promise<void>;
  restore(deviceId: string): Promise<void>;
  setDeviceControlEnabled(deviceId: string, enabled: boolean): Promise<string[]>;
  broadcast(channel: string, payload: unknown): void;
  readLastKnownDeviceNames(): Record<string, string>;
  rememberLastKnownDeviceName(deviceId: string, name: string): Promise<boolean>;
  /**
   * 出方向附件改写:把消息里的本机附件上传 OSS、替换成引用串(仅 send/steer/enqueue 生效)。
   * 可选 —— 测试可不注入(跳过改写,行为同旧版纯透传)。
   */
  rewriteOutboundMedia?(channel: string, args: unknown[]): Promise<unknown[]>;
  /** 控制端 main 在越过 device-link 前把相对引用解析为可信、预算化快照。 */
  rewriteOutboundSessionReferences?(channel: string, args: unknown[]): Promise<unknown[]>;
}

export function defaultDeps(): DeviceLinkIpcDeps {
  return {
    getState: () => {
      const s = readDeviceLinkSettings();
      return {
        remoteControlEnabled: s.remoteControlEnabled,
        keepAwake: s.keepAwake,
        linkStatus: getDeviceLinkStatus(),
        connectionIssue: getDeviceLinkConnectionIssue(),
        controlledBy: getActiveControllers(),
        revokedControllers: s.revokedControllers,
        disabledControlDeviceIds: s.disabledControlDeviceIds,
      };
    },
    setEnabled: setRemoteControlEnabled,
    setKeepAwake: setKeepAwakeEnabled,
    apiFetch: (path, opts) =>
      serverApiFetch(path, { ...opts, baseUrl: deviceLinkApiBase }),
    openLink: openRemoteLink,
    closeLink: closeRemoteLink,
    invoke: (...args) => {
      requireDeviceLinkCapability();
      return remoteInvoke(...args);
    },
    subscribe: remoteSubscribe,
    unsubscribe: remoteUnsubscribe,
    disconnectAll: disconnectAllControllers,
    revoke: revokeController,
    restore: restoreController,
    setDeviceControlEnabled,
    broadcast,
    readLastKnownDeviceNames,
    rememberLastKnownDeviceName,
    rewriteOutboundMedia,
    rewriteOutboundSessionReferences,
  };
}

/** DeviceLinkError.code → IpcErrorCode 映射(控制端隧道错误统一编码给 renderer) */
const DEVICE_LINK_CODE_MAP: Record<string, IpcErrorCode> = {
  DEVICE_OFFLINE: 'DEVICE_LINK_DEVICE_OFFLINE',
  REMOTE_DISABLED: 'DEVICE_LINK_REMOTE_DISABLED',
  CHANNEL_NOT_ALLOWED: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
  ACCESS_REVOKED: 'DEVICE_LINK_ACCESS_REVOKED',
  INVOKE_TIMEOUT: 'DEVICE_LINK_TIMEOUT',
  VERSION_MISMATCH: 'DEVICE_LINK_VERSION_MISMATCH',
  NOT_CONNECTED: 'DEVICE_LINK_NOT_CONNECTED',
  LINK_NOT_OPEN: 'DEVICE_LINK_NOT_CONNECTED',
};

/**
 * unsubscribe 失败后是否应**恢复引用重试**。判据是「失败后远端订阅是否仍存活」:
 *  - 仅当链路仍在、只是这一帧 unsubscribe 丢了/超时(INVOKE_TIMEOUT)→ 远端订阅还在 → 恢复,让
 *    后续 unsubscribe / 窗口销毁重试把它清掉。
 *  - 其它失败(NOT_CONNECTED / LINK_NOT_OPEN / DEVICE_OFFLINE 链路断;ACCESS_REVOKED / REMOTE_DISABLED
 *    被控端已 clearController 清掉本控制端订阅表;CHANNEL_NOT_ALLOWED 老被控端根本不支持该 channel)→
 *    远端无存活订阅可清 → **不恢复**:恢复只会留下永不释放的 phantom ref(阻断别窗口的真实退订 →
 *    被控端对已无 UI 订阅者的 topic 持续推送)。
 * 注:抛出的 DeviceLinkError 只覆盖链路/超时类码;ACCESS_REVOKED / REMOTE_DISABLED 等终态走的是
 * `!result.ok` 结果分支(那里一律不恢复),故本函数只需放行 INVOKE_TIMEOUT。
 */
function isRetryableUnsubscribeError(err: unknown): boolean {
  return err instanceof DeviceLinkError && err.code === 'INVOKE_TIMEOUT';
}

function rethrowDeviceLinkError(err: unknown): never {
  if (err instanceof DeviceLinkError) {
    throwIpcError(DEVICE_LINK_CODE_MAP[err.code] ?? 'INTERNAL', err.message);
  }
  // openRemoteLink / remoteInvoke 在 client 未初始化时抛 `[CODE] message` 形态的普通 Error,
  // 其 code 已是 IpcErrorCode,直接透传给 renderer 解码
  throw err;
}

/** ServerApiError → throwIpcError 映射(REST 管理面共用) */
function rethrowServerError(err: unknown): never {
  if (err instanceof ServerApiError) {
    if (err.statusCode === 503) {
      throwIpcError('DEVICE_LINK_UNAVAILABLE', err.message);
    }
    if (err.statusCode === 404) {
      throwIpcError('NOT_FOUND', err.message);
    }
    if (err.statusCode === 409) {
      throwIpcError('ALREADY_EXISTS', err.message);
    }
    if (err.statusCode === 400) {
      throwIpcError('INVALID_PARAMS', err.message);
    }
    if (err.statusCode === 0) {
      throwIpcError('DEVICE_LINK_UNAVAILABLE', '无法连接服务器');
    }
  }
  throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
}

// ─── handler bodies(纯函数,可注入依赖)──────────────────────────────────────

export function handleGetState(deps: DeviceLinkIpcDeps): DeviceLinkState {
  const state = deps.getState();
  if (getAppCapabilities().canUseDeviceLink) return state;

  // Keep the local, account-free setting available to Settings while hiding
  // account-scoped Device Link state from signed-out/local sessions.
  return {
    remoteControlEnabled: false,
    keepAwake: state.keepAwake,
    linkStatus: 'stopped',
    connectionIssue: null,
    controlledBy: [],
    revokedControllers: [],
    disabledControlDeviceIds: [],
  };
}

export async function handleSetEnabled(
  deps: DeviceLinkIpcDeps,
  enabled: unknown,
): Promise<{ remoteControlEnabled: boolean }> {
  if (typeof enabled !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
  }
  await deps.setEnabled(enabled);
  return { remoteControlEnabled: enabled };
}

export async function handleSetKeepAwake(
  deps: DeviceLinkIpcDeps,
  enabled: unknown,
): Promise<{ keepAwake: boolean }> {
  if (typeof enabled !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
  }
  await deps.setKeepAwake(enabled);
  return { keepAwake: enabled };
}

export async function handleSetDeviceControlEnabled(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
  enabled: unknown,
): Promise<{ deviceId: string; enabled: boolean; disabledControlDeviceIds: string[] }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  if (typeof enabled !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
  }
  const normalizedDeviceId = deviceId.trim();
  const disabledControlDeviceIds = await deps.setDeviceControlEnabled(normalizedDeviceId, enabled);
  if (!enabled) {
    resetSubscriptionRefcountForDevice(normalizedDeviceId);
    deps.closeLink(normalizedDeviceId);
  }
  deps.broadcast(DEVICE_LINK_PUSH.CONTROL_TARGET_CHANGED, {
    deviceId: normalizedDeviceId,
    enabled,
    disabledControlDeviceIds,
  });
  return { deviceId: normalizedDeviceId, enabled, disabledControlDeviceIds };
}

export async function handleListDevices(
  deps: DeviceLinkIpcDeps,
): Promise<{ devices: DeviceLinkDeviceView[] }> {
  try {
    const result = await deps.apiFetch<{ devices: DeviceLinkServerDeviceView[] }>(
      '/api/device-link/devices',
    );
    return reconcileDeviceNames(result, deps);
  } catch (err) {
    rethrowServerError(err);
  }
}

function reconcileDeviceNames(
  result: { devices: DeviceLinkServerDeviceView[] },
  deps: Pick<
    DeviceLinkIpcDeps,
    'getState' | 'readLastKnownDeviceNames' | 'rememberLastKnownDeviceName'
  >,
): { devices: DeviceLinkDeviceView[] } {
  const cachedNames = deps.readLastKnownDeviceNames();
  const disabledControlDeviceIds = new Set(deps.getState().disabledControlDeviceIds ?? []);

  const devices = result.devices.map<DeviceLinkDeviceView>((device) => {
    let name = device.name;
    const trimmedName = device.name.trim();
    const hasDisplayName = !!trimmedName && !isPlaceholderDeviceName(trimmedName);
    if (hasDisplayName) {
      void deps.rememberLastKnownDeviceName(device.deviceId, trimmedName); // best-effort,不阻塞列表返回
      if (device.name !== trimmedName) {
        name = trimmedName;
      }
    } else if (cachedNames[device.deviceId]) {
      name = cachedNames[device.deviceId];
    }

    const controlEnabled = !disabledControlDeviceIds.has(device.deviceId);
    return { ...device, name, controlEnabled };
  });

  return { devices };
}

function assertControlTargetEnabled(deps: Pick<DeviceLinkIpcDeps, 'getState'>, deviceId: string): void {
  if (deps.getState().disabledControlDeviceIds?.includes(deviceId)) {
    throwIpcError('DEVICE_LINK_CONTROL_DISABLED', 'device control is disabled locally');
  }
}

export async function handleRenameDevice(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
  name: unknown,
): Promise<{ deviceId: string; name: string; manualName?: string | null }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  let nextName: string | null;
  if (name === null) {
    nextName = null;
  } else if (typeof name === 'string' && name.trim()) {
    nextName = name.trim();
  } else {
    throwIpcError('INVALID_PARAMS', 'name is required');
  }
  try {
    return await deps.apiFetch<{ deviceId: string; name: string; manualName?: string | null }>(
      `/api/device-link/devices/${encodeURIComponent(deviceId)}`,
      { method: 'PATCH', body: { name: nextName } },
    );
  } catch (err) {
    rethrowServerError(err);
  }
}

export async function handleDeleteDevice(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
): Promise<{ deviceId: string; deleted: boolean }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  try {
    return await deps.apiFetch<{ deviceId: string; deleted: boolean }>(
      `/api/device-link/devices/${encodeURIComponent(deviceId)}`,
      { method: 'DELETE' },
    );
  } catch (err) {
    rethrowServerError(err);
  }
}

// ─── 控制端 handler bodies ────────────────────────────────────────────────────

export async function handleOpenLink(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
): Promise<LinkAcceptPayload> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  const normalizedDeviceId = deviceId.trim();
  assertControlTargetEnabled(deps, normalizedDeviceId);
  try {
    return await deps.openLink(normalizedDeviceId);
  } catch (err) {
    rethrowDeviceLinkError(err);
  }
}

export function handleCloseLink(deps: DeviceLinkIpcDeps, deviceId: unknown): { ok: true } {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  deps.closeLink(deviceId);
  return { ok: true };
}

export function handleDisconnectAll(deps: DeviceLinkIpcDeps): { ok: true } {
  deps.disconnectAll();
  return { ok: true };
}

export async function handleRevoke(deps: DeviceLinkIpcDeps, deviceId: unknown): Promise<{ ok: true }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  await deps.revoke(deviceId);
  return { ok: true };
}

export async function handleRestore(deps: DeviceLinkIpcDeps, deviceId: unknown): Promise<{ ok: true }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  await deps.restore(deviceId);
  return { ok: true };
}

/**
 * 远程 invoke:把 InvokeResultPayload 展开成「resolve 值」或「throwIpcError」,
 * 让控制端 renderer 调用方拿到的语义跟调本地 IPC 完全一致
 * (成功直接拿 result;失败 catch 到带 code 的 Error)。
 */
export async function handleInvoke(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
  channel: unknown,
  args: unknown,
): Promise<unknown> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  const normalizedDeviceId = deviceId.trim();
  assertControlTargetEnabled(deps, normalizedDeviceId);
  if (typeof channel !== 'string' || !channel.trim()) {
    throwIpcError('INVALID_PARAMS', 'channel is required');
  }
  let callArgs = Array.isArray(args) ? args : [];

  if (outboundSessionReferencesRequested(channel, callArgs)) {
    let capability: InvokeResultPayload;
    try {
      capability = await deps.invoke(
        normalizedDeviceId,
        DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
        [],
      );
    } catch (err) {
      rethrowDeviceLinkError(err);
    }
    if (!capability.ok) {
      if (capability.error.code === 'CHANNEL_NOT_ALLOWED') {
        throwIpcError(
          'SESSION_REFERENCE_UNSUPPORTED',
          '目标设备版本不支持会话引用，请升级目标设备后重试',
        );
      }
      if (capability.error.code === 'IPC_ERROR') {
        throwIpcError(
          'SESSION_REFERENCE_UNAVAILABLE',
          '目标设备仍在启动，会话引用暂不可用，请稍后重试',
        );
      }
      throwIpcError(
        DEVICE_LINK_CODE_MAP[capability.error.code] ?? 'INTERNAL',
        capability.error.message,
      );
    }
    const capabilityVersion =
      capability.result &&
      typeof capability.result === 'object' &&
      !Array.isArray(capability.result)
        ? (capability.result as { version?: unknown }).version
        : undefined;
    if (
      !capability.result ||
      typeof capability.result !== 'object' ||
      Array.isArray(capability.result) ||
      (capability.result as { supported?: unknown }).supported !== true ||
      typeof capabilityVersion !== 'number' ||
      !Number.isFinite(capabilityVersion) ||
      capabilityVersion < 1
    ) {
      throwIpcError(
        'SESSION_REFERENCE_UNSUPPORTED',
        '目标设备版本不支持会话引用，请升级目标设备后重试',
      );
    }
  }

  // 会话引用必须在控制端坐标系解析；放在附件上传前，引用失败时不产生无用 OSS 写入。
  if (deps.rewriteOutboundSessionReferences) {
    try {
      callArgs = await deps.rewriteOutboundSessionReferences(channel, callArgs);
    } catch (err) {
      throwIpcError(
        'SESSION_REFERENCE_UNAVAILABLE',
        err instanceof Error ? err.message : String(err),
      );
    }
    assertControlTargetEnabled(deps, normalizedDeviceId);
  }

  // 出方向附件:发往远程前先把本机附件上传 OSS、替换成引用串(bytes 不内联进 relay)。
  // 上传失败 → MEDIA_TRANSFER_FAILED,整条消息不发(产品决策:不静默丢附件)。
  if (deps.rewriteOutboundMedia) {
    try {
      callArgs = await deps.rewriteOutboundMedia(channel, callArgs);
    } catch (err) {
      throwIpcError(
        'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
    assertControlTargetEnabled(deps, normalizedDeviceId);
  }

  let result: InvokeResultPayload;
  try {
    result = await deps.invoke(normalizedDeviceId, channel, callArgs);
  } catch (err) {
    rethrowDeviceLinkError(err);
  }

  if (result.ok) return result.result;
  // 被控端透传回来的错误:IPC_ERROR 的 message 已是 `[CODE] message` 形态,
  // 直接抛原样 Error 让 renderer extractIpcError 解码;其余隧道码走映射
  if (result.error.code === 'IPC_ERROR') {
    throw new Error(result.error.message);
  }
  throwIpcError(
    DEVICE_LINK_CODE_MAP[result.error.code] ?? 'INTERNAL',
    result.error.message,
  );
}

/** subscribe/unsubscribe 共用:校验 + 解包 invoke-result(失败按隧道错误码抛给 renderer)。 */
function normalizeTopics(topics: unknown): string[] {
  return Array.isArray(topics) ? topics.filter((t): t is string => typeof t === 'string') : [];
}

function unwrapSubscribeResult(result: InvokeResultPayload): { ok: true } {
  if (result.ok) return { ok: true };
  // 老被控端不识别 device-link:subscribe → CHANNEL_NOT_ALLOWED;控制端据此回退 poll(Phase 6)。
  if (result.error.code === 'IPC_ERROR') throw new Error(result.error.message);
  throwIpcError(DEVICE_LINK_CODE_MAP[result.error.code] ?? 'INTERNAL', result.error.message);
}

/**
 * 控制端:订阅被控端某 topic 的变更推送。topics 必填(空列表无意义)。
 * windowId = 发起窗口 WebContents.id;subscribe **总是转发**(幂等),只额外记一笔引用计数,
 * 供 unsubscribe / 窗口销毁时判断「是否还有其它窗口在用」(见 subscriptionRefcount)。
 */
export async function handleSubscribe(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
  topics: unknown,
  windowId: number,
): Promise<{ ok: true }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  const normalizedDeviceId = deviceId.trim();
  assertControlTargetEnabled(deps, normalizedDeviceId);
  const topicList = normalizeTopics(topics);
  if (topicList.length === 0) {
    throwIpcError('INVALID_PARAMS', 'topics is required');
  }
  // 先同步记引用(在 await deps.subscribe **之前**):这样 await 期间并发的 unsubscribe
  // (同 windowId 快速切会话 / 关订阅)能看到本窗口的 ref 并正确降计数。否则会有 TOCTOU——
  // unsubscribe 先跑见不到 ref → no-op,subscribe 回来后才记下一个**永不被释放的 phantom ref**
  // (后续其它窗口对同 (deviceId, topic) 的 unsubscribe 因计数非零而不向 relay 转发 → 被控端
  // 持续推送 → 推送泄漏,直到窗口销毁)。
  recordSubscribe(windowId, normalizedDeviceId, topicList);
  let result: InvokeResultPayload;
  try {
    result = await deps.subscribe(normalizedDeviceId, topicList);
  } catch (err) {
    // 订阅失败 → 撤掉刚记的本窗口 ref(满足「失败不留 ref」);并发 unsubscribe 已移除则为幂等
    // no-op。失败时本就没订上,忽略 recordUnsubscribe 的降零返回(不向 relay 转发 unsubscribe)。
    recordUnsubscribe(windowId, normalizedDeviceId, topicList);
    rethrowDeviceLinkError(err);
  }
  // 错误结果(非异常,如 ACCESS_REVOKED / REMOTE_DISABLED / CHANNEL_NOT_ALLOWED)同样视作未订上 → 撤 ref。
  if (!result.ok) recordUnsubscribe(windowId, normalizedDeviceId, topicList);
  return unwrapSubscribeResult(result);
}

/**
 * 控制端:取消订阅被控端某 topic。只有当该 topic 的引用降到 0(本窗口是最后一个持有者)
 * 才真正向 relay 发 unsubscribe;否则别的窗口还在用,直接返回 ok 不发帧。
 */
export async function handleUnsubscribe(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
  topics: unknown,
  windowId: number,
): Promise<{ ok: true }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  const topicList = normalizeTopics(topics);
  if (topicList.length === 0) {
    throwIpcError('INVALID_PARAMS', 'topics is required');
  }
  const toUnsub = recordUnsubscribe(windowId, deviceId, topicList);
  if (toUnsub.length === 0) return { ok: true }; // 仍有其它窗口持有,不向 relay 发 unsubscribe
  let result: InvokeResultPayload;
  try {
    result = await deps.unsubscribe(deviceId, toUnsub);
  } catch (err) {
    // 仅链路仍在、单帧丢失(INVOKE_TIMEOUT)才恢复引用重试;链路断等其它异常不恢复(见 isRetryableUnsubscribeError)。
    if (isRetryableUnsubscribeError(err)) recordSubscribe(windowId, deviceId, toUnsub);
    rethrowDeviceLinkError(err);
  }
  // 错误结果(非异常):ACCESS_REVOKED / REMOTE_DISABLED / CHANNEL_NOT_ALLOWED / IPC_ERROR 都是终态 ——
  // 被控端要么已清掉本控制端订阅表(撤销 / 关被控),要么根本不支持该 channel,远端无存活订阅可重试。
  // **不恢复**引用(恢复会留下永不释放的 phantom ref → 阻断别窗口真实退订 → 被控端持续推送),直接按码抛。
  return unwrapSubscribeResult(result);
}

/**
 * 窗口销毁后的退订重试(best-effort)。窗口已销毁、refcount 已无该窗口的 ref,无处「恢复引用」
 * 留给后续重试(那是普通 unsubscribe 路径 handleUnsubscribe 的做法,且恢复死窗口的 ref 会让它
 * 永久挂着、阻断其它窗口的 unsubscribe)。故这里改用**有限退避主动重试**:
 *  - timeout(链路在、帧丢)→ 重试多半成功,堵住「被控端继续推送已无 UI 订阅的 topic」的泄漏;
 *  - NOT_CONNECTED(链路断)→ 重试也失败,但被控端会在 link-close 时 clearController 清掉本控制端
 *    整张订阅表兜底,故用尽即放弃可接受。
 * sleep 可注入便于单测。
 */
export async function retryUnsubscribeAfterWindowGone(
  unsubscribe: (deviceId: string, topics: string[]) => Promise<InvokeResultPayload>,
  deviceId: string,
  topics: string[],
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await unsubscribe(deviceId, topics);
      if (r.ok) return;
    } catch {
      // 落到退避重试
    }
    if (i < attempts - 1) await sleep(Math.min(500 * 2 ** i, 3000));
  }
  log.debug(`unsubscribe after window-gone gave up: ${deviceId} topics=${topics.join(',')}`);
}

// ─── 注册(Electron adapter)──────────────────────────────────────────────────

export function registerDeviceLinkIpc(deps: DeviceLinkIpcDeps = defaultDeps()): void {
  const gated = <T extends unknown[]>(handler: (...args: T) => unknown) => (...args: T) => {
    requireDeviceLinkCapability();
    return handler(...args);
  };
  // Keep the local keep-awake setting available without a Cindy account. The
  // setting is local-only and does not expose any remote-control capability.
  ipcMain.handle(DEVICE_LINK_INVOKE.GET_STATE, () => handleGetState(deps));
  ipcMain.handle(DEVICE_LINK_INVOKE.SET_ENABLED, (_e, enabled: unknown) =>
    gated(handleSetEnabled)(deps, enabled),
  );
  ipcMain.handle(DEVICE_LINK_INVOKE.SET_KEEP_AWAKE, (_e, enabled: unknown) =>
    handleSetKeepAwake(deps, enabled),
  );
  ipcMain.handle(DEVICE_LINK_INVOKE.SET_DEVICE_CONTROL_ENABLED, (_e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown; enabled?: unknown };
    return handleSetDeviceControlEnabled(deps, p.deviceId, p.enabled);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.LIST_DEVICES, gated(() => handleListDevices(deps)));
  ipcMain.handle(DEVICE_LINK_INVOKE.RENAME_DEVICE, (_e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown; name?: unknown };
    return handleRenameDevice(deps, p.deviceId, p.name);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.DELETE_DEVICE, (_e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown };
    return handleDeleteDevice(deps, p.deviceId);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.OPEN_LINK, (_e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown };
    return handleOpenLink(deps, p.deviceId);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.CLOSE_LINK, (_e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown };
    return handleCloseLink(deps, p.deviceId);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.INVOKE, (_e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown; channel?: unknown; args?: unknown };
    return handleInvoke(deps, p.deviceId, p.channel, p.args);
  });
  // 多窗口订阅引用计数:每个发起订阅的窗口(WebContents)挂一次 'destroyed' 清理,
  // 窗口关闭时释放它持有的全部引用,聚合出降零 topics 才向 relay 发 unsubscribe
  // (避免关一个窗口拆掉其它窗口还在用的订阅)。
  const destroyedAttached = new Set<number>();
  const attachWindowCleanup = (sender: Electron.WebContents): void => {
    const windowId = sender.id;
    if (destroyedAttached.has(windowId)) return;
    destroyedAttached.add(windowId);
    sender.once('destroyed', () => {
      destroyedAttached.delete(windowId);
      for (const { deviceId, topics } of recordWindowGone(windowId)) {
        // 窗口已销毁、无 ref 可恢复 → 用有限退避主动重试,堵住 unsubscribe 一次失败后被控端
        // 对已无 UI 订阅的 topic 持续推送的泄漏(见 retryUnsubscribeAfterWindowGone)。
        if (topics.length > 0) void retryUnsubscribeAfterWindowGone(deps.unsubscribe, deviceId, topics);
      }
    });
  };
  ipcMain.handle(DEVICE_LINK_INVOKE.SUBSCRIBE, (e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown; topics?: unknown };
    attachWindowCleanup(e.sender);
    return handleSubscribe(deps, p.deviceId, p.topics, e.sender.id);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.UNSUBSCRIBE, (e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown; topics?: unknown };
    return handleUnsubscribe(deps, p.deviceId, p.topics, e.sender.id);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.DISCONNECT_ALL, () => {
    requireDeviceLinkCapability();
    resetSubscriptionRefcount(); // 整体断开 → 清空引用,后续重连各窗口重订阅
    return handleDisconnectAll(deps);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.REVOKE, (_e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown };
    return handleRevoke(deps, p.deviceId);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.RESTORE, (_e, payload: unknown) => {
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown };
    return handleRestore(deps, p.deviceId);
  });
}
