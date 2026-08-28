/**
 * modelEnginePrefs —— 「(来源, 模型) → 用户显式选定的引擎(harness)」**override** 存储,
 * localStorage 持久化,跨会话 / 跨重启在本机生效。统一模型选择器(model-selector-unified
 * §2.3)的第五根轴。
 *
 * 背景:
 *   新选择器让用户**只选模型**,引擎由推荐映射自动配好(推荐 = 模型生效来源 provider 的
 *   主 root,纯客户端推导,见 M1 unifiedSelection)。用户在配置浮层里改引擎时,才在这里
 *   记一条 override;浮层的「恢复推荐」= 删这条 override,之后随版本跟随新的推荐映射。
 *
 * 只存 override(configuration-and-overrides.md §2/§4):
 *   - 表里**没有**某 (providerId, modelId) ⇒ 该模型跟随推荐引擎,不是「没有引擎」。
 *   - 因此绝不把推荐值快照写进来:那会把当前版本的默认固化成用户配置,服务端改推荐后
 *     未自定义的用户吃不到(三类用户行为见规格 §2.5:新用户 / 未自定义老用户 = 空表)。
 *   - 恢复推荐一律走 clearModelEngineOverride(删 key),不写「等于推荐值」的 override。
 *
 * 零迁移:
 *   本 store 是新增的独立轴,不合并、不改写四根旧轴(newMakerDraft.lastByVendor /
 *   modelChosenByVendor / providerModelMemory 的 `<agent>:*` 深度+Fast 槽 /
 *   modelVisibilityPrefs)。老用户空表即「全部跟随推荐」,旧数据不搬不猜。
 *
 * 为什么 agent 用 'cc' | 'codex' | 'pi'(SelectableVendor)而不是 useAgentCapabilities
 * 的 AgentKind('claude-code' | ...):
 *   本 store 的下游是**选择器 → newMakerDraft** 那条链路 —— 选中确定后要派生
 *   `(vendor, model, effort, fastMode, providerId)` 写进 newMakerDraft(规格 §2.4),而
 *   newMakerDraft / agentVendors / ChatInput 全线用的是 vendor 口径。存 vendor 可以让
 *   落盘值与写入 draft 的值同形,不必在持久层与消费层之间来回映射。需要 capabilities /
 *   catalog 那侧的 'claude-code' 口径时,在查能力的边界上转(仓内既有做法:
 *   modelDefinitions.agentKindForVendor)。
 *   校验直接复用 agentVendors.isSelectableVendor —— 与 newMakerDraft.sanitize 同一张表,
 *   将来新增引擎这里零改动(逐个写死三元的老写法每上线一个引擎都得手工补一次,漏补则
 *   用户选中新引擎、重启后被静默重置)。
 *
 * 持久化频率极低(仅用户在浮层点引擎胶囊触发),**同步写** localStorage,不做 batch /
 * debounce —— 与 newMakerDraft / providerModelMemory / modelVisibilityPrefs 的取舍一致:
 * release 的「热更新 → relaunch」路径走 app.exit() 强退,异步写(setTimeout / debounce)
 * 来不及 fire,最近一次改动会丢。写失败(localStorage 满 / 私密窗口禁写)静默吞,内存态
 * 照常生效,不把用户当次操作打断。
 *
 * 多窗口:Electron 每个 renderer 有独立模块实例,localStorage 是它们之间的共享真相。
 * 监听 storage 事件后**重读 localStorage**(而不是信事件里的 newValue)——迟到的事件带的
 * 是旧值,直接采信会把本窗口刚写的新值回滚(newMakerDraft 的 rebase 先例)。
 *
 * 并发写(2026-08-17 review H1 / K1 / K2)—— 与 modelFavorites **同一套机制**(共用
 * `storageOpReplay`,机制正文在那个文件的头注):写入表达成可重放且幂等的 op(set / clear),
 * 同步乐观写保持不变,op 同时记进**该 storage key 的会话 op-log**;随后在 `navigator.locks`
 * 里把**整条 log** 重放到该 key 此刻的真相上,并且**storage 事件也会再触发调和** —— 别窗用
 * 旧基底做的迟到覆盖抹掉本窗的 op 时,本窗收到事件后把它重新断言回去(K2),owner 被切走
 * 也照常按捕获的 key 调和(K1)。
 * 少了这一层,两个 renderer 同时改不同模型的引擎时,后写者会拿旧快照整表覆盖先写者
 * (对方那条 override 静默消失);「A 改引擎 + B 恢复推荐」交错时,A 的整表写还会把 B 已经
 * 删掉的那条 override 复活。锁不可用时跳过调和,行为退回改动前;op 的退休条件(TTL / 断言
 * 次数上界)与残余边界见 storageOpReplay.ts 文件头。
 *
 * 账号分区:key 带 dataOwnerId 后缀(setModelEnginePrefsOwner,与 newMakerDraft 同形),
 * 吸取 providerModelMemory 不分账号导致多账号串号的教训。
 */

import { useSyncExternalStore } from 'react';

import { isSelectableVendor, type SelectableVendor } from '@/lib/agentVendors';

import { MODEL_PRESET_SLOT_ID } from './providerModelMemory';
import { createStorageReconciler } from './storageOpReplay';

const STORAGE_KEY = 'xdt:modelEnginePrefs:v1';

/** 引擎 override 的取值域 = 用户可选引擎表(见文件头对口径的说明)。 */
export type ModelEngine = SelectableVendor;

/**
 * 单条 override。刻意用对象而不是裸字符串:规格预留了「同一 (来源, 模型) 上还要记别的
 * 用户显式选择」的可能(如智能模式落位),对象形状加字段时老数据天然兼容。
 */
export interface ModelEngineOverride {
  agent: ModelEngine;
}

/** 表:key=`${providerId}:${modelId}` → override。 */
type EnginePrefsMap = Record<string, ModelEngineOverride>;

let activeDataOwnerId: string | null = null;

function storageKey(): string {
  return activeDataOwnerId ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}` : STORAGE_KEY;
}

/**
 * key 组合与 providerModelMemory / modelVisibilityPrefs 同形(冒号拼接)。这里**只按
 * (providerId, modelId) 双参查表,从不反解 key**,所以 id 内含冒号也不会读错;不要新增
 * 依赖「split(':') 还原两段」的读法。
 */
function keyOf(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/**
 * `'*'` 是 providerModelMemory v2 schema 里的**保留来源 id**(同 agent 下跨真实 provider
 * 的模型级预设槽)。新代码读写路径都要防撞(规格 §4「偏好/记忆」),否则一条用 `'*'` 拼出
 * 的 key 会和真实来源的记录混在同一张表里,语义不可分辨。
 */
function isUsableProviderId(providerId: unknown): providerId is string {
  return (
    typeof providerId === 'string'
    && providerId.length > 0
    && providerId !== MODEL_PRESET_SLOT_ID
  );
}

/**
 * 严格校验:只保留 value 是 `{ agent: 可选引擎 }` 的条目;key 为空、value 形状不对、
 * 引擎不在 SELECTABLE_VENDORS(如历史残留的 'orca')的条目一律丢弃 —— 丢弃 = 该模型回到
 * 「跟随推荐」,是安全方向。老版本 / 手改 localStorage 损坏时静默回退空表,不抛。
 */
function sanitize(raw: unknown): EnginePrefsMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: EnginePrefsMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || !v || typeof v !== 'object') continue;
    const agent = (v as { agent?: unknown }).agent;
    if (!isSelectableVendor(agent)) continue;
    out[k] = { agent };
  }
  return out;
}

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: EnginePrefsMap | null = null;

/**
 * 按**给定 key** 读原始 localStorage(不碰缓存)。key 可能不是当前 active 分区 ——
 * 登出 / 切号之后旧分区的调和仍要按它自己的 key 读写(见文件头「并发写」)。
 */
function loadFromKey(key: string): EnginePrefsMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function loadFromStorage(): EnginePrefsMap {
  return loadFromKey(storageKey());
}

function load(): EnginePrefsMap {
  if (!cache) cache = loadFromStorage();
  return cache;
}

/**
 * **写路径的基底** —— 每次写入前重读 localStorage,拿此刻的共享真相当底,而不是本窗口的
 * 内存快照(与 modelFavorites 同一处理,同一理由)。
 *
 * `persist` 是整表写回:另一个窗口刚记下一条 override、`storage` 事件还没送到本窗口时,
 * 本窗口任何写入都会用陈旧整表覆盖回去,对方那条静默消失(用户看到的是「刚选的引擎又变
 * 回去了」)。读路径仍走缓存(读多写少,且陈旧一帧无害)。
 *
 * 读不到持久化值时退回内存缓存、不退回空表:私密窗口 / 写满时 `setItem` 静默失败(见
 * persist),`getItem` 恒 null —— 拿空表当基底会把本次会话内的全部 override 一次抹掉。
 */
function freshMap(): EnginePrefsMap {
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

/**
 * 两张表是否等价。storage 事件的「无变化短路」与并发重放的「有差异才写」共用这一份判据。
 */
function sameMap(a: EnginePrefsMap, b: EnginePrefsMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && bKeys.every((k) => a[k]?.agent === b[k]?.agent);
}

// ── 可重放的写操作(见文件头「并发写」)────────────────────────────────────

/** 一次写入的完整表达;只依赖 op 自身 + 目标表,能原样重放到最新状态上。 */
type EnginePrefsOp =
  | { kind: 'set'; key: string; agent: ModelEngine }
  | { kind: 'clear'; key: string };

/** 施加一个 op;**无实际变化时返回入参对象本身**(调用方按引用判等短路)。 */
function applyOp(map: EnginePrefsMap, op: EnginePrefsOp): EnginePrefsMap {
  if (op.kind === 'set') {
    // 幂等:同值(可能是本次同步写留下的,也可能是另一窗口写的)→ 原样返回。
    if (map[op.key]?.agent === op.agent) return map;
    return { ...map, [op.key]: { agent: op.agent } };
  }
  // 幂等:已经没有这条(如另一窗口先删了)→ 原样返回,不制造无意义落盘 / 通知。
  if (!(op.key in map)) return map;
  const next = { ...map };
  delete next[op.key];
  return next;
}

/**
 * 会话 op-log 的归并:同一条 key 上**只留最后一次显式选择**(set 或 clear)。
 * 这张表的每条 key 是各自独立的一维,历史 op 对它没有增量意义;不归并的话,重放会把用户
 * 在本会话里先后做的两次相反选择(改引擎 → 又恢复推荐)按顺序全断言一遍,结果虽仍是最后
 * 那次,却白写了一轮,也让 log 无谓膨胀。
 */
function compactEnginePrefsOps(
  log: readonly EnginePrefsOp[],
  op: EnginePrefsOp,
): readonly EnginePrefsOp[] {
  return [...log.filter((entry) => entry.key !== op.key), op];
}

const reconciler = createStorageReconciler<EnginePrefsMap, EnginePrefsOp>({
  // active 分区走 freshMap(带着「读不出来就退回内存缓存」的既有兜底);其它分区按 key 直读。
  read: (key) => (key === storageKey() ? freshMap() : loadFromKey(key)),
  apply: applyOp,
  persist: (key, state) => persistTo(key, state),
  adopt: (key, state) => {
    if (key !== storageKey()) return;
    if (sameMap(cache ?? {}, state)) return;
    cache = state;
    emit();
  },
  compact: compactEnginePrefsOps,
  // 「恢复推荐」(删 override)比 set 活得久:并发窗口内两窗做相反动作时让删除胜出
  // (见 storageOpReplay 文件头 —— 复活一条已被清掉的 override 是静默错误)。
  tombstone: (op) => op.kind === 'clear',
});

/**
 * 一次写入 = **同步乐观写**(热更强退不丢)+ 把 op 记进**当时那个 key** 的会话 op-log 并
 * 调度一次锁内调和。与 modelFavorites.commitOp 逐字同形(K1 / K2 的修复也同形)。
 */
function commitOp(op: EnginePrefsOp): void {
  const base = freshMap();
  const next = applyOp(base, op);
  if (next !== base) persist(next);
  const key = storageKey();
  reconciler.record(key, op);
  reconciler.schedule(key);
}

// ── 订阅 / 版本(供 useSyncExternalStore)──────────────────────────────────
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

/**
 * 落盘到**指定 key**。缓存与通知只在该 key 恰是当前 active 分区时才做 —— 调和可能发生在
 * 登出 / 切号之后的旧分区上,那时本窗口的内存态属于新分区,绝不能被旧分区的内容覆盖。
 */
function persistTo(key: string, next: EnginePrefsMap): void {
  if (typeof window !== 'undefined') {
    try {
      // 同步写:见文件头(热更 relaunch 走 app.exit(),异步写会丢最近一次改动)。
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // localStorage 满 / 私密窗口禁写 —— 静默吞,内存态仍生效。
    }
  }
  if (key !== storageKey()) return;
  cache = next;
  emit();
}

function persist(next: EnginePrefsMap): void {
  persistTo(storageKey(), next);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getVersion(): number {
  return version;
}

const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
  /** 本 owner 分区的内存态跟外来写入对齐(重读真相,不采信 event.newValue)。 */
  const refreshActive = (): void => {
    // 迟到的事件带旧值,直接写进内存会把本窗口刚保存的 override 回滚(newMakerDraft 同款 rebase)。
    const next = loadFromStorage();
    if (sameMap(cache ?? {}, next)) return;
    cache = next;
    emit();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    // key === null 表示 storage.clear():本分区刷新,并让**所有**还有 op-log 的分区各自调和。
    if (event.key === null) {
      refreshActive();
      for (const key of reconciler.loggedKeys()) reconciler.schedule(key);
      return;
    }
    if (event.key === storageKey()) {
      refreshActive();
      // 外来写入可能正是「别窗用旧基底做的迟到覆盖」,抹掉了本窗刚提交的 op(K2):
      // 在锁内把本分区的整条 op-log 重新断言一遍,无差异即终止。
      reconciler.schedule(event.key);
      return;
    }
    // 非 active 分区:只要 op-log 里还有它的记录就照样调和(K1),但不动本窗口的内存态。
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

/**
 * 读某 (来源, 模型) 的引擎 override。
 * `undefined` = **没有 override ⇒ 跟随推荐引擎**(调用方去查推荐映射),不是「无引擎」。
 */
export function getModelEngineOverride(
  providerId: string,
  modelId: string,
): ModelEngine | undefined {
  if (!isUsableProviderId(providerId) || !modelId) return undefined;
  return load()[keyOf(providerId, modelId)]?.agent;
}

/**
 * 写某 (来源, 模型) 的引擎 override(用户在配置浮层显式点了引擎胶囊)。
 * 同值短路;非法入参(空 id / 保留的 `'*'` 来源 / 未知引擎)静默忽略,不落脏数据。
 *
 * 注意:即便 agent 恰好等于当前推荐引擎,这里也照写 —— 「用户显式点过」本身是要记住的
 * 状态(推荐将来变了,他的显式选择不该被顶掉)。调用方若想表达「恢复跟随推荐」,必须调
 * clearModelEngineOverride。
 */
export function setModelEngineOverride(
  providerId: string,
  modelId: string,
  agent: ModelEngine,
): void {
  if (!isUsableProviderId(providerId) || !modelId || !isSelectableVendor(agent)) return;
  // 基底取**重读后的**持久化快照(见 freshMap):整表写回不能带着陈旧缓存,否则会抹掉
  // 另一个窗口刚写入、事件还没到达的 override。跨 renderer 的**并发**交错另由 commitOp
  // 的锁内重放收敛(见文件头「并发写」)。
  commitOp({ kind: 'set', key: keyOf(providerId, modelId), agent });
}

/**
 * 恢复推荐 = **删除该 override**(configuration-and-overrides §4),不是写一份推荐值快照。
 * 删完这个模型就重新跟随当前版本的推荐映射。无记录时短路,不做无意义落盘 / 通知。
 */
export function clearModelEngineOverride(providerId: string, modelId: string): void {
  if (!isUsableProviderId(providerId) || !modelId) return;
  commitOp({ kind: 'clear', key: keyOf(providerId, modelId) });
}

/** 该 (来源, 模型) 是否被用户自定义过 —— 行内三元组提亮 / 底栏「已自定义 · 恢复推荐」用。 */
export function hasModelEngineOverride(providerId: string, modelId: string): boolean {
  return getModelEngineOverride(providerId, modelId) !== undefined;
}

/** 当前账号是否存在任一显式 Harness 选择；用于旧草稿迁移时保护用户意图。 */
export function hasAnyModelEngineOverride(): boolean {
  return Object.keys(load()).length > 0;
}

/** 订阅引擎 override 变更(非 React 调用方)。 */
export function subscribeModelEnginePrefs(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * useSyncExternalStore 包装 —— 返回递增 version。组件把它当 useMemo 依赖,
 * override 变更(含其它窗口写入触发的 storage 事件)后自动重算。
 */
export function useModelEnginePrefsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/**
 * 随当前数据归属账号切换持久化命名空间(与 setNewMakerDraftOwner 同形)。
 * 切换后丢缓存重新惰性加载 —— 不同账号各读各的分区,不串号。
 */
export function setModelEnginePrefsOwner(ownerId: string | null): void {
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
  version = 0;
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
