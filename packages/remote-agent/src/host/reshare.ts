/**
 * 供应商分享 · 转分享的同意(分享者这台电脑；docs/product-rules/provider-sharing.md §4.3)。
 *
 * 受邀者把这里分享出去的供应商加进了它自己的供应商组，又把那个组分享给了别人：组转来的受邀者任务要在这台
 * 运行，必须先由这台的主人逐人同意。受邀者的组所在电脑经远程 Agent 的 op `reshare` 把它分享的人整体报上来
 * (整体替换那台上一份)，新出现的人记成待处理；主人在「远程与分享」页同意或拒绝，之后随时可以撤回或改成同意。
 *
 * 记录按账号存在本机 `provider-share-reshare.json`，不经服务端：分享、成员与组所在电脑的设备 id、组所在电脑给的
 * 不透明键，以及它转述的昵称与头像(只用来让主人认出是谁)。成员被删除或退出时，删掉它名下的全部记录。
 */
import { randomUUID } from 'node:crypto';

import {
  REMOTE_AGENT_RELAY_KEY_PATTERN,
  REMOTE_AGENT_RESHARE_STATES,
  parseProviderSharePeer,
  type RemoteAgentReshareBatch,
  type RemoteAgentReshareEntry,
  type RemoteAgentReshareResult,
  type RemoteAgentReshareState,
} from '@cindy/device-link';



/** 组所在电脑(受邀者那台电脑)的身份：分享、成员与那台的设备 id(本地 peer key 里的三项)。 */
export interface ProviderShareResharePeer {
  shareId: string;
  memberId: string;
  deviceId: string;
}

export interface ProviderShareReshareRecord extends ProviderShareResharePeer {
  /** 本机给这条记录取的 id(管理页操作用)。 */
  id: string;
  /** 组所在电脑为它分享的那个人取的不透明键(打开中转任务时随载荷带来)。 */
  key: string;
  name: string;
  avatar: string | null;
  state: RemoteAgentReshareState;
  requestedAt: number;
  decidedAt?: number;
}

export interface ReshareFile {
  records: ProviderShareReshareRecord[];
}

/** 文件按字节设硬上限；人数不按固定条数截断，超限时原子写入失败并保留旧快照。 */
export const RESHARE_STORE_MAX_BYTES = 4 * 1024 * 1024;
/** 未收齐的分片只在内存保留一小段时间；新批次会替换同一组所在电脑的旧批次。 */
const RESHARE_BATCH_TTL_MS = 10 * 60_000;
/** 未完成批次按序列化后的条目字节数计入全局预算，避免多个来源共同耗尽主进程内存。 */
const RESHARE_BATCH_MEMORY_BUDGET_BYTES = 16 * 1024 * 1024;
const RESHARE_BATCH_METADATA_BYTES = 512;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const RECORD_ID = /^[0-9a-f-]{36}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

function avatar(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function normalizeRecord(raw: unknown): ProviderShareReshareRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const name = text(value.name, 128);
  if (
    typeof value.id !== 'string' || !RECORD_ID.test(value.id)
    || typeof value.shareId !== 'string' || !ID_PATTERN.test(value.shareId)
    || typeof value.memberId !== 'string' || !ID_PATTERN.test(value.memberId)
    || typeof value.deviceId !== 'string' || !ID_PATTERN.test(value.deviceId)
    || typeof value.key !== 'string' || !REMOTE_AGENT_RELAY_KEY_PATTERN.test(value.key)
    || !name
    || !(REMOTE_AGENT_RESHARE_STATES as readonly unknown[]).includes(value.state)
    || typeof value.requestedAt !== 'number' || !Number.isFinite(value.requestedAt)
  ) return null;
  return {
    id: value.id,
    shareId: value.shareId,
    memberId: value.memberId,
    deviceId: value.deviceId,
    key: value.key,
    name,
    avatar: avatar(value.avatar),
    state: value.state as RemoteAgentReshareState,
    requestedAt: value.requestedAt,
    ...(typeof value.decidedAt === 'number' && Number.isFinite(value.decidedAt) ? { decidedAt: value.decidedAt } : {}),
  };
}

function normalize(raw: unknown): ReshareFile {
  const source = (raw as Partial<ReshareFile> | null)?.records;
  if (!Array.isArray(source)) return { records: [] };
  const records: ProviderShareReshareRecord[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    const record = normalizeRecord(entry);
    if (!record) continue;
    const scope = `${scopeOf(record)}\0${record.key}`;
    if (seen.has(record.id) || seen.has(scope)) continue;
    seen.add(record.id);
    seen.add(scope);
    records.push(record);
  }
  return { records };
}

function scopeOf(peer: ProviderShareResharePeer): string {
  return `${peer.shareId}\0${peer.memberId}\0${peer.deviceId}`;
}

function samePeer(record: ProviderShareResharePeer, peer: ProviderShareResharePeer): boolean {
  return record.shareId === peer.shareId && record.memberId === peer.memberId && record.deviceId === peer.deviceId;
}


export interface ProviderShareReshareSyncResult {
  result: RemoteAgentReshareResult;
  /** 新出现、等主人处理的人。 */
  added: ProviderShareReshareRecord[];
  /** 组所在电脑不再报上来的人里已经同意过的(要结束他们经组转来的任务)。 */
  droppedApproved: ProviderShareReshareRecord[];
  /** 管理页可见的记录集合或展示字段发生变化。 */
  changed: boolean;
}
export interface ProviderShareReshareEvents {
  /** 新出现、等主人处理的人(待处理一栏与系统通知)。 */
  requested(records: readonly ProviderShareReshareRecord[]): void;
  /** 记录变了(管理页重读)。 */
  changed(): void;
  /** 这些人不再被同意(撤回、组所在电脑不再报上来)：结束他们经组转来的任务。 */
  revoked(records: readonly ProviderShareReshareRecord[]): void;
}
interface PendingReshareBatch {
  batch: RemoteAgentReshareBatch;
  chunks: Map<number, RemoteAgentReshareEntry[]>;
  bytes: number;
  touchedAt: number;
}
export { normalize as normalizeProviderShareReshareFile };
export interface ProviderShareReshareStore {
 invalidateIfChanged(): void;
 read(): ReshareFile;
 updateAtomic(update: (input: {value: ReshareFile}) => ReshareFile): Promise<ReshareFile>;
}
export function createProviderShareReshare(options: {store: ProviderShareReshareStore; guestAccess(controller: string): unknown}) {
const store=options.store;
const providerShareGuestAccess=options.guestAccess;
function read(): ProviderShareReshareRecord[] {
  store.invalidateIfChanged();
  return store.read().records;
}



/**
 * 组所在电脑报上它此刻分享的人(整体替换这台组所在电脑上一份)：已有的人保留主人的决定，只更新昵称与头像；
 * 新出现的人记成待处理；不再报上来的人删掉(那人已不在它的分享里，或那台已把这台移出组)。
 */
async function syncProviderShareReshare(
  peer: ProviderShareResharePeer,
  entries: readonly RemoteAgentReshareEntry[],
  now = Date.now(),
): Promise<ProviderShareReshareSyncResult> {
  const added: ProviderShareReshareRecord[] = [];
  const droppedApproved: ProviderShareReshareRecord[] = [];
  let changed = false;
  const next = await store.updateAtomic(({ value }) => {
    const wanted = new Map(entries.map((entry) => [entry.key, entry]));
    const records: ProviderShareReshareRecord[] = [];
    for (const record of value.records) {
      if (!samePeer(record, peer)) {
        records.push(record);
        continue;
      }
      const entry = wanted.get(record.key);
      if (!entry) {
        changed = true;
        if (record.state === 'approved') droppedApproved.push(record);
        continue;
      }
      wanted.delete(record.key);
      const nextRecord = { ...record, name: entry.name, avatar: entry.avatar ?? null };
      if (nextRecord.name !== record.name || nextRecord.avatar !== record.avatar) changed = true;
      records.push(nextRecord);
    }
    for (const entry of wanted.values()) {
      const record: ProviderShareReshareRecord = {
        id: randomUUID(),
        ...peer,
        key: entry.key,
        name: entry.name,
        avatar: entry.avatar ?? null,
        state: 'pending',
        requestedAt: now,
      };
      added.push(record);
      changed = true;
      records.push(record);
    }
    return { records };
  });
  const states = new Map(next.records.filter((record) => samePeer(record, peer)).map((record) => [record.key, record.state]));
  return {
    result: {
      entries: entries.flatMap((entry) => {
        const state = states.get(entry.key);
        return state ? [{ key: entry.key, state }] : [];
      }),
    },
    added,
    droppedApproved,
    changed,
  };
}

/** 组转来的受邀者任务能不能在这台运行：主人同意过这台组所在电脑报上来的这个人。 */
function isProviderShareReshareApproved(peer: ProviderShareResharePeer, key: string | undefined): boolean {
  if (!key) return false;
  return read().some((record) => samePeer(record, peer) && record.key === key && record.state === 'approved');
}

/** 主人同意或拒绝(拒绝已同意的 = 撤回)。返回改动后的记录与之前的状态；记录不在了返回 null。 */
async function decideProviderShareReshare(
  id: string,
  decision: 'approve' | 'reject',
  now = Date.now(),
  assertCurrent: () => void = () => undefined,
): Promise<{ record: ProviderShareReshareRecord; previous: RemoteAgentReshareState } | null> {
  assertCurrent();
  let changed: { record: ProviderShareReshareRecord; previous: RemoteAgentReshareState } | null = null;
  await store.updateAtomic(({ value }) => {
    assertCurrent();
    return {
      records: value.records.map((record) => {
        if (record.id !== id) return record;
        const next: ProviderShareReshareRecord = {
          ...record,
          state: decision === 'approve' ? 'approved' : 'rejected',
          decidedAt: now,
        };
        changed = { record: next, previous: record.state };
        return next;
      }),
    };
  });
  return changed;
}

function listProviderShareReshares(): readonly ProviderShareReshareRecord[] {
  return read();
}

/** 删掉匹配的记录(成员被删除或退出、分享已不在这台)。返回删掉的。 */
async function pruneProviderShareReshares(
  match: (record: ProviderShareReshareRecord) => boolean,
): Promise<ProviderShareReshareRecord[]> {
  if (!read().some(match)) return [];
  const removed: ProviderShareReshareRecord[] = [];
  await store.updateAtomic(({ value }) => ({
    records: value.records.filter((record) => {
      if (!match(record)) return true;
      removed.push(record);
      return false;
    }),
  }));
  return removed;
}

// ─── 远程 Agent op `reshare` 与本机接线 ─────────────────────────────



let events: ProviderShareReshareEvents | null = null;



const pendingBatches = new Map<string, PendingReshareBatch>();
const completedBatches = new Map<string, { batch: RemoteAgentReshareBatch; touchedAt: number }>();
/** 同一来源的片段按到达顺序处理，避免旧批次完成回写覆盖刚开始的新批次。 */
const reshareLocks = new Map<string, Promise<void>>();
let pendingBatchBytes = 0;

function entriesBytes(entries: readonly RemoteAgentReshareEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries), 'utf8');
}

function removePendingBatch(batchKey: string): void {
  const pending = pendingBatches.get(batchKey);
  if (!pending) return;
  pendingBatches.delete(batchKey);
  pendingBatchBytes -= pending.bytes + RESHARE_BATCH_METADATA_BYTES;
}

function pruneBatchState(now: number): void {
  for (const [batchKey, pending] of pendingBatches) {
    if (now - pending.touchedAt > RESHARE_BATCH_TTL_MS) removePendingBatch(batchKey);
  }
  for (const [batchKey, completed] of completedBatches) {
    if (now - completed.touchedAt > RESHARE_BATCH_TTL_MS) completedBatches.delete(batchKey);
  }
}

function sameEntries(left: readonly RemoteAgentReshareEntry[], right: readonly RemoteAgentReshareEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return !!other && entry.key === other.key && entry.name === other.name && entry.avatar === other.avatar;
  });
}

function provisionalStates(
  peer: ProviderShareResharePeer,
  entries: readonly RemoteAgentReshareEntry[],
): RemoteAgentReshareResult['entries'] {
  const states = new Map(read().filter((record) => samePeer(record, peer)).map((record) => [record.key, record.state]));
  return entries.map((entry) => ({ key: entry.key, state: states.get(entry.key) ?? 'pending' }));
}

/** providerShareRuntime 启动时接上，停止时清掉。 */
function setProviderShareReshareEvents(next: ProviderShareReshareEvents | null): void {
  events = next;
  if (!next) {
    pendingBatches.clear();
    completedBatches.clear();
    pendingBatchBytes = 0;
  }
}

/** 受邀者对端 → 组所在电脑的身份；不是受邀者返回 null。 */
function providerShareResharePeerOf(controller: string): ProviderShareResharePeer | null {
  const peer = parseProviderSharePeer(controller);
  return peer?.role === 'guest' ? { shareId: peer.shareId, memberId: peer.memberId, deviceId: peer.deviceId } : null;
}

/**
 * 远程 Agent 的 op `reshare`(调用方已按分享准入)：记下组所在电脑此刻分享的人，返回每个人的结果。
 * 只有受邀者能报，同账号电脑经组使用不需要同意。
 */
async function handleProviderShareReshareNow(
  controller: string,
  entries: readonly RemoteAgentReshareEntry[],
  batch?: RemoteAgentReshareBatch,
): Promise<RemoteAgentReshareResult> {
  const peer = providerShareResharePeerOf(controller);
  if (!peer || !providerShareGuestAccess(controller)) throw new Error('[REMOTE_AGENT_INVALID] reshare is only for shared users');
  if (batch) {
    const batchKey = scopeOf(peer);
    const now = Date.now();
    pruneBatchState(now);
    const completed = completedBatches.get(batchKey);
    if (completed && completed.batch.id === batch.id && completed.batch.count === batch.count) {
      // 完成后的重发只需重读当前条目的已落盘状态，避免再次替换或新增待处理记录。
      return { entries: provisionalStates(peer, entries), batch: { ...batch, complete: true } };
    }
    const previous = pendingBatches.get(batchKey);
    const expired = previous && now - previous.touchedAt > RESHARE_BATCH_TTL_MS;
    if (!previous || expired || previous.batch.id !== batch.id || previous.batch.count !== batch.count) {
      if (previous) removePendingBatch(batchKey);
      const firstChunkBytes = entriesBytes(entries);
      if (pendingBatchBytes + RESHARE_BATCH_METADATA_BYTES + firstChunkBytes > RESHARE_BATCH_MEMORY_BUDGET_BYTES) {
        throw new Error('[REMOTE_AGENT_BUSY] reshare batch memory budget exceeded');
      }
      pendingBatches.set(batchKey, { batch, chunks: new Map(), bytes: 0, touchedAt: now });
      pendingBatchBytes += RESHARE_BATCH_METADATA_BYTES;
    }
    const pending = pendingBatches.get(batchKey)!;
    pending.touchedAt = now;
    const existing = pending.chunks.get(batch.index);
    if (existing) {
      if (!sameEntries(existing, entries)) throw new Error('[REMOTE_AGENT_INVALID] conflicting duplicate reshare batch chunk');
    } else {
      const chunk = [...entries];
      const chunkBytes = entriesBytes(chunk);
      if (pendingBatchBytes + chunkBytes > RESHARE_BATCH_MEMORY_BUDGET_BYTES) {
        throw new Error('[REMOTE_AGENT_BUSY] reshare batch memory budget exceeded');
      }
      pending.chunks.set(batch.index, chunk);
      pending.bytes += chunkBytes;
      pendingBatchBytes += chunkBytes;
    }
    if (pending.chunks.size < pending.batch.count) {
      return { entries: provisionalStates(peer, entries), batch: { ...batch, complete: false } };
    }
    const allEntries: RemoteAgentReshareEntry[] = [];
    for (let index = 0; index < pending.batch.count; index += 1) {
      const chunk = pending.chunks.get(index);
      if (!chunk) return { entries: provisionalStates(peer, entries), batch: { ...batch, complete: false } };
      allEntries.push(...chunk);
    }
    if (new Set(allEntries.map((entry) => entry.key)).size !== allEntries.length) {
      removePendingBatch(batchKey);
      throw new Error('[REMOTE_AGENT_INVALID] duplicate reshare key across batch');
    }
    const synced = await syncProviderShareReshare(peer, allEntries);
    removePendingBatch(batchKey);
    completedBatches.set(batchKey, { batch, touchedAt: now });
    if (synced.droppedApproved.length > 0) events?.revoked(synced.droppedApproved);
    if (synced.added.length > 0) events?.requested(synced.added);
    else if (synced.changed) events?.changed();
    const states = new Map(synced.result.entries.map((entry) => [entry.key, entry.state]));
    return {
      entries: entries.flatMap((entry) => {
        const state = states.get(entry.key);
        return state ? [{ key: entry.key, state }] : [];
      }),
      batch: { ...batch, complete: true },
    };
  }
  const synced = await syncProviderShareReshare(peer, entries);
  if (synced.droppedApproved.length > 0) events?.revoked(synced.droppedApproved);
  if (synced.added.length > 0) events?.requested(synced.added);
  else if (synced.changed) events?.changed();
  return synced.result;
}

/** 同一来源上的并发片段必须串行，避免旧批次的慢落盘结果覆盖后到的新批次。 */
function handleProviderShareReshare(
  controller: string,
  entries: readonly RemoteAgentReshareEntry[],
  batch?: RemoteAgentReshareBatch,
): Promise<RemoteAgentReshareResult> {
  const peer = providerShareResharePeerOf(controller);
  if (!peer || !providerShareGuestAccess(controller)) {
    return Promise.reject(new Error('[REMOTE_AGENT_INVALID] reshare is only for shared users'));
  }
  const batchKey = scopeOf(peer);
  const previous = reshareLocks.get(batchKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  reshareLocks.set(batchKey, current);
  const run = previous.then(() => handleProviderShareReshareNow(controller, entries, batch));
  return run.finally(() => {
    release();
    if (reshareLocks.get(batchKey) === current) reshareLocks.delete(batchKey);
  });
}

/** 组转来的受邀者任务能不能在这台运行(远程 Agent 打开任务时核对)。 */
function providerShareReshareAllows(controller: string, key: string | undefined): boolean {
  const peer = providerShareResharePeerOf(controller);
  return !!peer && isProviderShareReshareApproved(peer, key);
}



return {syncProviderShareReshare, isProviderShareReshareApproved, decideProviderShareReshare, listProviderShareReshares, pruneProviderShareReshares, setProviderShareReshareEvents, providerShareResharePeerOf, handleProviderShareReshare, providerShareReshareAllows, __testing: {normalize}};
}
