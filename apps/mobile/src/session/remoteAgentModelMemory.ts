/**
 * remoteAgentModelMemory —— 手机上为「另一台电脑」的模型单独记的 effort / Fast。
 *
 * 对位桌面 agentDeviceModelMemory:远程目录的来源 id 和被控电脑自己的不是同一个账号,
 * 写进 draftModelMemory / 会话镜像会串到本机任务,也会在快照里被当成被控电脑的预设。
 * 这里只存在手机上,按账号 + 远程电脑 + agent + 来源 + 模型分桶;没有记录就跟随那台
 * 目录的当前推荐,「恢复推荐」删掉对应键。
 *
 * 读是同步内存缓存(hydrate 之后可用),写是同步改缓存再排队落盘。落盘失败只影响下次
 * 冷启动,这次打开里的选择仍然在。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { getMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { AgentKind } from '@cindy/model-providers/types';

import type { MobileModelMemoryAccessors } from './draftModelMemory';

const STORAGE_KEY = 'xdtm:remoteAgentModelMemory:v1';

interface Slot {
  effortByModel: Record<string, string>;
  fastByModel: Record<string, boolean | 'ultrafast'>;
}

type MemoryMap = Record<string, Record<string, Slot>>;

interface Bucket {
  data: MemoryMap;
  /** 尚未灌入磁盘快照时删过的键。hydrate 用它盖掉磁盘上的旧值。 */
  tombstones: Set<string>;
  hydrated: boolean;
}

const buckets = new Map<string, Bucket>();
const accessorsByDevice = new Map<string, MobileModelMemoryAccessors>();

let writeChain: Promise<void> = Promise.resolve();
let epoch = 0;

const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

/** 记忆变更时让模型行重算。hydrate 没改变缓存时不通知。 */
export function useRemoteAgentModelMemoryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

function storageKey(account: string): string {
  return account ? `${STORAGE_KEY}:${encodeURIComponent(account)}` : STORAGE_KEY;
}

function accountNow(): string {
  return getMobileAuthOwner().accountKey;
}

function bucketFor(account: string): Bucket {
  let bucket = buckets.get(account);
  if (!bucket) {
    bucket = { data: {}, tombstones: new Set(), hydrated: false };
    buckets.set(account, bucket);
  }
  return bucket;
}

function slotKey(agent: AgentKind, providerId: string): string {
  return `${agent}:${providerId}`;
}

function tombstoneId(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  field: 'effort' | 'fast',
  modelId: string,
): string {
  return `${deviceId}\0${slotKey(agent, providerId)}\0${field}\0${modelId}`;
}

function isEmptySlot(slot: Slot): boolean {
  return Object.keys(slot.effortByModel).length === 0 && Object.keys(slot.fastByModel).length === 0;
}

function prune(map: MemoryMap): MemoryMap {
  const out: MemoryMap = {};
  for (const [deviceId, slots] of Object.entries(map)) {
    if (!deviceId) continue;
    const nextSlots: Record<string, Slot> = {};
    for (const [key, slot] of Object.entries(slots)) {
      if (key && !isEmptySlot(slot)) nextSlots[key] = slot;
    }
    if (Object.keys(nextSlots).length > 0) out[deviceId] = nextSlots;
  }
  return out;
}

function sanitize(raw: unknown): MemoryMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: MemoryMap = {};
  for (const [deviceId, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (!deviceId || !slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
    const nextSlots: Record<string, Slot> = {};
    for (const [key, value] of Object.entries(slots as Record<string, unknown>)) {
      if (!key || !value || typeof value !== 'object') continue;
      const record = value as { effortByModel?: unknown; fastByModel?: unknown };
      const effortByModel: Record<string, string> = {};
      if (record.effortByModel && typeof record.effortByModel === 'object' && !Array.isArray(record.effortByModel)) {
        for (const [modelId, effort] of Object.entries(record.effortByModel as Record<string, unknown>)) {
          if (modelId && typeof effort === 'string' && effort.length > 0) effortByModel[modelId] = effort;
        }
      }
      const fastByModel: Record<string, boolean | 'ultrafast'> = {};
      if (record.fastByModel && typeof record.fastByModel === 'object' && !Array.isArray(record.fastByModel)) {
        for (const [modelId, fast] of Object.entries(record.fastByModel as Record<string, unknown>)) {
          if (modelId && (typeof fast === 'boolean' || fast === 'ultrafast')) fastByModel[modelId] = fast;
        }
      }
      if (Object.keys(effortByModel).length === 0 && Object.keys(fastByModel).length === 0) continue;
      nextSlots[key] = { effortByModel, fastByModel };
    }
    if (Object.keys(nextSlots).length > 0) out[deviceId] = nextSlots;
  }
  return out;
}

function cloneMap(map: MemoryMap): MemoryMap {
  return JSON.parse(JSON.stringify(map)) as MemoryMap;
}

/** 磁盘快照加上这次打开里已经改过、但还没和磁盘合并的写入与删除。 */
function overlay(disk: MemoryMap, patch: MemoryMap, deletes: ReadonlySet<string>): MemoryMap {
  const next = cloneMap(disk);
  for (const id of deletes) {
    const [deviceId, key, field, modelId] = id.split('\0');
    const slot = deviceId && key && modelId ? next[deviceId]?.[key] : undefined;
    if (!slot || (field !== 'effort' && field !== 'fast')) continue;
    delete slot[field === 'effort' ? 'effortByModel' : 'fastByModel'][modelId];
  }
  for (const [deviceId, slots] of Object.entries(patch)) {
    const device = (next[deviceId] ??= {});
    for (const [key, slot] of Object.entries(slots)) {
      const target = (device[key] ??= { effortByModel: {}, fastByModel: {} });
      Object.assign(target.effortByModel, slot.effortByModel);
      Object.assign(target.fastByModel, slot.fastByModel);
    }
  }
  return prune(next);
}

async function readDisk(account: string): Promise<MemoryMap> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(account));
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function enqueue(task: (ticket: number) => Promise<void>): void {
  const ticket = epoch;
  const run = writeChain.then(async () => {
    if (ticket !== epoch) return;
    await task(ticket);
  });
  writeChain = run.catch(() => undefined);
}

function publish(account: string, next: MemoryMap): void {
  const bucket = bucketFor(account);
  if (JSON.stringify(bucket.data) === JSON.stringify(next)) {
    bucket.data = next;
    return;
  }
  bucket.data = next;
  if (account === accountNow()) emit();
}

async function ensureHydrated(account: string, ticket: number): Promise<void> {
  const bucket = bucketFor(account);
  if (bucket.hydrated && bucket.tombstones.size === 0) return;
  const disk = await readDisk(account);
  if (ticket !== epoch) return;
  const current = bucketFor(account);
  publish(account, overlay(disk, current.data, current.tombstones));
  current.tombstones.clear();
  current.hydrated = true;
}

function persist(account: string): void {
  enqueue(async (ticket) => {
    await ensureHydrated(account, ticket);
    if (ticket !== epoch) return;
    try {
      await AsyncStorage.setItem(storageKey(account), JSON.stringify(bucketFor(account).data));
    } catch {
      // 磁盘满等只影响下次冷启动;内存里的选择这次仍然有效。
    }
  });
}

/** 把已落盘的远程档位灌进当前账号的内存缓存。重复调用安全。 */
export function hydrateRemoteAgentModelMemory(): Promise<void> {
  const account = accountNow();
  enqueue(async (ticket) => {
    await ensureHydrated(account, ticket);
  });
  return writeChain;
}

function slot(
  bucket: Bucket,
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  create: boolean,
): Slot | undefined {
  let slots = bucket.data[deviceId];
  if (!slots) {
    if (!create) return undefined;
    slots = {};
    bucket.data[deviceId] = slots;
  }
  const key = slotKey(agent, providerId);
  let value = slots[key];
  if (!value && create) {
    value = { effortByModel: {}, fastByModel: {} };
    slots[key] = value;
  }
  return value;
}

function dropEmpty(bucket: Bucket, deviceId: string, agent: AgentKind, providerId: string, value: Slot): void {
  if (!isEmptySlot(value)) return;
  const slots = bucket.data[deviceId];
  if (!slots) return;
  delete slots[slotKey(agent, providerId)];
  if (Object.keys(slots).length === 0) delete bucket.data[deviceId];
}

function located(deviceId: string, providerId: string, modelId: string): { account: string; bucket: Bucket } | null {
  if (!deviceId || !providerId || !modelId) return null;
  const account = accountNow();
  return { account, bucket: bucketFor(account) };
}

/** 某台远程电脑的档位读写器。空 deviceId 全部忽略。 */
export function remoteAgentModelMemoryFor(deviceId: string): MobileModelMemoryAccessors {
  let accessors = accessorsByDevice.get(deviceId);
  if (!accessors) {
    accessors = {
      getEffort: (agent, providerId, modelId) => {
        const place = located(deviceId, providerId, modelId);
        return place ? slot(place.bucket, deviceId, agent, providerId, false)?.effortByModel[modelId] : undefined;
      },
      setEffort: (agent, providerId, modelId, effort) => {
        const place = located(deviceId, providerId, modelId);
        if (!place || !effort) return;
        const value = slot(place.bucket, deviceId, agent, providerId, true)!;
        if (value.effortByModel[modelId] === effort) return;
        value.effortByModel[modelId] = effort;
        place.bucket.tombstones.delete(tombstoneId(deviceId, agent, providerId, 'effort', modelId));
        emit();
        persist(place.account);
      },
      clearEffort: (agent, providerId, modelId) => {
        clearField(deviceId, agent, providerId, modelId, 'effort');
      },
      getFast: (agent, providerId, modelId) => {
        const place = located(deviceId, providerId, modelId);
        return place ? slot(place.bucket, deviceId, agent, providerId, false)?.fastByModel[modelId] : undefined;
      },
      setFast: (agent, providerId, modelId, enabled) => {
        const place = located(deviceId, providerId, modelId);
        if (!place) return;
        const value = slot(place.bucket, deviceId, agent, providerId, true)!;
        if (value.fastByModel[modelId] === enabled) return;
        value.fastByModel[modelId] = enabled;
        place.bucket.tombstones.delete(tombstoneId(deviceId, agent, providerId, 'fast', modelId));
        emit();
        persist(place.account);
      },
      clearFast: (agent, providerId, modelId) => {
        clearField(deviceId, agent, providerId, modelId, 'fast');
      },
    };
    accessorsByDevice.set(deviceId, accessors);
  }
  return accessors;
}

function clearField(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  modelId: string,
  field: 'effort' | 'fast',
): void {
  const place = located(deviceId, providerId, modelId);
  if (!place) return;
  const id = tombstoneId(deviceId, agent, providerId, field, modelId);
  const value = slot(place.bucket, deviceId, agent, providerId, false);
  const record = field === 'effort' ? value?.effortByModel : value?.fastByModel;
  const had = record?.[modelId] !== undefined;
  if (!had && place.bucket.hydrated && !place.bucket.tombstones.has(id)) return;
  if (record) delete record[modelId];
  if (value) dropEmpty(place.bucket, deviceId, agent, providerId, value);
  place.bucket.tombstones.add(id);
  emit();
  persist(place.account);
}

/** 测试用:丢掉内存缓存,不清 AsyncStorage。进行中的落盘会被作废。 */
export function __resetForTest(): void {
  epoch += 1;
  buckets.clear();
  accessorsByDevice.clear();
  writeChain = Promise.resolve();
}

export function __flushForTest(): Promise<void> {
  return writeChain;
}

export function __storageKeyFor(account: string): string {
  return storageKey(account);
}

export const __STORAGE_KEY = STORAGE_KEY;
