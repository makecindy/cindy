/**
 * 另一台电脑的模型组(model-groups.md §6.3)：远程控制那台电脑、或在本机选择器「其他电脑」那一段时，
 * 列出那台电脑自己的模式，选路、提交记录、记绑定与写说明都由那台电脑做。
 *
 * 读取按需：选择器打开时每台电脑读一次，15 秒内再打开复用上次的答案；不轮询。那台电脑是旧版本
 * (CHANNEL_NOT_ALLOWED)时记为不支持，不再问，直到它重连或下次换账号。
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';

import {
  MODEL_GROUPS_IPC,
  modelGroupSelectionForOwner,
  normalizeModelGroupsConfig,
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupRouteNote,
  type ModelGroupSelection,
  type ModelGroupsConfig,
} from '../../../shared/modelGroups';

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
  if (extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('CHANNEL_NOT_ALLOWED');
}

function invoke<T>(deviceId: string, channel: string, args: unknown[]): Promise<T> {
  const api = window.electronAPI?.deviceLink;
  if (!api?.invoke) return Promise.reject(new Error('device link unavailable'));
  return api.invoke(deviceId, channel, args) as Promise<T>;
}

function deviceGroups(owner: DataOwnerGeneration, deviceId: string): DeviceGroups {
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
      if (!isDataOwnerGenerationCurrent(owner) || isSharedTaskPeer(deviceId)) return Promise.resolve();
      if (pending) return pending;
      if (current.unsupported && !force) return Promise.resolve();
      if (!force && readAt > 0 && Date.now() - readAt < DEVICE_MODEL_GROUPS_REREAD_MS) return Promise.resolve();
      const readGeneration = generation;
      readAt = Date.now();
      const run = invoke<unknown>(deviceId, MODEL_GROUPS_IPC.GET, [])
        .then((reply) => {
          if (!isDataOwnerGenerationCurrent(owner) || readGeneration !== generation) return;
          const config = normalizeModelGroupsConfig(reply);
          if (current.config && JSON.stringify(current.config) === JSON.stringify(config)) return;
          publish({ config, unsupported: false });
        })
        // 连不上时保留上一次的答案；旧版本记为不支持。
        .catch((error: unknown) => {
          if (!isDataOwnerGenerationCurrent(owner) || readGeneration !== generation) return;
          if (isModelGroupsUnsupportedError(error)) publish({ config: null, unsupported: true });
          else log.warn('device model groups unavailable', error);
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
      publish(UNREAD);
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
  devicesByOwner = new WeakMap();
}

function subscribeNone(): () => void {
  return () => undefined;
}

function unread(): DeviceModelGroupsSnapshot {
  return UNREAD;
}

/** 一台电脑的模式(远程控制那台时用)；readOnEntry 时挂载即读一次。 */
export function useDeviceModelGroups(deviceId: string | null | undefined, readOnEntry = false): DeviceModelGroupsSnapshot & { read: () => void } {
  const owner = getDataOwnerGeneration();
  const entry = useMemo(() => (deviceId ? deviceGroups(owner, deviceId) : null), [owner, deviceId]);
  const read = useCallback(() => { void entry?.read(); }, [entry]);
  useEffect(() => { if (readOnEntry) read(); }, [readOnEntry, read]);
  const snapshot = useSyncExternalStore(entry?.subscribe ?? subscribeNone, entry?.snapshot ?? unread, unread);
  return { ...snapshot, read };
}

/** 几台电脑的模式(本机选择器「其他电脑」那几段)；选择器打开时调用 read()。 */
export function useDevicesModelGroups(deviceIds: readonly string[]): {
  groups: ReadonlyMap<string, DeviceModelGroupsSnapshot>;
  read: () => void;
} {
  const owner = getDataOwnerGeneration();
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
): Promise<ModelGroupResolveResult | null> {
  try {
    const request: ModelGroupResolveRequest = {
      selection: modelGroupSelectionForOwner(selection),
      ...(context ? { context } : {}),
      ...(location ? { location } : {}),
    };
    return await invoke<ModelGroupResolveResult>(deviceId, MODEL_GROUPS_IPC.RESOLVE, [request]);
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
  result: ModelGroupResolveResult | null,
): Promise<void> {
  commitDeviceModelGroupDecision(deviceId, result);
  if (result?.outcome !== 'routed') return;
  const { route } = result;
  await invoke(deviceId, MODEL_GROUPS_IPC.BIND_SESSION, [{
    sessionId,
    selection: modelGroupSelectionForOwner(selection),
    route: {
      agentKind: route.agentKind, providerId: route.providerId, model: route.model,
      ...(route.agentDeviceId ? { agentDeviceId: route.agentDeviceId } : {}),
    },
  }]).catch((err: unknown) => log.warn('device model group binding failed', err));
}

/** 请那台电脑在任务里写那一行说明；文字由这一端按自己的语言写好。 */
export function writeDeviceModelGroupRouteNote(deviceId: string, sessionId: string, note: ModelGroupRouteNote | null): void {
  if (!note) return;
  void invoke(deviceId, MODEL_GROUPS_IPC.ROUTE_NOTE, [{ sessionId, note }])
    .catch((err: unknown) => log.warn('device model group route note failed', err));
}
