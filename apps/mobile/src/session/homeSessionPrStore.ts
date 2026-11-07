import AsyncStorage from '@react-native-async-storage/async-storage';
import { remotePrStatuses, prStatusQuery } from '@cindy/maker-shared';
import { utf8ByteLength } from './mobileHomeListCache';
import {
  PR_STATUS_REFRESH_INTERVAL_MS,
  MAX_STATUS_QUERIES,
  prStatusKey,
  type PrStatusResult,
  type SessionPrRef,
} from '@cindy/maker-shared';

/**
 * 首页「任务信息 · PR 状态」的按任务缓存。
 *
 * 列表行会随滚动反复挂载 / 卸载,不能把结果放在行组件 state 里:那样每次回到视口都会闪一下
 * 空白并重新打两次远程调用。这里与桌面查看远程任务时的 PrRefsContext 同口径:
 *   - 只有勾选了 PR 的可见行才发起查询(挂载即查,卸载停刷新);
 *   - 每个任务先 `git-context:pr-refs:list` 取引用,再只查最新一条的状态
 *     (被控端会按该任务已有引用过滤,不能借这条通道查无关仓库);
 *   - 结果按 PR_STATUS_REFRESH_INTERVAL_MS 刷新,任务有更新时最快 10 秒重查一次。
 * 缓存键带账号代次,切账号后旧结果自然失效。
 *
 * 结果另按账号写进 AsyncStorage:App 被系统回收后重开,先显示上次的 PR 号和状态,
 * 连上电脑后照常在后台重查(读回的结果按已过期处理)。退出 / 切换账号时整体清掉。
 */
export interface HomeSessionPrInfo {
  ref: SessionPrRef;
  status: PrStatusResult | null;
  /** Glance includes the same bounded association list as the desktop PR menu. */
  additional?: HomeSessionPrInfo[];
}

type Invoke = <T>(deviceId: string, channel: string, args: unknown[]) => Promise<T>;

/** 写盘需要的归属:哪个账号的哪台电脑上的哪个任务。 */
export interface HomeSessionPrPersistTarget {
  scope: string;
  userId: string;
  deviceId: string;
  sessionId: string;
  related: boolean;
}

interface Entry {
  value: HomeSessionPrInfo | null;
  fetchedAt: number;
  refreshKey: string | undefined;
  inflight: boolean;
  /** 本次运行里有一次查询成功返回(含「没有 PR」)。查询失败留下的空值不算,读回仍可补上。 */
  confirmed?: boolean;
  persist?: HomeSessionPrPersistTarget;
}

const MIN_REFETCH_MS = 10_000;
/** 在途请求通常很快结束;任务有变化时至少隔这么久再补查一次。 */
const IN_FLIGHT_RETRY_MS = 1_000;
const MAX_ENTRIES = 300;
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

export function homeSessionPrCacheKey(scope: string, deviceId: string, sessionId: string, related = false): string {
  return JSON.stringify([scope, deviceId, sessionId]) + (related ? ':related' : '');
}

export function readHomeSessionPr(key: string): HomeSessionPrInfo | null {
  return entries.get(key)?.value ?? null;
}

export function subscribeHomeSessionPr(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/**
 * 按新鲜度决定是否发起加载;同一任务同时只有一个请求在途。所有刷新时机都走这里,分两档:
 *   - 例行(挂载、定时轮询):结果不足 PR_STATUS_REFRESH_INTERVAL_MS 时沿用缓存;
 *   - 事件(任务有更新即 refreshKey 变化,或 eventful:回到首页 / 回到前台):绕过上面的缓存期,
 *     只保留 MIN_REFETCH_MS 防抖;被在途请求或防抖挡住时返回多少毫秒后再调用即可补查。
 * 例行档被挡住返回 0(下一轮轮询自然会查)。
 */
export function refreshHomeSessionPr(
  key: string,
  load: (previous: HomeSessionPrInfo | null) => Promise<HomeSessionPrInfo | null>,
  options: { now: number; refreshKey?: string; eventful?: boolean; persist?: HomeSessionPrPersistTarget },
): number {
  const entry = entries.get(key);
  if (entry) {
    const age = options.now - entry.fetchedAt;
    const eventful = options.eventful === true || entry.refreshKey !== options.refreshKey;
    if (entry.inflight) return eventful ? Math.max(MIN_REFETCH_MS - age, IN_FLIGHT_RETRY_MS) : 0;
    if (age < (eventful ? MIN_REFETCH_MS : PR_STATUS_REFRESH_INTERVAL_MS)) {
      return eventful ? MIN_REFETCH_MS - age : 0;
    }
  }
  const next: Entry = {
    fetchedAt: options.now,
    inflight: true,
    refreshKey: options.refreshKey,
    value: entry?.value ?? null,
    persist: options.persist ?? entry?.persist,
    confirmed: entry?.confirmed,
  };
  entries.delete(key);
  entries.set(key, next);
  trimEntries();
  void load(next.value)
    .then((value) => {
      if (entries.get(key) !== next) return;
      // 读回的上次结果可能在本次查询在途时才种入(冷启动已在线),load 拿到的 previous 里没有它:
      // 状态查询失败的这一轮不能用 null 覆盖已读回的状态。
      next.value = keepKnownStatus(value, next.value);
      next.confirmed = true;
      if (next.persist) schedulePersist(next.persist.scope, next.persist.userId);
    })
    // 失败保留上次结果:网络抖动不该让已显示的 PR 号消失;下一个刷新周期再试。
    .catch(() => undefined)
    .finally(() => {
      next.inflight = false;
      listeners.get(key)?.forEach((listener) => listener());
    });
  return 0;
}

/** 同一 PR 这一轮没拿到状态时沿用已有状态(含 additional 里的各条);换了 PR 则不沿用。 */
function keepKnownStatus(value: HomeSessionPrInfo | null, known: HomeSessionPrInfo | null): HomeSessionPrInfo | null {
  if (!value || !known) return value;
  const knownRows = [known, ...(known.additional ?? [])];
  const fill = (row: HomeSessionPrInfo): HomeSessionPrInfo => {
    if (row.status) return row;
    const status = knownRows.find((item) => prStatusKey(item.ref) === prStatusKey(row.ref))?.status ?? null;
    return status ? { ...row, status } : row;
  };
  const filled = fill(value);
  if (!value.additional) return filled;
  return { ...filled, additional: value.additional.map(fill) };
}

export async function loadHomeSessionPr(
  invoke: Invoke,
  deviceId: string,
  sessionId: string,
  previous: HomeSessionPrInfo | null = null,
  includeRelated = false,
): Promise<HomeSessionPrInfo | null> {
  const refs = await invoke<unknown>(deviceId, 'git-context:pr-refs:list', [sessionId]);
  const ref = latestPrRef(refs);
  if (!ref) return null;
  // 状态查询失败只是这一轮没拿到,不是「状态未知」:同一 PR 沿用上次已知状态
  // (已合并 / 已关闭不该退回中性图标);换了 PR 才没有可沿用的状态。
  const previousRows = previous ? [previous, ...(previous.additional ?? [])] : [];
  const selected = includeRelated && Array.isArray(refs)
    ? (refs as SessionPrRef[]).filter(item => latestPrRef([item]) !== null).sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_STATUS_QUERIES)
    : [ref];
  const build = (statuses: unknown): HomeSessionPrInfo => {
    const rows = selected.map(item => {
      const carried = previousRows.find(row => prStatusKey(row.ref) === prStatusKey(item))?.status ?? null;
      const next = Array.isArray(statuses) ? (statuses as PrStatusResult[]).find(status => status && prStatusKey(status) === prStatusKey(item)) : null;
      return { ref: item, status: includeRelated ? (next?.ok ? next : carried ?? next ?? null) : next ?? carried };
    });
    return { ...rows[0], ...(includeRelated ? { additional: rows.slice(1) } : {}) };
  };
  let statuses: unknown;
  try {
    statuses = await remotePrStatuses(selected.map(prStatusQuery), sessionId, (channel, args) =>
      invoke(deviceId, channel, args),
    );
  } catch {
    return build(null);
  }
  return build(statuses);
}

/** 与桌面信息槽一致:只显示最近一次出现的 PR(lastSeenAt 最大)。 */
export function latestPrRef(value: unknown): SessionPrRef | null {
  if (!Array.isArray(value)) return null;
  let latest: SessionPrRef | null = null;
  for (const item of value as Partial<SessionPrRef>[]) {
    if (
      !item
      || typeof item.owner !== 'string'
      || typeof item.repo !== 'string'
      || typeof item.prNumber !== 'number'
      || !Number.isSafeInteger(item.prNumber)
      || item.prNumber <= 0
    ) continue;
    const ref = item as SessionPrRef;
    if (!latest || (ref.lastSeenAt ?? 0) > (latest.lastSeenAt ?? 0)) latest = ref;
  }
  return latest;
}

// ---- 本机持久化 ----

const STORAGE_KEY_PREFIX = 'cindy.mobile.homeSessionPr.v1.';
/** 首页一两屏的任务足够;再多冷启动也看不到,只占 AsyncStorage(Android 整库 6 MiB)。 */
export const MAX_PERSISTED_PR_ROWS = 200;
export const MAX_PERSISTED_PR_BYTES = 128 * 1024;
const PERSIST_DEBOUNCE_MS = 1_200;

interface StoredRow {
  deviceId: string;
  sessionId: string;
  related: boolean;
  value: HomeSessionPrInfo;
}

const hydrations = new Map<string, Promise<void>>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersist: { scope: string; userId: string } | null = null;
/** 清缓存时自增,作废已在途的读回与写盘,避免把上一账号的结果写回来。 */
let storageEpoch = 0;

function storageKeyForUser(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

/**
 * 读回该账号上次的结果,种进当前代次的内存缓存。同一代次只读一次;读不出或格式不对就当没有。
 * 种入的结果算作本次运行从未查过(fetchedAt=-Infinity),挂载后立即照常重查;已查到结果的任务不被旧值覆盖。
 */
export function hydrateHomeSessionPr(scope: string, userId: string): Promise<void> {
  if (!userId.trim()) return Promise.resolve();
  const hydrationKey = JSON.stringify([scope, userId]);
  const existing = hydrations.get(hydrationKey);
  if (existing) return existing;
  const epoch = storageEpoch;
  const task = AsyncStorage.getItem(storageKeyForUser(userId))
    .catch(() => null)
    .then((raw) => {
      if (!raw || epoch !== storageEpoch) return;
      // 存盘是从新到旧;倒序种入,让最近的任务排在 Map 末尾(trimEntries 从头淘汰)。
      for (const row of parseStoredRows(raw).reverse()) {
        const key = homeSessionPrCacheKey(scope, row.deviceId, row.sessionId, row.related);
        const entry = entries.get(key);
        // 已有结果(含查到「没有 PR」)以本次运行为准;首查还在途或失败过的任务才补上读回的结果。
        if (entry && (entry.value || entry.confirmed)) continue;
        const persist = { scope, userId, deviceId: row.deviceId, sessionId: row.sessionId, related: row.related };
        if (entry) {
          // 在途的首查还没回来:先显示上次结果,查到后照常覆盖;查询失败则保留它。
          entry.value = row.value;
          entry.persist ??= persist;
        } else {
          entries.set(key, { fetchedAt: Number.NEGATIVE_INFINITY, inflight: false, persist, refreshKey: undefined, value: row.value });
        }
        listeners.get(key)?.forEach((listener) => listener());
      }
      trimEntries();
    });
  hydrations.set(hydrationKey, task);
  return task;
}

function schedulePersist(scope: string, userId: string): void {
  pendingPersist = { scope, userId };
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const target = pendingPersist;
    pendingPersist = null;
    if (target) void writeSnapshot(target.scope, target.userId);
  }, PERSIST_DEBOUNCE_MS);
}

async function writeSnapshot(scope: string, userId: string): Promise<void> {
  const epoch = storageEpoch;
  // 读回先于写盘:否则冷启动后第一批结果会把还没读回的其他任务覆盖掉。
  await hydrations.get(JSON.stringify([scope, userId]));
  if (epoch !== storageEpoch) return;
  const rows: StoredRow[] = [];
  // Map 按最近使用排序,从新往旧取。
  for (const entry of [...entries.values()].reverse()) {
    const target = entry.persist;
    if (!entry.value || !target || target.scope !== scope || target.userId !== userId) continue;
    rows.push({ deviceId: target.deviceId, related: target.related, sessionId: target.sessionId, value: entry.value });
    if (rows.length >= MAX_PERSISTED_PR_ROWS) break;
  }
  const storageKey = storageKeyForUser(userId);
  let serialized = JSON.stringify({ version: 1, rows });
  while (utf8ByteLength(serialized) > MAX_PERSISTED_PR_BYTES && rows.length > 0) {
    rows.length = Math.floor(rows.length / 2);
    serialized = JSON.stringify({ version: 1, rows });
  }
  if (rows.length === 0) {
    await AsyncStorage.removeItem(storageKey).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(storageKey, serialized).catch(() => undefined);
  if (epoch !== storageEpoch) await AsyncStorage.removeItem(storageKey).catch(() => undefined);
}

/** 退出 / 切换账号:清掉所有账号的持久结果和内存缓存,并作废在途的读写。 */
export async function clearHomeSessionPrCache(): Promise<void> {
  storageEpoch += 1;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  pendingPersist = null;
  hydrations.clear();
  entries.clear();
  const keys = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
  const targets = keys.filter((key) => key.startsWith(STORAGE_KEY_PREFIX));
  if (targets.length > 0) await AsyncStorage.multiRemove(targets).catch(() => undefined);
}

function parseStoredRows(raw: string): StoredRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = isRecord(parsed) && Array.isArray(parsed.rows) ? parsed.rows : [];
  const out: StoredRow[] = [];
  for (const row of rows.slice(0, MAX_PERSISTED_PR_ROWS)) {
    if (!isRecord(row) || typeof row.deviceId !== 'string' || typeof row.sessionId !== 'string') continue;
    const value = parseStoredInfo(row.value, row.related === true);
    if (value) out.push({ deviceId: row.deviceId, related: row.related === true, sessionId: row.sessionId, value });
  }
  return out;
}

function parseStoredInfo(value: unknown, related: boolean): HomeSessionPrInfo | null {
  if (!isRecord(value)) return null;
  const ref = latestPrRef([value.ref]);
  if (!ref) return null;
  const status = isRecord(value.status) && typeof value.status.ok === 'boolean'
    ? value.status as unknown as PrStatusResult
    : null;
  if (!related) return { ref, status };
  const additional = Array.isArray(value.additional)
    ? value.additional.slice(0, MAX_STATUS_QUERIES).flatMap((item) => parseStoredInfo(item, false) ?? [])
    : [];
  return { additional, ref, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function trimEntries(): void {
  // Map 按插入序;刷新时重新插入,最早的就是最久未用的。
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

export const __testing = {
  reset(): void {
    entries.clear();
    listeners.clear();
    hydrations.clear();
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    pendingPersist = null;
  },
  storageKeyForUser,
};
