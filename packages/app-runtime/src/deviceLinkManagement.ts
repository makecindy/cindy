import type { LinkAcceptPayload, InvokeResultPayload } from '@cindy/device-link';
import { DEVICE_LINK_PUSH, type DeviceLinkDeviceView, type DeviceLinkState } from '@cindy/remote-agent/shared/deviceLinkIpc';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import { normalizeCachedDeviceName, isPlaceholderDeviceName } from './deviceLinkSettings.js';

export type DeviceLinkServerDeviceView = Omit<DeviceLinkDeviceView, 'controlEnabled'> & {
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
  invoke(deviceId: string, channel: string, args: unknown[], options?: { background?: boolean }): Promise<InvokeResultPayload>;
  /** 分享者电脑的只读请求：先建后台链路再发(relay 只在建链时登记受邀者的电脑)。缺省时用 invoke。 */
  invokeProviderShareHost?(target: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
  subscribe(deviceId: string, topics: string[]): Promise<InvokeResultPayload>;
  unsubscribe(deviceId: string, topics: string[]): Promise<InvokeResultPayload>;
  disconnectAll(): void;
  revoke(deviceId: string): Promise<void>;
  restore(deviceId: string): Promise<void>;
  setDeviceControlEnabled(deviceId: string, enabled: boolean): Promise<string[]>;
  /** 清理本机禁用目标的响应性熔断状态。 */
  clearDeviceResponsiveness?(deviceId: string): void;
  broadcast(channel: string, payload: unknown): void;
  readLastKnownDeviceNames(): Record<string, string>;
  rememberLastKnownDeviceName(deviceId: string, name: string): Promise<boolean>;
  forgetLastKnownDeviceName(deviceId: string): Promise<boolean>;
  applyControllerDisplayNameListSnapshot(
    devices: readonly DeviceLinkServerDeviceView[],
    requestEpoch: number,
  ): void;
  applyControllerPresenceListSnapshot(
    devices: readonly DeviceLinkServerDeviceView[],
    requestEpoch: number,
  ): void;
  beginControllerDisplayNameDirectoryRefresh(): number;
  isLatestControllerDisplayNameDirectoryRefresh(sequence: number): boolean;
  waitForNewerControllerDisplayNameDirectoryRefresh(sequence: number): Promise<void>;
  captureControllerDisplayNameRequestEpoch(): number;
  captureControllerPresenceRequestEpoch(): number;
  readControllerDisplayNameFreshnessSince(
    deviceId: string,
    requestEpoch: number,
  ): { changedAfterRequest: boolean; authoritativeName: string | null };
  /**
   * 出方向附件改写:把消息里的本机附件上传 OSS、替换成引用串(仅 send/steer/enqueue 生效)。
   * 可选 —— 测试可不注入(跳过改写,行为同旧版纯透传)。
   */
  rewriteOutboundMedia?(channel: string, args: unknown[], existing?: ReadonlySet<string>): Promise<unknown[]>;
  /** 控制端 main 在越过 device-link 前把相对引用解析为可信、预算化快照。 */
  rewriteOutboundSessionReferences?(channel: string, args: unknown[]): Promise<unknown[]>;
}

/** Original local management and directory handlers, shared by both hosts. */
export function createDeviceLinkManagement(host: {
  getAppCapabilities(): { canUseDeviceLink: boolean };
  rethrowServerError(error: unknown): never;
  rethrowDeviceLinkError(error: unknown): never;
  resetSubscriptionRefcountForDevice(deviceId: string): void;
}) {
const { getAppCapabilities, rethrowServerError, rethrowDeviceLinkError, resetSubscriptionRefcountForDevice } = host;
function handleGetState(deps: Pick<DeviceLinkIpcDeps, 'getState'>): DeviceLinkState {
  const state = deps.getState();
  if (getAppCapabilities().canUseDeviceLink) return state;

  // Keep the local, account-free setting available to Settings while hiding
  // account-scoped Device Link state from signed-out/local sessions.
  return {
    remoteControlEnabled: false,
    keepAwake: state.keepAwake,
    linkStatus: 'stopped',
    connectionIssue: null,
    // 无 device-link 能力(未登录 / 本地会话)不是“被本机另一实例占用”,按 false 上报。
    standby: false,
    controlledBy: [],
    revokedControllers: [],
    disabledControlDeviceIds: [],
    unresponsiveDeviceIds: [],
  };
}

async function handleSetEnabled(
  deps: Pick<DeviceLinkIpcDeps, 'setEnabled'>,
  enabled: unknown,
): Promise<{ remoteControlEnabled: boolean }> {
  if (typeof enabled !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
  }
  await deps.setEnabled(enabled);
  return { remoteControlEnabled: enabled };
}

async function handleSetKeepAwake(
  deps: Pick<DeviceLinkIpcDeps, 'setKeepAwake'>,
  enabled: unknown,
): Promise<{ keepAwake: boolean }> {
  if (typeof enabled !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
  }
  await deps.setKeepAwake(enabled);
  return { keepAwake: enabled };
}

async function handleSetDeviceControlEnabled(
  deps: Pick<DeviceLinkIpcDeps, 'setDeviceControlEnabled' | 'clearDeviceResponsiveness' | 'closeLink' | 'broadcast'>,
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
    deps.clearDeviceResponsiveness?.(normalizedDeviceId);
    deps.closeLink(normalizedDeviceId);
  }
  deps.broadcast(DEVICE_LINK_PUSH.CONTROL_TARGET_CHANGED, {
    deviceId: normalizedDeviceId,
    enabled,
    disabledControlDeviceIds,
  });
  return { deviceId: normalizedDeviceId, enabled, disabledControlDeviceIds };
}

type DeviceListResult = { devices: DeviceLinkDeviceView[] };

/**
 * 所有 renderer 的设备列表入口最终都汇到本 handler。代次刻意跨状态变化与 teardown
 * 单调递增：后发请求代表更新的目录意图，先发请求即使更晚返回也只能跟随最新 promise，
 * 不能进入 reconcile 写回旧名称/空值，也不能把旧列表重新交给 UI。
 */
let deviceListRequestSequence = 0;
let latestDeviceListRequest: { sequence: number; promise: Promise<DeviceListResult> } | null = null;

function handleListDevices(
  deps: Pick<DeviceLinkIpcDeps, 'getState' | 'apiFetch' | 'readLastKnownDeviceNames' | 'rememberLastKnownDeviceName' | 'forgetLastKnownDeviceName' | 'applyControllerDisplayNameListSnapshot' | 'applyControllerPresenceListSnapshot' | 'beginControllerDisplayNameDirectoryRefresh' | 'isLatestControllerDisplayNameDirectoryRefresh' | 'waitForNewerControllerDisplayNameDirectoryRefresh' | 'captureControllerDisplayNameRequestEpoch' | 'captureControllerPresenceRequestEpoch' | 'readControllerDisplayNameFreshnessSince'>,
): Promise<DeviceListResult> {
  const sequence = ++deviceListRequestSequence;
  const directoryRequestSequence = deps.beginControllerDisplayNameDirectoryRefresh();
  const requestEpoch = deps.captureControllerDisplayNameRequestEpoch();
  const presenceRequestEpoch = deps.captureControllerPresenceRequestEpoch();
  const request = deps.apiFetch<{ devices: DeviceLinkServerDeviceView[] }>(
    '/api/device-link/devices',
  ).then(
    async (result) => {
      let latest = latestDeviceListRequest;
      if (latest && latest.sequence > sequence) return latest.promise;
      const isLatestDirectorySnapshot = deps.isLatestControllerDisplayNameDirectoryRefresh(
        directoryRequestSequence,
      );
      if (isLatestDirectorySnapshot) {
        deps.applyControllerDisplayNameListSnapshot(result.devices, requestEpoch);
        deps.applyControllerPresenceListSnapshot(result.devices, presenceRequestEpoch);
      } else {
        await deps.waitForNewerControllerDisplayNameDirectoryRefresh(directoryRequestSequence);
        latest = latestDeviceListRequest;
        if (latest && latest.sequence > sequence) return latest.promise;
      }
      return reconcileDeviceNames(
        result,
        deps,
        requestEpoch,
        isLatestDirectorySnapshot,
        !isLatestDirectorySnapshot,
      );
    },
    (err: unknown) => {
      const latest = latestDeviceListRequest;
      if (latest && latest.sequence > sequence) return latest.promise;
      return rethrowServerError(err);
    },
  );
  latestDeviceListRequest = { sequence, promise: request };
  return request;
}

function reconcileDeviceNames(
  result: { devices: DeviceLinkServerDeviceView[] },
  deps: Pick<
    DeviceLinkIpcDeps,
    | 'getState'
    | 'readLastKnownDeviceNames'
    | 'rememberLastKnownDeviceName'
    | 'forgetLastKnownDeviceName'
    | 'readControllerDisplayNameFreshnessSince'
  >,
  requestEpoch: number,
  writeCache: boolean = true,
  preferCurrentAuthoritativeName: boolean = false,
): { devices: DeviceLinkDeviceView[] } {
  const cachedNames = deps.readLastKnownDeviceNames();
  const disabledControlDeviceIds = new Set(deps.getState().disabledControlDeviceIds ?? []);

  const devices = result.devices.map<DeviceLinkDeviceView>((device) => {
    let name = device.name;
    const selfName = typeof device.selfName === 'string'
      ? normalizeCachedDeviceName(device.selfName)
      : null;
    const freshness = deps.readControllerDisplayNameFreshnessSince(
      device.deviceId,
      requestEpoch,
    );
    if (freshness.changedAfterRequest || preferCurrentAuthoritativeName) {
      name = freshness.authoritativeName ?? selfName ?? device.deviceId.slice(0, 8);
      const controlEnabled = !disabledControlDeviceIds.has(device.deviceId);
      return { ...device, name, controlEnabled };
    }

    const trimmedName = device.name.trim();
    const hasDisplayName = !!trimmedName && !isPlaceholderDeviceName(trimmedName);
    if (hasDisplayName) {
      if (writeCache) {
        void deps.rememberLastKnownDeviceName(device.deviceId, trimmedName); // best-effort,不阻塞列表返回
      }
      if (device.name !== trimmedName) {
        name = trimmedName;
      }
    } else if (!trimmedName) {
      if (writeCache) {
        void deps.forgetLastKnownDeviceName(device.deviceId); // 显式清空与后台目录刷新保持同义
      }
      name = selfName ?? device.deviceId.slice(0, 8);
    } else if (cachedNames[device.deviceId]) {
      name = cachedNames[device.deviceId];
    } else {
      name = selfName ?? device.deviceId.slice(0, 8);
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

async function handleRenameDevice(
  deps: Pick<DeviceLinkIpcDeps, 'apiFetch'>,
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
    return rethrowServerError(err);
  }
}

async function handleDeleteDevice(
  deps: Pick<DeviceLinkIpcDeps, 'apiFetch'>,
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
    return rethrowServerError(err);
  }
}

// ─── 控制端 handler bodies ────────────────────────────────────────────────────

async function handleOpenLink(
  deps: Pick<DeviceLinkIpcDeps, 'getState' | 'openLink'>,
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
    return rethrowDeviceLinkError(err);
  }
}

function handleCloseLink(deps: Pick<DeviceLinkIpcDeps, 'closeLink' | 'clearDeviceResponsiveness'>, deviceId: unknown): { ok: true } {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  const normalizedDeviceId = deviceId.trim();
  // 显式断开 = 撤回对该设备的控制需求。订阅引用表是全部重放入口(ws-online /
  // presence 翻转 / 熔断恢复)共用的需求信号:不清的话,close 后任一恢复事件都会
  // 带着幽灵引用经按需建链把刚关的链路建回来;被控端在 link 关闭时本就丢弃订阅,
  // 这里让控制端账本与之对齐。清引用 + 清熔断 + 关链路,与「禁用设备控制」路径
  // (setDeviceControlEnabled(false))的既有三连一致(review P2)。
  resetSubscriptionRefcountForDevice(normalizedDeviceId);
  deps.clearDeviceResponsiveness?.(normalizedDeviceId);
  deps.closeLink(normalizedDeviceId);
  return { ok: true };
}

function handleDisconnectAll(deps: Pick<DeviceLinkIpcDeps, 'disconnectAll'>): { ok: true } {
  deps.disconnectAll();
  return { ok: true };
}

async function handleRevoke(
  deps: Pick<DeviceLinkIpcDeps, 'revoke'>,
  deviceId: unknown,
): Promise<{ ok: true }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  await deps.revoke(deviceId);
  return { ok: true };
}

async function handleRestore(
  deps: Pick<DeviceLinkIpcDeps, 'restore'>,
  deviceId: unknown,
): Promise<{ ok: true }> {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'deviceId is required');
  }
  await deps.restore(deviceId);
  return { ok: true };
}

return { handleGetState, handleSetEnabled, handleSetKeepAwake, handleSetDeviceControlEnabled, handleListDevices, assertControlTargetEnabled, handleRenameDevice, handleDeleteDevice, handleOpenLink, handleCloseLink, handleDisconnectAll, handleRevoke, handleRestore };
}
