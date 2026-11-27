/**
 * 另一台电脑的模型组(model-groups.md §6.3)：远程控制那台电脑、或在本机选择器「其他电脑」那一段时，
 * 列出那台电脑自己的模式，选路、提交记录、记绑定与写说明都由那台电脑做。
 *
 * 读取按需：选择器打开时每台电脑读一次，15 秒内再打开复用上次的答案；不轮询。对端明确不支持
 * (`channel 'model-groups:get' not allowed remotely` 或线性缺 handler)由 preload `remoteReadBridge`
 * 按连接代记忆，本模块只维护当前 `(dataOwnerId, generation)` 下的业务快照与 15s 新鲜窗口。
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { isScopedPeer } from '@cindy/device-link';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  subscribeDataOwnerGeneration,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { subscribeDeviceProviders } from '@/hooks/useDeviceProviders';
import { createLogger } from '@/lib/logger';
import { extractRemoteOptionalReadMiss } from '@/utils/ipcError';

import {
  MODEL_GROUPS_IPC,
  modelGroupResolveResultFromRemote,
  modelGroupSelectionForOwner,
  modelGroupsConfigFromRemote,
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupRouteNote,
  type ModelGroupSelection,
  type ModelGroupSessionBindingView,
  type ModelGroupsConfig,
  type ModelGroupSwitchOffer,
} from '../../../shared/modelGroups';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare';

const log = createLogger('model-groups:remote');

export const DEVICE_MODEL_GROUPS_REREAD_MS = 15_000;

/** null = 还没读到(或那台电脑现在连不上)；unsupported = 那台电脑不认识模型组。 */
export interface DeviceModelGroupsSnapshot {
  config: ModelGroupsConfig | null;
  unsupported: boolean;
}

const UNREAD: DeviceModelGroupsSnapshot = Object.freeze({ config: null, unsupported: false });

interface DeviceGroups {
  read(force?: boolean): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): DeviceModelGroupsSnapshot;
  evict(): void;
}

let devicesByOwner = new WeakMap<DataOwnerGeneration, Map<string, DeviceGroups>>();

export function isModelGroupsUnsupportedError(error: unknown): boolean {
  return extractRemoteOptionalReadMiss(error, MODEL_GROUPS_IPC.GET) !== null;
}

function invoke<T>(deviceId: string, channel: string, args: unknown[]): Promise<T> {
  const api = window.electronAPI?.deviceLink;
  if (!api?.invoke) return Promise.reject(new Error('device link unavailable'));
  return api.invoke(deviceId, channel, args) as Promise<T>;
}

let observedLink: unknown = undefined;
let detachReconnectWatch: (() => void) | null = null;
const knownPeers = new Map<string, { online: boolean; remoteControlEnabled: boolean; appVersion?: string }>();

/**
 * 全局离线或控制权变更时原地清空当前 owner 下各设备的快照，不移除 `Map` 里的 `DeviceGroups` 实例：
 * 已挂载组件的 `useMemo` 与重连后新挂载组件继续共享同一个 `entry`，避免新旧组件各自读写不同缓存。
 */
function evictAllCurrentOwnerDeviceModelGroups(): void {
  const devices = devicesByOwner.get(getDataOwnerGeneration());
  if (!devices) return;
  for (const entry of devices.values()) entry.evict();
}

/**
 * 那台电脑离线、链路重置/重开、版本变化或本机连接状态变化后丢掉旧答案(含「不支持」)：
 * 升级、改了模式或换了版本后，下次打开选择器或目录恢复时重新读。常规同版本在线心跳不触发重读。
 */
function watchReconnects(): void {
  const link = typeof window !== 'undefined' ? window.electronAPI?.deviceLink : undefined;
  if (link === observedLink) return;
  const hadPrevious = observedLink !== undefined;
  detachReconnectWatch?.();
  detachReconnectWatch = null;
  observedLink = link;
  knownPeers.clear();
  if (hadPrevious) evictAllCurrentOwnerDeviceModelGroups();
  if (!link) return;

  const offs = [
    link.onPeerLinkReset?.((event) => {
      knownPeers.delete(event.deviceId);
      evictDeviceModelGroups(event.deviceId);
    }),
    link.onPeerLinkReopened?.((event) => {
      evictDeviceModelGroups(event.deviceId);
    }),
    link.onAccessRevoked?.((event) => {
      knownPeers.delete(event.deviceId);
      evictDeviceModelGroups(event.deviceId);
    }),
    link.onControlTargetChanged?.((event) => {
      knownPeers.delete(event.deviceId);
      evictDeviceModelGroups(event.deviceId);
    }),
    link.onPresenceChanged?.((presence) => {
      const prev = knownPeers.get(presence.deviceId);
      const remoteControlEnabled = presence.remoteControlEnabled !== false;
      if (!presence.online || !remoteControlEnabled) {
        knownPeers.delete(presence.deviceId);
        evictDeviceModelGroups(presence.deviceId);
        return;
      }
      const appVersion = typeof presence.appVersion === 'string' ? presence.appVersion : prev?.appVersion;
      if (!knownPeers.has(presence.deviceId) && knownPeers.size >= 256) {
        const oldest = knownPeers.keys().next().value;
        if (oldest !== undefined) knownPeers.delete(oldest);
      }
      knownPeers.set(presence.deviceId, { online: true, remoteControlEnabled: true, appVersion });
      if (
        prev &&
        (!prev.online ||
          !prev.remoteControlEnabled ||
          (prev.appVersion !== undefined && appVersion !== undefined && prev.appVersion !== appVersion))
      ) {
        evictDeviceModelGroups(presence.deviceId);
      }
    }),
    link.onStatusChanged?.((payload) => {
      const changedDeviceId = (payload as { dataPathChangedDeviceId?: unknown } | undefined)?.dataPathChangedDeviceId;
      if (typeof changedDeviceId === 'string' && changedDeviceId) {
        evictDeviceModelGroups(changedDeviceId);
      } else if (payload?.status !== 'online') {
        knownPeers.clear();
        evictAllCurrentOwnerDeviceModelGroups();
      }
    }),
    link.onOwnershipChanged?.(() => {
      knownPeers.clear();
      evictAllCurrentOwnerDeviceModelGroups();
    }),
  ];

  detachReconnectWatch = () => {
    for (const off of offs) off?.();
  };
}

function deviceGroups(owner: DataOwnerGeneration, deviceId: string): DeviceGroups {
  watchReconnects();
  let devices = devicesByOwner.get(owner);
  if (!devices) {
    devices = new Map();
    devicesByOwner.set(owner, devices);
  }
  const known = devices.get(deviceId);
  if (known) return known;
  let current: DeviceModelGroupsSnapshot = UNREAD;
  let pending: Promise<void> | undefined;
  let generation = 0;
  let readAt = 0;
  const listeners = new Set<() => void>();
  const publish = (next: DeviceModelGroupsSnapshot) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const entry: DeviceGroups = {
    read(force = false) {
      watchReconnects();
      if (
        !owner.dataOwnerId ||
        !isDataOwnerGenerationCurrent(owner) ||
        isScopedPeer(deviceId) ||
        isProviderShareAgentDeviceId(deviceId)
      ) {
        return Promise.resolve();
      }
      if (pending) return pending;
      // 成功快照在 15s 新鲜窗口内直接复用；负能力判断交给 preload `remoteReadBridge`，
      // 以便同 appVersion 下仅 `allowlistHash` / `capabilities` 经 `openLink` 变化且无额外 reset/presence 时，
      // 下一次 `read()` 能立即穿透重探，而仍为旧端时由 bridge 本机短路且下方不重复 publish。
      if (!force && !current.unsupported && readAt > 0 && Date.now() - readAt < DEVICE_MODEL_GROUPS_REREAD_MS) {
        return Promise.resolve();
      }
      const readGeneration = generation;
      const run = invoke<unknown>(deviceId, MODEL_GROUPS_IPC.GET, [{ includeSourceRoutes: true }])
        .then((reply) => {
          if (!isDataOwnerGenerationCurrent(owner) || readGeneration !== generation) return;
          readAt = Date.now();
          const config = modelGroupsConfigFromRemote(reply);
          if (!current.unsupported && current.config && JSON.stringify(current.config) === JSON.stringify(config)) return;
          publish({ config, unsupported: false });
        })
        // 连不上、本机策略拦截或普通权限拒绝时保留上一次答案且不占用 15s 新鲜窗口；仅远端明确缺接口记为不支持。
        .catch((error: unknown) => {
          if (!isDataOwnerGenerationCurrent(owner) || readGeneration !== generation) return;
          if (isModelGroupsUnsupportedError(error)) {
            if (!current.unsupported || current.config !== null) {
              publish({ config: null, unsupported: true });
            }
          } else {
            log.warn('device model groups unavailable', error);
          }
        })
        .finally(() => { if (pending === run) pending = undefined; });
      pending = run;
      return run;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot() {
      return isDataOwnerGenerationCurrent(owner) ? current : UNREAD;
    },
    evict() {
      generation += 1;
      pending = undefined;
      readAt = 0;
      if (current !== UNREAD) publish(UNREAD);
    },
  };
  devices.set(deviceId, entry);
  return entry;
}

/** 那台电脑解除配对、关了远程控制或重连时调用：丢掉旧答案，下次打开选择器重新读。 */
export function evictDeviceModelGroups(deviceId: string): void {
  devicesByOwner.get(getDataOwnerGeneration())?.get(deviceId)?.evict();
}

/** 测试用：清掉全部缓存。 */
export function resetDeviceModelGroupsForTests(): void {
  evictAllCurrentOwnerDeviceModelGroups();
  devicesByOwner = new WeakMap();
  detachReconnectWatch?.();
  detachReconnectWatch = null;
  observedLink = undefined;
  knownPeers.clear();
}

function subscribeNone(): () => void {
  return () => undefined;
}

function unread(): DeviceModelGroupsSnapshot {
  return UNREAD;
}

/** 一台电脑的模式(远程控制那台时用)；readOnEntry 时挂载即读一次，并在重连目录就绪时自动补读。 */
export function useDeviceModelGroups(deviceId: string | null | undefined, readOnEntry = false): DeviceModelGroupsSnapshot & { read: () => void } {
  const owner = useSyncExternalStore(
    subscribeDataOwnerGeneration,
    getDataOwnerGeneration,
    getDataOwnerGeneration,
  );
  const entry = useMemo(() => (deviceId ? deviceGroups(owner, deviceId) : null), [owner, deviceId]);
  const read = useCallback(() => { void entry?.read(); }, [entry]);
  useEffect(() => {
    if (!readOnEntry || !owner.dataOwnerId || !deviceId || isScopedPeer(deviceId) || isProviderShareAgentDeviceId(deviceId)) return;
    read();
    return subscribeDeviceProviders(deviceId, (event) => {
      if (event.status === 'ready') read();
    });
  }, [readOnEntry, deviceId, read]);
  const snapshot = useSyncExternalStore(entry?.subscribe ?? subscribeNone, entry?.snapshot ?? unread, unread);
  return { ...snapshot, read };
}

/** 几台电脑的模式(本机选择器「其他电脑」那几段)；选择器打开时调用 read()。 */
export function useDevicesModelGroups(deviceIds: readonly string[]): {
  groups: ReadonlyMap<string, DeviceModelGroupsSnapshot>;
  read: () => void;
} {
  const owner = useSyncExternalStore(
    subscribeDataOwnerGeneration,
    getDataOwnerGeneration,
    getDataOwnerGeneration,
  );
  const key = [...new Set(deviceIds)].sort().join('\n');
  const entries = useMemo(
    () => (key ? key.split('\n') : []).map((deviceId) => ({ deviceId, entry: deviceGroups(owner, deviceId) })),
    [owner, key],
  );
  const read = useCallback(() => { for (const { entry } of entries) void entry.read(); }, [entries]);
  const subscribe = useCallback((listener: () => void) => {
    const offs = entries.map(({ entry }) => entry.subscribe(listener));
    return () => { for (const off of offs) off(); };
  }, [entries]);
  const cache = useRef<{ signature: string; value: ReadonlyMap<string, DeviceModelGroupsSnapshot> } | null>(null);
  const getSnapshot = useCallback(() => {
    const snapshots = entries.map(({ deviceId, entry }) => [deviceId, entry.snapshot()] as const);
    const signature = snapshots.map(([deviceId, snap]) => `${deviceId}:${snap.unsupported ? 'u' : ''}:${snap.config ? JSON.stringify(snap.config) : ''}`).join('\n');
    if (cache.current?.signature !== signature) cache.current = { signature, value: new Map(snapshots) };
    return cache.current.value;
  }, [entries]);
  const groups = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { groups, read };
}

/** 请那台电脑按自己的模式选；失败(连不上、旧版本)返回 null，调用方沿用原来的模型。 */
export async function resolveDeviceModelGroup(
  deviceId: string,
  selection: ModelGroupSelection,
  context?: ModelGroupResolveRequest['context'],
  location?: ModelGroupResolveRequest['location'],
  options?: { remoteInvocableOnly?: boolean; sshHostId?: string },
): Promise<ModelGroupResolveResult | null> {
  try {
    const request: ModelGroupResolveRequest = {
      selection: modelGroupSelectionForOwner(selection),
      ...(context ? { context } : {}),
      ...(location ? { location } : {}),
      ...(options?.remoteInvocableOnly ? { remoteInvocableOnly: true } : {}),
      ...(options?.sshHostId ? { sshHostId: options.sshHostId } : {}),
    };
    const result = await invoke<ModelGroupResolveResult>(deviceId, MODEL_GROUPS_IPC.RESOLVE, [request]);
    return result && typeof result === 'object' ? modelGroupResolveResultFromRemote(result) : result;
  } catch (err) {
    log.warn('device model group resolve failed', err);
    return null;
  }
}

export function commitDeviceModelGroupDecision(deviceId: string, result: ModelGroupResolveResult | null): void {
  if (result?.decisionId) void invoke(deviceId, MODEL_GROUPS_IPC.COMMIT, [result.decisionId])
    .catch((err: unknown) => log.warn('device model group commit failed', err));
}

/** 任务在那台电脑上：记下它用着哪个来源(那台撞配额时据此提议)，并提交这次选路。 */
export async function bindDeviceModelGroupSession(
  deviceId: string,
  sessionId: string,
  selection: ModelGroupSelection,
  result: ModelGroupResolveResult | Pick<ModelGroupSwitchOffer, 'agentKind' | 'providerId' | 'model' | 'agentDeviceId'> | null,
): Promise<void> {
  if (result && 'outcome' in result) commitDeviceModelGroupDecision(deviceId, result);
  const route = !result ? null : 'outcome' in result ? (result.outcome === 'routed' ? result.route : null) : result;
  if (!route) return;
  await invoke(deviceId, MODEL_GROUPS_IPC.BIND_SESSION, [{
    sessionId,
    selection: modelGroupSelectionForOwner(selection),
    route: {
      agentKind: route.agentKind, providerId: route.providerId, model: route.model,
      ...(route.agentDeviceId ? { agentDeviceId: route.agentDeviceId } : {}),
    },
  }]).catch((err: unknown) => log.warn('device model group binding failed', err));
}

export async function unbindDeviceModelGroupSession(deviceId: string, sessionId: string): Promise<boolean> {
  try {
    const reply = await invoke<{ ok?: boolean; unbound?: boolean }>(deviceId, MODEL_GROUPS_IPC.UNBIND_SESSION, [{ sessionId }]);
    return reply?.unbound === true;
  } catch (err) {
    log.warn('device model group unbind failed', err);
    return false;
  }
}

export async function getDeviceModelGroupSessionBinding(
  deviceId: string,
  sessionId: string,
): Promise<ModelGroupSessionBindingView | null> {
  try {
    const reply = await invoke<ModelGroupSessionBindingView | null>(deviceId, MODEL_GROUPS_IPC.GET_SESSION_BINDING, [{ sessionId }]);
    return reply && typeof reply === 'object' ? reply : null;
  } catch (err) {
    log.warn('device model group session binding read failed', err);
    return null;
  }
}

export async function getDeviceModelGroupSwitchOffer(
  deviceId: string,
  sessionId: string,
): Promise<ModelGroupSwitchOffer | null> {
  try {
    const reply = await invoke<ModelGroupSwitchOffer | null>(deviceId, MODEL_GROUPS_IPC.SWITCH_OFFER, [{ sessionId }]);
    return reply && typeof reply === 'object' ? reply : null;
  } catch (err) {
    log.warn('device model group switch offer unavailable', err);
    return null;
  }
}

/** 请那台电脑在任务里写那一行说明；文字由这一端按自己的语言写好。 */
export function writeDeviceModelGroupRouteNote(deviceId: string, sessionId: string, note: ModelGroupRouteNote | null): void {
  if (!note) return;
  void invoke(deviceId, MODEL_GROUPS_IPC.ROUTE_NOTE, [{ sessionId, note }])
    .catch((err: unknown) => log.warn('device model group route note failed', err));
}
