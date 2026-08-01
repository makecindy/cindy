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
import { requireString, throwIpcError } from '../utils/ipcValidate';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
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
  stripOutboundSessionReferenceSideChannels,
} from './outboundSessionReferences';
import {
  isPlaceholderDeviceName,
  readDeviceLinkSettings,
  readLastKnownDeviceNames,
  rememberLastKnownDeviceName,
  setDeviceControlEnabled,
} from './settings-store';
import { ownerScopedUserDataPath } from '../appSessionState';
import {
  getMirrorCache,
  MirrorCachePurgeError,
  type CachedDeviceSessions,
  type MirrorCache,
} from './mirrorCacheStore';
import { enqueuePurge, hasPendingPurgeRecords } from './mirrorCachePurgeQueue';
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
    apiFetch: (path, opts) => serverApiFetch(path, { ...opts, baseUrl: deviceLinkApiBase }),
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
  BACKPRESSURE: 'DEVICE_LINK_NOT_CONNECTED',
};

/**
 * unsubscribe 失败后是否应**恢复引用重试**。判据是「失败后远端订阅是否仍存活」:
 *  - 链路仍在但这一帧 unsubscribe 丢了/超时(INVOKE_TIMEOUT)，或本地背压在发送前拒绝
 *    (BACKPRESSURE)→ 远端订阅还在 → 恢复,让
 *    后续 unsubscribe / 窗口销毁重试把它清掉。
 *  - 其它失败(NOT_CONNECTED / LINK_NOT_OPEN / DEVICE_OFFLINE 链路断;ACCESS_REVOKED / REMOTE_DISABLED
 *    被控端已 clearController 清掉本控制端订阅表;CHANNEL_NOT_ALLOWED 老被控端根本不支持该 channel)→
 *    远端无存活订阅可清 → **不恢复**:恢复只会留下永不释放的 phantom ref(阻断别窗口的真实退订 →
 *    被控端对已无 UI 订阅者的 topic 持续推送)。
 * 注:抛出的 DeviceLinkError 只覆盖链路/超时类码;ACCESS_REVOKED / REMOTE_DISABLED 等终态走的是
 * `!result.ok` 结果分支(那里一律不恢复),故本函数只需放行发送状态不确定/未发送的两类错误。
 */
function isRetryableUnsubscribeError(err: unknown): boolean {
  return (
    err instanceof DeviceLinkError
    && (err.code === 'INVOKE_TIMEOUT' || err.code === 'BACKPRESSURE')
  );
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

function assertControlTargetEnabled(
  deps: Pick<DeviceLinkIpcDeps, 'getState'>,
  deviceId: string,
): void {
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

export async function handleRevoke(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
): Promise<{ ok: true }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  await deps.revoke(deviceId);
  return { ok: true };
}

export async function handleRestore(
  deps: DeviceLinkIpcDeps,
  deviceId: unknown,
): Promise<{ ok: true }> {
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

  // Resolve controller-relative references first. If the source session is
  // foreign or unavailable, the rewrite drops only the optional reference
  // side channel and preserves the raw link text. Recompute the capability
  // need afterwards so that plain-link fallback also works with older targets.
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
        log.warn('target does not support session references; sending raw link text', {
          channel,
        });
        callArgs = stripOutboundSessionReferenceSideChannels(channel, callArgs);
      } else if (capability.error.code === 'IPC_ERROR') {
        throwIpcError(
          'SESSION_REFERENCE_UNAVAILABLE',
          '目标设备仍在启动，任务引用暂不可用，请稍后重试',
        );
      } else {
        throwIpcError(
          DEVICE_LINK_CODE_MAP[capability.error.code] ?? 'INTERNAL',
          capability.error.message,
        );
      }
    } else {
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
        log.warn('target does not support session references; sending raw link text', {
          channel,
        });
        callArgs = stripOutboundSessionReferenceSideChannels(channel, callArgs);
      }
    }
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
  throwIpcError(DEVICE_LINK_CODE_MAP[result.error.code] ?? 'INTERNAL', result.error.message);
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
    // 链路仍在但单帧丢失(INVOKE_TIMEOUT)，或发送前被本地背压拒绝(BACKPRESSURE)时，
    // 恢复引用等待重试；链路断开等其它异常不恢复(见 isRetryableUnsubscribeError)。
    if (isRetryableUnsubscribeError(err)) recordSubscribe(windowId, deviceId, toUnsub);
    rethrowDeviceLinkError(err);
  }
  // 错误结果(非异常):ACCESS_REVOKED / REMOTE_DISABLED / CHANNEL_NOT_ALLOWED / IPC_ERROR 都是终态 ——
  // 被控端要么已清掉本控制端订阅表(撤销 / 关被控),要么根本不支持该 channel,远端无存活订阅可重试。
  // **不恢复**引用(恢复会留下永不释放的 phantom ref → 阻断别窗口真实退订 → 被控端持续推送),直接按码抛。
  return unwrapSubscribeResult(result);
}

// ─── 远程会话镜像的本地冷缓存(纯本机,不进隧道)────────────────────────────────

/**
 * renderer 一次能塞进来的最大条数(store 内部还会按时间截到 MAX_CACHED_MESSAGES)。
 * IPC payload 不可信,先在这里挡住异常大的数组,别让 main 白做序列化。
 *
 * 截断取**数组开头**:`local-db:messages:list` 的页是 newest-first(最新在前,
 * 见首拉的 mergeMessages(..., 'newest-first')),取前 N 才是留最新的那批。
 * 正常一页 ≤ MAX_LIMIT(100),这条上限只是防御。
 */
const MIRROR_CACHE_MAX_INBOUND_MESSAGES = 500;
const MIRROR_CACHE_MAX_INBOUND_DEVICES = 64;
/** 每设备的会话条数上限(store 内部还会按 MAX_CACHED_SESSIONS_PER_DEVICE 再裁一次)。 */
const MIRROR_CACHE_MAX_INBOUND_SESSIONS_PER_DEVICE = 500;
/** 单条(一条消息 / 一台设备)序列化后的字节上限。 */
/**
 * 单条允许的**字符**总量(键名 + 字符串值)。取 512K 字符:与单条字节上限同量级,而字符数
 * 在遍历时就能累加,不必先序列化(见 withinStructuralBudget)。
 */
const MIRROR_CACHE_MAX_ITEM_CHARS = 512 * 1024;
const MIRROR_CACHE_MAX_ITEM_BYTES = 512 * 1024;
/** 整批 payload 序列化后的字节上限。 */
const MIRROR_CACHE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** 结构深度与节点数上限:在**序列化之前**挡住病态嵌套 / 超宽对象。 */
const MIRROR_CACHE_MAX_DEPTH = 16;
const MIRROR_CACHE_MAX_NODES_PER_ITEM = 20_000;

/**
 * 结构体量预检:不序列化,只走一遍计数。深度或节点数超限即判不合格。
 *
 * 顺序很重要 —— 先做这一步再 `JSON.stringify`:对病态嵌套 / 超宽对象直接序列化,本身就是
 * 那个「一次调用拖住 main 进程」的攻击面(review: codex P1)。
 */
function withinStructuralBudget(value: unknown): boolean {
  let nodes = 0;
  // 标量字符预算:一条里塞一个超大字符串(或超长键名)时,结构预检只把它算作**一个节点**,
  // 于是随后的 JSON.stringify 要先把整份分配 + 走完才撞上 512KB 上限 —— 那时内存已经吃进去了
  // (review: codex P1)。所以在遍历时就累计字符数,超预算立刻短路,绝不进序列化。
  let chars = 0;
  const withinChars = (text: string): boolean => {
    chars += text.length;
    return chars <= MIRROR_CACHE_MAX_ITEM_CHARS;
  };
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MIRROR_CACHE_MAX_DEPTH) return false;
    if (++nodes > MIRROR_CACHE_MAX_NODES_PER_ITEM) return false;
    if (typeof node === 'string') return withinChars(node);
    if (Array.isArray(node)) {
      for (const child of node) if (!walk(child, depth + 1)) return false;
      return true;
    }
    if (node && typeof node === 'object') {
      // 刻意用 `for...in` + hasOwnProperty 而不是 `Object.values(node)`:后者会**先分配**
      // 一份包含全部可枚举值的数组,于是「一个几十万键的宽对象」在预算生效之前就已经让
      // main 吃了一次大分配 —— 而这个函数存在的意义正是在此之前挡住它(review: copilot)。
      // 逐键遍历可以在超限的第一个键上就短路返回。
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        // 键名同样计入(超长键名也是要序列化的字节)。
        if (!withinChars(key)) return false;
        if (!walk((node as Record<string, unknown>)[key], depth + 1)) return false;
      }
      return true;
    }
    return true;
  };
  return walk(value, 0);
}

/**
 * 逐条做有界筛选:超限的**单条丢弃**、累计字节到顶就停止收后续条目。
 *
 * 只限数组长度是不够的:一条消息里可以塞进任意大的字符串或深嵌套对象,而 main 侧随后要
 * 遍历 + 反复 `JSON.stringify` 才会撞上 512KB 的输出上限 —— 那时内存已经吃进去了。
 * 这里在归一化之前就把总量卡住,单条超限只丢那一条(缓存是纯优化,少一条无所谓)。
 */
function boundedItems<T>(items: readonly T[], maxItems: number, label: string): T[] {
  const out: T[] = [];
  let totalBytes = 0;
  for (const item of items.slice(0, maxItems)) {
    if (!withinStructuralBudget(item)) {
      log.warn(`mirror cache ${label}: dropping structurally oversized item`);
      continue;
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(item) ?? '', 'utf8');
    } catch {
      log.warn(`mirror cache ${label}: dropping unserializable item`);
      continue;
    }
    if (bytes > MIRROR_CACHE_MAX_ITEM_BYTES) {
      log.warn(`mirror cache ${label}: dropping item of ${bytes} bytes`);
      continue;
    }
    if (totalBytes + bytes > MIRROR_CACHE_MAX_TOTAL_BYTES) {
      log.warn(`mirror cache ${label}: payload budget reached, ignoring the rest`);
      break;
    }
    totalBytes += bytes;
    out.push(item);
  }
  return out;
}

/**
 * 「启动时那次 purge drain 还没跑完」的闸门。
 *
 * 上一次登出 / 撤销留下的待清文件在 drain 完成前仍在盘上,而缓存读 IPC 在 `registerDeviceLinkIpc`
 * 之后立刻可用 —— renderer 的 hydrate 可能正好读到那份本该消失的明文,并且被控端离线时它会
 * 一直留在 renderer 内存里(drain 完成也不会把屏上的行收回去)(review: codex P1)。
 * 所以**读**路径等这次 drain 落定;写与清理不受影响(它们只会让盘上更干净)。
 */
let mirrorCacheReadGate: Promise<unknown> = Promise.resolve();

export function setMirrorCacheReadGate(gate: Promise<unknown>): void {
  // 闸门只用来"等一下",本身失败不该让读路径抛错(drain 失败会自己记日志与重试)。
  mirrorCacheReadGate = gate.catch(() => undefined);
}

async function awaitMirrorCacheReadGate(): Promise<void> {
  await mirrorCacheReadGate;
}

/**
 * 读之前的最后一道:上一次 drain 之后仍有待清条目时**一律不命中**。
 *
 * drain 是 best-effort 的 —— 它可能返回 `pending > 0`(某个 session-list / 消息文件因文件锁
 * 或权限删不掉)。此时那份内容还在盘上,照读就把「本该消失的被撤销设备 / 上一个账号的正文」
 * 交回 renderer,而 renderer 一旦画上去就收不回了(review: codex P1)。
 * 代价只是失去首屏加速,且仅限于这种失败状态;下一次 drain 成功即恢复。
 */
async function mirrorCacheReadsBlocked(): Promise<boolean> {
  return hasPendingPurgeRecords();
}

/**
 * 缓存 owner 的身份标记 = owner 作用域路径本身(见 appSessionState.ownerScopedUserDataPath)。
 * 读路径要在**返回之前**再取一次比对:闸门等待 / 文件读期间账号边界可能已经走完,
 * 那时返回的既可能是上一个账号的明文,也可能是新账号的快照被交给旧账号发起的那次请求
 * (review: codex P1)。变了就当未命中。
 */
function cacheOwnerToken(): string {
  return ownerScopedUserDataPath('device-link-mirror-cache');
}

/**
 * 缓存 id 的长度上界。renderer 被 XSS 时可以塞进任意长的 deviceId / sessionId,而 store 随后
 * 会对**完整字符串**做 trim + 正则改写 + sha256(messageFileName / clearDevice),这些都是同步
 * 的 —— 一次调用就能拖住 main(数组与单条字节预算管不到标量字段)(review: codex P1)。
 * 真实 id 是 cuid / uuid 量级(≤ 64),给到 256 已经宽松得离谱。
 */
const MIRROR_CACHE_MAX_ID_LENGTH = 256;

function requireCacheId(value: unknown, name: string): string {
  const id = requireString(value, name);
  if (id.length > MIRROR_CACHE_MAX_ID_LENGTH) {
    throwIpcError('INVALID_PARAMS', `${name} is too long`);
  }
  return id;
}

export async function handleMirrorCacheGetMessages(
  cache: MirrorCache,
  deviceId: unknown,
  sessionId: unknown,
): Promise<{ messages: Record<string, unknown>[]; invalidation?: number }> {
  const device = requireCacheId(deviceId, 'deviceId');
  const session = requireCacheId(sessionId, 'sessionId');
  const owner = cacheOwnerToken();
  await awaitMirrorCacheReadGate();
  if (await mirrorCacheReadsBlocked()) {
    log.warn('mirror cache read suppressed: purge queue still has pending entries');
    return { messages: [] };
  }
  const read = await cache.readMessagesWithInvalidation(device, session);
  const messages = read.messages;
  if (cacheOwnerToken() !== owner) {
    log.warn('mirror cache read discarded: account boundary moved while reading');
    return { messages: [] };
  }
  // 读**之后**再复核一次待清状态:另一个共享 userData 的实例(或本进程里一次失败的清理)
  // 可能刚好在预检之后、读完成之前登记了待清 —— 那份正文已经被标记为"必须删掉",不能再交出去
  // (review: codex P1)。这是与 owner 复核并列的"返回前再验一次"。
  if (await mirrorCacheReadsBlocked()) {
    log.warn('mirror cache read discarded: purge enqueued while reading');
    return { messages: [] };
  }
  // 带回**主进程侧**的会话级作废计数:renderer 缓存它,下一次写入用它当"我取到内容时的
  // 计数",于是另一个窗口 / 另一个进程的作废也能挡住这次写(review: codex P1)。
  return { messages, invalidation: read.invalidation };
}

export async function handleMirrorCachePutMessages(
  cache: MirrorCache,
  deviceId: unknown,
  sessionId: unknown,
  messages: unknown,
  enqueueRetry: (
    root: string,
    paths?: readonly string[],
    barriers?: readonly string[],
    tombstones?: readonly string[],
  ) => Promise<void> = enqueuePurge,
  expectedInvalidation?: unknown,
): Promise<{ ok: true; invalidation?: number }> {
  const device = requireCacheId(deviceId, 'deviceId');
  const session = requireCacheId(sessionId, 'sessionId');
  if (!Array.isArray(messages)) throwIpcError('INVALID_PARAMS', 'messages must be an array');
  const bounded = boundedItems(messages, MIRROR_CACHE_MAX_INBOUND_MESSAGES, 'messages');
  const expected =
    typeof expectedInvalidation === 'number' && Number.isFinite(expectedInvalidation)
      ? expectedInvalidation
      : undefined;
  try {
    const result = await cache.writeMessages(device, session, bounded, expected);
    return { ok: true, invalidation: result.invalidation };
  } catch (err) {
    // 空写(被控端 /clear、rewind、会话删除)删不掉旧文件时同样要能重试:
    // 权威侧已经没有这些消息了,本机留着就会在下次离线冷启动被 hydrate 出来。
    await queuePurgeRetry(err, enqueueRetry, 'writeMessages');
  }
  return { ok: true };
}

export async function handleMirrorCacheGetSessionList(
  cache: MirrorCache,
): Promise<{ devices: CachedDeviceSessions[] }> {
  const owner = cacheOwnerToken();
  await awaitMirrorCacheReadGate();
  if (await mirrorCacheReadsBlocked()) {
    log.warn('mirror cache read suppressed: purge queue still has pending entries');
    return { devices: [] };
  }
  const devices = await cache.readSessionList();
  if (cacheOwnerToken() !== owner) {
    log.warn('mirror cache read discarded: account boundary moved while reading');
    return { devices: [] };
  }
  // 同 messages:读完再复核待清状态(见那边的说明)。
  if (await mirrorCacheReadsBlocked()) {
    log.warn('mirror cache read discarded: purge enqueued while reading');
    return { devices: [] };
  }
  return { devices };
}

export async function handleMirrorCachePutSessionList(
  cache: MirrorCache,
  devices: unknown,
  enqueueRetry: (
    root: string,
    paths?: readonly string[],
    barriers?: readonly string[],
    tombstones?: readonly string[],
  ) => Promise<void> = enqueuePurge,
): Promise<{ ok: true }> {
  if (!Array.isArray(devices)) throwIpcError('INVALID_PARAMS', 'devices must be an array');
  // 先把外层数组截断,再逐台把 sessions 截断,最后对整批做结构 / 字节预算。
  // 顺序很重要:`map` 之前必须先 slice —— 否则一次超长 devices 数组会让 main 同步遍历全量
  // 并再分配一份等长的新数组(含对象展开),64 台的上限要等 boundedItems 才生效,那时内存
  // 已经吃进去了。截断之后才是「设备数不多但某台带着几十万个 session」这一层(review: codex P1)。
  // 逐台**只挑需要的三个字段**,不做对象展开:一台设备对象可以带上几十万个自有属性,
  // 展开会让 main 先枚举 + 复制整份,结构 / 字节预算要等 boundedItems 才生效(review: codex P1)。
  // main 侧的 normalizeDeviceSessions 也只消费这三个字段,别的原本就会被白名单丢掉。
  const trimmed = devices.slice(0, MIRROR_CACHE_MAX_INBOUND_DEVICES).map((device) => {
    if (!device || typeof device !== 'object') return device;
    const source = device as { deviceId?: unknown; deviceName?: unknown; sessions?: unknown };
    return {
      deviceId: source.deviceId,
      deviceName: source.deviceName,
      sessions: Array.isArray(source.sessions)
        ? source.sessions.slice(0, MIRROR_CACHE_MAX_INBOUND_SESSIONS_PER_DEVICE)
        : [],
    };
  });
  try {
    await cache.writeSessionList(
      boundedItems(trimmed, MIRROR_CACHE_MAX_INBOUND_DEVICES, 'session-list'),
    );
  } catch (err) {
    // 快照写空(最后一台设备离场)或清理期间的补偿删除失败时,盘上会留着本该消失的设备
    // 元数据 —— 登记重试,而不是把失败咽下去。
    await queuePurgeRetry(err, enqueueRetry, 'writeSessionList');
  }
  return { ok: true };
}

/** 清理类失败 → 登记持久重试;其它错误照常抛。 */
async function queuePurgeRetry(
  err: unknown,
  enqueueRetry: (
    root: string,
    paths?: readonly string[],
    barriers?: readonly string[],
    tombstones?: readonly string[],
  ) => Promise<void>,
  where: string,
): Promise<void> {
  if (!(err instanceof MirrorCachePurgeError)) throw err;
  log.error(`${where} left ${err.remaining.length} path(s) behind; queued for retry`, err);
  // barriers = 自增失败的作废计数器 key:队列在补删前替我们自增,否则"内容取自清理之前、
  // put 迟到"的写入会在消化之后通过比对(见 MirrorCachePurgeError.barriers)。
  // tombstones = 还挂着的"清理没确认完成"墓碑 scope:补删成功后由队列撤掉,否则一次瞬时失败
  // 会让整个账号的缓存读永久不命中(见 MirrorCachePurgeError.tombstones)。
  await enqueueRetry(err.root, err.remaining, err.barriers, err.tombstones).catch(
    (queueErr: unknown) => {
      log.error(`failed to queue ${where} purge retry`, queueErr);
    },
  );
}

/**
 * 清掉**一台设备**的缓存(设备撤销访问 / 关闭被控 / 本机禁用控制)。
 *
 * 刻意只支持逐设备、**不提供**「整体清」入口:renderer 没有任何合法的无参调用方 ——
 * 登出清理是 main 内部直接调 `clearAll()`(见 teardownAuthAccountBoundary)。把
 * `deviceId` 缺失当成「授权抹掉整个 owner 缓存」,等于给一个固定的 preload 方法配上
 * 不必要的破坏力:renderer 若被 XSS,顶层 frame 的 sender 闸挡不住它(review: codex P1)。
 * 所以缺失 / 空白 / 非字符串一律 INVALID_PARAMS。
 */
export async function handleMirrorCacheClear(
  cache: MirrorCache,
  deviceId: unknown,
  enqueueRetry: (
    root: string,
    paths?: readonly string[],
    barriers?: readonly string[],
    tombstones?: readonly string[],
  ) => Promise<void> = enqueuePurge,
): Promise<{ ok: true }> {
  const device = requireCacheId(deviceId, 'deviceId');
  try {
    await cache.clearDevice(device);
  } catch (err) {
    // 文件删不掉(文件锁 / 权限)时登记重试:被撤销的对端正文不能就这么留在盘上,
    // 而 renderer 侧的清理是 fire-and-forget、没人会重试(review: codex P1)。
    await queuePurgeRetry(err, enqueueRetry, 'clearDevice');
  }
  return { ok: true };
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
  const gated =
    <T extends unknown[]>(handler: (...args: T) => unknown) =>
    (...args: T) => {
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
  ipcMain.handle(
    DEVICE_LINK_INVOKE.LIST_DEVICES,
    gated(() => handleListDevices(deps)),
  );
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
        if (topics.length > 0)
          void retryUnsubscribeAfterWindowGone(deps.unsubscribe, deviceId, topics);
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
  // 远程会话镜像缓存。三道闸:
  //  1. assertTrustedAppRendererEvent:必须来自 Cindy 自己登记过的应用窗口**顶层页面**。
  //     capability 只证明「当前登着云账号」,不证明调用者是可信 frame —— 带 preload 的窗口被
  //     导航到不可信内容时,读 handler 能吐出缓存的聊天正文,put/clear 能改写或抹掉
  //     owner 作用域的数据(review: codex P1)。
  //  2. requireDeviceLinkCapability:没账号就不存在远程会话,读写一律不放行。
  //  3. **clear 只过第 1 道** —— 设备被撤销 / 关掉控制时要能清,而那可能发生在 capability
  //     已经掉下去之后。它只接受非空 deviceId(逐设备),不提供「清全部」入口:登出清理
  //     由 main 内部直接调 clearAll,renderer 不需要这个破坏力。
  ipcMain.handle(DEVICE_LINK_INVOKE.MIRROR_CACHE_GET_MESSAGES, (e, payload: unknown) => {
    assertTrustedAppRendererEvent(e);
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { deviceId?: unknown; sessionId?: unknown };
    return handleMirrorCacheGetMessages(getMirrorCache(), p.deviceId, p.sessionId);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.MIRROR_CACHE_PUT_MESSAGES, (e, payload: unknown) => {
    assertTrustedAppRendererEvent(e);
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as {
      deviceId?: unknown;
      sessionId?: unknown;
      messages?: unknown;
      expectedInvalidation?: unknown;
    };
    return handleMirrorCachePutMessages(
      getMirrorCache(),
      p.deviceId,
      p.sessionId,
      p.messages,
      undefined,
      p.expectedInvalidation,
    );
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.MIRROR_CACHE_GET_SESSION_LIST, (e) => {
    assertTrustedAppRendererEvent(e);
    requireDeviceLinkCapability();
    return handleMirrorCacheGetSessionList(getMirrorCache());
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.MIRROR_CACHE_PUT_SESSION_LIST, (e, payload: unknown) => {
    assertTrustedAppRendererEvent(e);
    requireDeviceLinkCapability();
    const p = (payload ?? {}) as { devices?: unknown };
    return handleMirrorCachePutSessionList(getMirrorCache(), p.devices);
  });
  ipcMain.handle(DEVICE_LINK_INVOKE.MIRROR_CACHE_CLEAR, (e, payload: unknown) => {
    assertTrustedAppRendererEvent(e);
    const p = (payload ?? {}) as { deviceId?: unknown };
    return handleMirrorCacheClear(getMirrorCache(), p.deviceId);
  });
}
