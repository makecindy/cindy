/**
 * recentModels —— 统一模型选择器的「最近」视图存储(model-selector-unified §1.2):
 * 用户在**对话**里用过的**配置副本**(模型 + 引擎 + 深度 + Fast),按最近一次使用时间倒序。
 *
 * 语义边界:
 *   - 收藏是**用户钉住**的配置副本(手动添加 / 删除,长期保留);
 *   - 最近是**自动记录**的配置副本(选择成功即记录,超出容量自动淘汰)。
 *   两者是同一套「配置副本」语义(归一化 / 身份规则共用 modelConfigCopy),所以:
 *   - 同一模型用不同深度 / 引擎 / Fast 各占**一行**(和收藏一致,不是按模型去重);
 *   - 星标(面板绘制)按**完全一致的副本**匹配收藏 —— 该条副本已在收藏里就点亮,
 *     没有则点星把这份副本存进收藏;匹配与去重都走同一份身份(modelConfigCopyIdentity)。
 *   与收藏的区别只在生命周期与入口:最近不能手动编辑(它是流水账,不是用户整理的清单),
 *   由记录点自动写入、超过容量自动淘汰。
 *
 * 记录点只有一个:对话入口里「选择真的应用成功」的那一下(useUnifiedRowActions.selectRow;
 * 草稿 / 会话 / 跨引擎三条链路都在那里收口),记的是**那一刻生效的整份配置**。
 * 定时任务、IM 默认、Bot、Hook、Worker、子代理与设置页共用的同一面板**不记**(那些是配置
 * 动作,不是「用这个模型跑过活」);远程(SSH / device-link)会话与草稿也不记:模型来自被控端
 * 目录,写进本机列表只会得到一行永远不可路由的记录(与「远程模型不写入本机记忆」同向)。
 *
 * 持久化:localStorage,owner 分区(与 modelFavorites / modelEnginePrefs 同形)。写频率极低
 * (用户选一次模型写一次),**同步写** —— 热更 relaunch 走 app.exit() 强退,异步写会丢最近
 * 一次改动。写失败静默吞,内存态照常生效。
 *
 * 并发写(多窗口):沿用 storageOpReplay 的「同步乐观写 + 会话 op-log + 事件驱动的持续调和」
 * (机制正文在那个文件头,那里是唯一权威)。这里只记本 store 的落地方式:
 *   - 每个写入表达成一个可重放的 op(`record`:一次「这份配置在此时被用过」的断言);
 *   - `applyOp(state, op)` 按副本身份取 max(usedAt) 并入,无变化时返回原对象;
 *   - 整条 log 的重放要保持幂等:`compactRecentOps` 把同一副本身份的历史 op 折成一条,
 *     否则重放会拿旧 usedAt 去顶掉后来的记录;
 *   - 没有删除类 op(用户不能「删掉最近用过」),所以不设 tombstone。
 *   与收藏相比残余边界更温和:即使调和完全失效,最坏也只是少一条快捷方式,不丢用户手存的数据。
 */

import { useSyncExternalStore } from 'react';

import {
  modelConfigCopyIdentity,
  normalizeModelConfigCopy,
  type ModelConfigCopy,
} from './modelConfigCopy';
import { createStorageReconciler } from './storageOpReplay';

const STORAGE_KEY = 'xdt:recentModels:v1';

/**
 * 本机保留的流水条数。刻意大于展示条数:最近几条恰好指向不可路由的模型(来源断开 / 目录
 * 下架)时,面板能往后补足 5 条,而不是显示成「最近只用过 2 个」。
 */
export const RECENT_MODELS_KEEP = 20;

/** 落盘 / 消费的一条记录:配置副本 + 最近一次使用时间。 */
export interface RecentModelItem extends ModelConfigCopy {
  /** 最近一次使用时间(epoch ms);排序与跨窗口合并都以它为准。 */
  usedAt: number;
}

interface RecentModelsState {
  /** 按 usedAt 倒序。 */
  items: RecentModelItem[];
}

let activeDataOwnerId: string | null = null;

function storageKey(): string {
  return activeDataOwnerId ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}` : STORAGE_KEY;
}

function emptyState(): RecentModelsState {
  return { items: [] };
}

/**
 * 严格校验一条记录:配置字段走与收藏同一套归一化(见 modelConfigCopy),时间不合法 → null。
 * 模型身份或引擎不合法整条丢弃;effort 非法只丢该字段。
 */
function normalizeItem(raw: {
  providerId?: unknown;
  modelId?: unknown;
  agent?: unknown;
  effort?: unknown;
  fast?: unknown;
  usedAt?: unknown;
}): RecentModelItem | null {
  const config = normalizeModelConfigCopy(raw);
  if (!config) return null;
  if (typeof raw.usedAt !== 'number' || !Number.isFinite(raw.usedAt) || raw.usedAt <= 0) {
    return null;
  }
  return { ...config, usedAt: raw.usedAt };
}

/**
 * 严格校验 + 归一化。老版本 / 手改 localStorage 损坏时静默回退空表,不抛。
 *   - 形状非法的条目整条丢弃;
 *   - 同一**副本身份**出现多条时只保 usedAt 最新的那条;
 *   - 按 usedAt 倒序,并裁到 RECENT_MODELS_KEEP 条。
 */
function sanitize(raw: unknown): RecentModelsState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const rawItems = Array.isArray((raw as { items?: unknown }).items)
    ? ((raw as { items: unknown[] }).items)
    : [];
  const byKey = new Map<string, RecentModelItem>();
  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = normalizeItem(entry as Record<string, unknown>);
    if (!item) continue;
    const key = modelConfigCopyIdentity(item);
    const existing = byKey.get(key);
    if (!existing || item.usedAt > existing.usedAt) byKey.set(key, item);
  }
  return {
    items: [...byKey.values()].sort((a, b) => b.usedAt - a.usedAt).slice(0, RECENT_MODELS_KEEP),
  };
}

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: RecentModelsState | null = null;

/**
 * 按**给定 key** 读原始 localStorage(不碰缓存)。key 可能不是当前 active 分区 ——
 * 登出 / 切号之后旧分区的调和仍要按它自己的 key 读写(机制见 storageOpReplay 文件头)。
 */
function loadFromKey(key: string): RecentModelsState {
  if (typeof window === 'undefined') return emptyState();
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? sanitize(JSON.parse(raw)) : emptyState();
  } catch {
    return emptyState();
  }
}

function loadFromStorage(): RecentModelsState {
  return loadFromKey(storageKey());
}

function load(): RecentModelsState {
  if (!cache) cache = loadFromStorage();
  return cache;
}

/**
 * **写路径的基底** —— 每次写入前重读 localStorage,拿到的是此刻的共享真相,而不是本窗口的
 * 内存快照(理由与 modelFavorites.freshState 逐字相同:storage 事件是异步的,整表写回用陈旧
 * 基底会抹掉另一窗口刚记的那条)。读不出来时退回内存缓存,不退回空表 —— 私密窗口 / 写满时
 * setItem 静默失败、getItem 恒 null,拿空表当基底会把本次会话已记的全部抹掉。
 */
function freshState(): RecentModelsState {
  if (typeof window === 'undefined') return load();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey());
  } catch {
    return load();
  }
  if (raw === null) return load();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return load();
  }
}

/** 两份状态在用户可见语义上是否一致(副本身份 + 时间 + 顺序)。 */
function sameState(a: RecentModelsState, b: RecentModelsState): boolean {
  return (
    a.items.length === b.items.length &&
    a.items.every((item, i) => {
      const other = b.items[i];
      return (
        other !== undefined &&
        modelConfigCopyIdentity(item) === modelConfigCopyIdentity(other) &&
        item.usedAt === other.usedAt
      );
    })
  );
}

// ── 可重放的写操作(见文件头「并发写」)────────────────────────────────────

/** 一次「这份配置在此时被用过」的断言。只依赖自身 + 目标状态,重放才成立。 */
type RecentModelsOp = RecentModelItem;

/**
 * 把一条记录并入状态:同副本身份取 max(usedAt),移到队首,按时间倒序并裁剪。
 * **无实际变化时返回入参对象本身**(引用判等决定要不要落盘 / 这一轮是否真的断言了什么)。
 */
function applyOp(state: RecentModelsState, op: RecentModelsOp): RecentModelsState {
  const item = normalizeItem(op);
  if (!item) return state;
  const key = modelConfigCopyIdentity(item);
  const existing = state.items.find((entry) => modelConfigCopyIdentity(entry) === key);
  const usedAt = existing ? Math.max(existing.usedAt, item.usedAt) : item.usedAt;
  const rest = state.items.filter((entry) => modelConfigCopyIdentity(entry) !== key);
  const next: RecentModelsState = {
    items: [{ ...item, usedAt }, ...rest]
      .sort((a, b) => b.usedAt - a.usedAt)
      .slice(0, RECENT_MODELS_KEEP),
  };
  return sameState(state, next) ? state : next;
}

/**
 * op-log 的归并:同一副本身份的历史 op 折成一条 —— 否则整条 log 重放时,先录的旧 usedAt
 * 会被再次并入(虽然取 max 不会把时间改小,但会让「这次记录」在 log 里出现两遍,
 * 无谓地占用 TTL / 断言次数)。
 * 时间更旧的 op(时钟回拨 / 跨窗口乱序)直接放弃:重放不能把已有记录的时间往回拧。
 */
function compactRecentOps(
  log: readonly RecentModelsOp[],
  op: RecentModelsOp,
): readonly RecentModelsOp[] {
  const key = modelConfigCopyIdentity(op);
  const existing = log.find((entry) => modelConfigCopyIdentity(entry) === key);
  if (existing && existing.usedAt > op.usedAt) return log;
  return [...log.filter((entry) => modelConfigCopyIdentity(entry) !== key), op];
}

const reconciler = createStorageReconciler<RecentModelsState, RecentModelsOp>({
  // active 分区走 freshState(带「读不出来就退回内存缓存」的兜底);其它分区(登出 / 切号后的
  // 旧 key)按 key 直读。
  read: (key) => (key === storageKey() ? freshState() : loadFromKey(key)),
  apply: applyOp,
  persist: (key, state) => persistTo(key, state),
  adopt: (key, state) => {
    if (key !== storageKey()) return;
    if (sameState(cache ?? emptyState(), state)) return;
    cache = state;
    emit();
  },
  compact: compactRecentOps,
});

/**
 * 一次写入 = **同步乐观写**(热更强退不丢)+ 把 op 记进**当时那个 key** 的会话 op-log 并调度
 * 一次锁内调和。owner 随后被切走也不放弃调和 —— 调和按捕获的 key 自洽运行。
 */
function commitOp(op: RecentModelsOp): void {
  const base = freshState();
  const next = applyOp(base, op);
  if (next !== base) persist(next);
  const key = storageKey();
  reconciler.record(key, op);
  reconciler.schedule(key);
}

// ── 订阅(供 useSyncExternalStore)──────────────────────────────────────────
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * 落盘到**指定 key**。缓存与通知只在该 key 恰是当前 active 分区时才做(调和可能发生在
 * 登出 / 切号之后的旧分区上)。
 */
function persistTo(key: string, next: RecentModelsState): void {
  if (typeof window !== 'undefined') {
    try {
      // 同步写:见文件头(热更 relaunch 走 app.exit() 强退)。
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // localStorage 满 / 私密窗口禁写 —— 静默吞,内存态仍生效。
    }
  }
  if (key !== storageKey()) return;
  cache = next;
  emit();
}

function persist(next: RecentModelsState): void {
  persistTo(storageKey(), next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getItemsSnapshot(): readonly RecentModelItem[] {
  return load().items;
}

const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
  /** 本 owner 分区的内存态跟外来写入对齐(重读真相,不采信 event.newValue)。 */
  const refreshActive = (): void => {
    const next = loadFromStorage();
    if (sameState(cache ?? emptyState(), next)) return;
    cache = next;
    emit();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    // key === null 表示 storage.clear():本分区刷新,并让所有还有 op-log 的分区各自调和。
    if (event.key === null) {
      refreshActive();
      for (const key of reconciler.loggedKeys()) reconciler.schedule(key);
      return;
    }
    if (event.key === storageKey()) {
      refreshActive();
      // 外来写入可能正是「别窗用旧基底做的迟到覆盖」,抹掉了本窗刚记的 op:
      // 在锁内把本分区的整条 op-log 重新断言一遍,无差异即终止。
      reconciler.schedule(event.key);
      return;
    }
    // 非 active 分区:只要 op-log 里还有它的记录就照样调和。
    if (reconciler.hasOps(event.key)) reconciler.schedule(event.key);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
})();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeStorageListener?.();
  });
}

/** 读全部记录(usedAt 倒序,含当前不可路由的条目 —— 过滤是面板的事)。数组视为只读。 */
export function listRecentModels(): readonly RecentModelItem[] {
  return getItemsSnapshot();
}

/**
 * 记一次「用了这份配置」。非法入参静默 no-op(与收藏同一条防线)。
 * `now` 只给测试注入用:生产路径一律取当前时刻。
 */
export function recordRecentModel(config: ModelConfigCopy, now: number = Date.now()): void {
  const item = normalizeItem({ ...config, usedAt: now });
  if (!item) return;
  commitOp(item);
}

/** 订阅变更(非 React 调用方)。 */
export function subscribeRecentModels(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * React hook —— 记录列表快照。数组身份只在真正写入 / 跨窗口同步时变化,
 * 可直接进 useMemo 依赖(useSyncExternalStore 保证 StrictMode 双 render 安全)。
 */
export function useRecentModels(): readonly RecentModelItem[] {
  return useSyncExternalStore(subscribe, getItemsSnapshot, getItemsSnapshot);
}

/** 随当前数据归属账号切换持久化命名空间(与 setModelFavoritesOwner 同形)。 */
export function setRecentModelsOwner(ownerId: string | null): void {
  const normalized = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  if (activeDataOwnerId === normalized) return;
  activeDataOwnerId = normalized;
  cache = null;
  emit();
}

/** 测试用 —— 重置缓存 / owner / 订阅者 / op-log + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  const keyBeforeReset = storageKey();
  cache = null;
  listeners.clear();
  reconciler.__resetForTest();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(keyBeforeReset);
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  activeDataOwnerId = null;
}

export const __STORAGE_KEY = STORAGE_KEY;
