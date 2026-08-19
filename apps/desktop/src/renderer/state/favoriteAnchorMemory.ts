/**
 * favoriteAnchorMemory —— 统一模型选择器里「**这次选中的是哪一条收藏副本**」的锚点记忆
 * (model-selector-unified §1.5),localStorage 持久化,按 dataOwnerId 分区。
 *
 * ## 为什么从内存态改成持久化(Chris 2026-08-19 实测反馈)
 *
 * 锚点原本是刻意的**渲染进程内存态**:草稿的挂在 NewMakerDraftRoute 上、会话的挂在
 * ChatInput 上,换会话 / 刷新即忘,理由是「它只是 UI 选中提示,不是用户数据,忘掉等价于
 * 从没选过收藏」。实测推翻了这条取舍:
 *
 *   「我明明选了收藏第 3 个,打开选单,默认焦点永远在下面不在收藏」
 *
 * 收藏区置顶,而模型行在下面 —— 锚点一忘,面板就回落到**模型行**打勾,自动对齐把列表滚到
 * 那一行,用户刚选的收藏被顶出可视区。也就是说这份「UI 选中提示」恰恰是用户判断「我现在
 * 用的是哪份配置」的唯一线索,忘掉不是无害降级,而是每次打开都在否认用户上一次的选择。
 *
 * 所以它现在与 modelFavorites / modelEnginePrefs 同待遇:同步写 localStorage、按 owner 分区、
 * 监听 storage 事件。**仍然不是用户配置**(它不描述「用什么模型」,只描述「勾哪一行」),
 * 因此:不进 device-link payload、不落库、丢了也只是回落模型行 —— 写失败一律静默吞。
 *
 * ## 两类槽
 *
 *   - **草稿槽**:按引擎(cc / codex / pi)各存一条。草稿的模型选择本来就按 vendor 分槽
 *     (newMakerDraft.lastByVendor),锚点跟着同一维度走,切引擎再切回来时勾的还是那一条。
 *   - **会话槽**:按 sessionId 存,附带选中那一刻的 (wire model id, 引擎, 显式来源) 快照。
 *     快照字段是**校验用**的:消费方(ChatInput.effectiveSelectedFavoriteUid)拿它与会话
 *     当前值逐项比对,对不上就不打勾 —— 持久化值过期(会话被别的路径换了模型)时宁可不勾,
 *     也不能勾一条早已不生效的配置。
 *
 * 会话槽按 **LRU 上限 100 条**收敛:锚点是「最近选过哪条收藏」的提示,老会话的那一条既不值
 * 钱也不该无限堆在 localStorage 里。「最近使用」按**写入**排序(数组头 = 最近一次写),不是
 * 插入序 —— 同一个会话再次选收藏会把它移回队首,不会被更早创建但一直没动过的会话挤掉。
 * 读取刻意**不**更新次序:读发生在 render 期(useSyncExternalStore 的 getSnapshot),在那里
 * 写 localStorage 既不纯粹也会引发额外重渲染。
 *
 * 同步写(不 debounce):与本目录其它 store 同一条取舍 —— 热更 relaunch 走 app.exit() 强退,
 * 异步写来不及 fire 会丢最近一次改动。
 *
 * 多窗口:监听 storage 事件后**重读 localStorage**,不采信 `event.newValue`(迟到事件带旧值,
 * 采信会把本窗口刚记下的锚点回滚 —— newMakerDraft / modelFavorites 的既有教训)。
 *
 * 并发写:刻意**不**上 storageOpReplay 那套 op-log 调和(modelFavorites / modelEnginePrefs 用
 * 的那一套)。那是为「不能丢的用户配置」准备的;锚点是可再生的 UI 提示,两个窗口同时选收藏时
 * 后写者整表覆盖先写者的代价 = 另一个窗口的面板少打一个勾,与它引入的机制复杂度不成正比。
 */

import { useSyncExternalStore } from 'react';

import { isSelectableVendor } from '@/lib/agentVendors';

import type { ModelEngine } from './modelEnginePrefs';

const STORAGE_KEY = 'xdt:favoriteAnchorMemory:v1';

/** 会话槽上限(LRU,超出淘汰最久未写的那条)。 */
const SESSION_SLOT_LIMIT = 100;

/** 草稿槽:草稿里存的是 wire model id,锚点快照与它同类可比(见文件头)。 */
export interface DraftFavoriteAnchor {
  uid: string;
  /** 选中时写进草稿的 **wire model id**(≠ 收藏条目里的归一化行 id)。 */
  wireModelId: string;
  /**
   * 选中时写进草稿的**显式来源**(2026-08-19 review P1:来源也是锚点身份的一部分)。
   * 同一 wire model 可来自多家供应商(收藏是**某一来源**那份配置的副本)——只比 wire id,
   * device-link seed / 另一窗口把草稿从来源 A 切到同 wire model 的来源 B 后,旧锚点会继续
   * 选中 A 的收藏并抑制 B 模型行的勾,之后编辑 / 删除的也是错误副本。面板行恒带显式来源,
   * 所以这里恒为 string(与会话槽同口径)。
   *
   * ★ 深度 / Fast **刻意不进锚点记录**(2026-08-19 review P2):锚点只存**身份**快照
   * (哪个 uid、指向哪个 wire model / 来源 / 引擎),配置维的等值校验放在消费点 ——
   * 统一面板派生 activeFavoriteUid 时用「该收藏当前副本的解析结果 vs 正在跑的完整配置」
   * 直接比(见 unifiedModelSelection.resolveActiveFavoriteAnchorUid)。把 effort/Fast 抄进
   * 锚点会造出第二份会过期的副本:编辑选中收藏的每条路径都得记得同步它,漏一处就把
   * 刚编辑完、本该保持选中的收藏误杀出勾选态。
   */
  providerId: string;
}

/** 会话槽:在草稿槽三维之上多带引擎维(草稿槽的引擎由槽键承担)。 */
export interface SessionFavoriteAnchor extends DraftFavoriteAnchor {
  engine: ModelEngine;
}

interface SessionSlot extends SessionFavoriteAnchor {
  sessionId: string;
}

interface AnchorState {
  /** 引擎 → 草稿锚点。 */
  drafts: Partial<Record<ModelEngine, DraftFavoriteAnchor>>;
  /** 会话锚点,**队首 = 最近一次写**(LRU 次序即数组次序,见文件头)。 */
  sessions: SessionSlot[];
}

let activeDataOwnerId: string | null = null;

function storageKey(): string {
  return activeDataOwnerId ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}` : STORAGE_KEY;
}

function emptyState(): AnchorState {
  return { drafts: {}, sessions: [] };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeAnchor(raw: unknown): DraftFavoriteAnchor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as { uid?: unknown; wireModelId?: unknown; providerId?: unknown };
  if (!nonEmptyString(item.uid) || !nonEmptyString(item.wireModelId)) return null;
  // 来源是锚点身份的一部分(见 DraftFavoriteAnchor.providerId):缺它的旧条目整条丢弃
  // (= 回落模型行,安全方向;该字段与本 store 同一 PR 落地,不存在需要迁移的存量)。
  if (!nonEmptyString(item.providerId)) return null;
  return { uid: item.uid, wireModelId: item.wireModelId, providerId: item.providerId };
}

/**
 * 严格校验:形状不对的条目整条丢弃(丢弃 = 回落模型行打勾,是安全方向)。老版本 /
 * 手改 localStorage 损坏时静默回退空表,不抛。
 */
function sanitize(raw: unknown): AnchorState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const r = raw as { drafts?: unknown; sessions?: unknown };
  const state = emptyState();

  if (r.drafts && typeof r.drafts === 'object' && !Array.isArray(r.drafts)) {
    for (const [engine, value] of Object.entries(r.drafts as Record<string, unknown>)) {
      // 引擎校验复用 agentVendors 的单一真源(与 modelEnginePrefs 同理由:将来新增引擎
      // 这里零改动,逐个写死三元的写法每上线一个引擎都得手工补一次)。
      if (!isSelectableVendor(engine)) continue;
      const anchor = normalizeAnchor(value);
      if (anchor) state.drafts[engine] = anchor;
    }
  }

  if (Array.isArray(r.sessions)) {
    const seen = new Set<string>();
    for (const value of r.sessions) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as { sessionId?: unknown; engine?: unknown };
      // providerId 校验在 normalizeAnchor 里(草稿槽与会话槽同为锚点身份三元组)。
      const anchor = normalizeAnchor(value);
      if (!anchor) continue;
      if (!nonEmptyString(item.sessionId) || seen.has(item.sessionId)) continue;
      if (!isSelectableVendor(item.engine)) continue;
      seen.add(item.sessionId);
      state.sessions.push({
        sessionId: item.sessionId,
        engine: item.engine,
        ...anchor,
      });
      // 落盘次序即 LRU 次序:超出上限的尾部直接不收(旧数据被手改成超长表时同样收敛)。
      if (state.sessions.length >= SESSION_SLOT_LIMIT) break;
    }
  }

  return state;
}

// 进程内缓存(惰性加载)。读多写少;更要紧的是 useSyncExternalStore 的 getSnapshot 必须
// 返回**引用稳定**的值 —— 每次读都重新 parse 会让快照每帧换引用,直接把组件转成死循环。
let cache: AnchorState | null = null;

function loadFromStorage(): AnchorState {
  if (typeof window === 'undefined') return emptyState();
  try {
    const raw = window.localStorage.getItem(storageKey());
    return raw ? sanitize(JSON.parse(raw)) : emptyState();
  } catch {
    return emptyState();
  }
}

function load(): AnchorState {
  if (!cache) cache = loadFromStorage();
  return cache;
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(next: AnchorState): void {
  cache = next;
  if (typeof window !== 'undefined') {
    try {
      // 同步写:见文件头(热更 relaunch 走 app.exit(),异步写会丢最近一次改动)。
      window.localStorage.setItem(storageKey(), JSON.stringify(next));
    } catch {
      // localStorage 满 / 私密窗口禁写 —— 静默吞,内存态照常生效。
    }
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ── 草稿槽 ────────────────────────────────────────────────────────────────────

/** 读某个引擎的草稿锚点;没有 = 该引擎当前选中的是模型行。 */
export function getDraftFavoriteAnchor(engine: ModelEngine): DraftFavoriteAnchor | null {
  return load().drafts[engine] ?? null;
}

/** 写 / 清某个引擎的草稿锚点(`null` = 清)。无实际变化时短路,不落盘不通知。 */
export function setDraftFavoriteAnchor(
  engine: ModelEngine,
  anchor: DraftFavoriteAnchor | null,
): void {
  const state = load();
  const current = state.drafts[engine] ?? null;
  const same =
    current === null
      ? anchor === null
      : anchor !== null &&
        current.uid === anchor.uid &&
        current.wireModelId === anchor.wireModelId &&
        current.providerId === anchor.providerId;
  if (same) return;
  const drafts = { ...state.drafts };
  if (anchor) {
    drafts[engine] = {
      uid: anchor.uid,
      wireModelId: anchor.wireModelId,
      providerId: anchor.providerId,
    };
  } else {
    delete drafts[engine];
  }
  persist({ ...state, drafts });
}

// ── 会话槽 ────────────────────────────────────────────────────────────────────

/** 读某个会话的锚点快照;消费方仍需与会话当前 (模型, 引擎, 来源) 比对后才打勾。 */
export function getSessionFavoriteAnchor(sessionId: string): SessionFavoriteAnchor | null {
  if (!sessionId) return null;
  return load().sessions.find((slot) => slot.sessionId === sessionId) ?? null;
}

/**
 * 写 / 清某个会话的锚点(`null` = 清)。写入把该会话移到队首(LRU 的「最近使用」),
 * 超出上限时淘汰队尾(最久没写过的那条)。
 */
export function setSessionFavoriteAnchor(
  sessionId: string,
  anchor: SessionFavoriteAnchor | null,
): void {
  if (!sessionId) return;
  const state = load();
  const current = state.sessions.find((slot) => slot.sessionId === sessionId) ?? null;
  if (!anchor) {
    if (!current) return;
    persist({ ...state, sessions: state.sessions.filter((slot) => slot.sessionId !== sessionId) });
    return;
  }
  const same =
    current !== null &&
    current.uid === anchor.uid &&
    current.wireModelId === anchor.wireModelId &&
    current.engine === anchor.engine &&
    current.providerId === anchor.providerId;
  // 值一样但已经在队首 → 完全 no-op;值一样却不在队首仍要重排(它刚被使用过)。
  if (same && state.sessions[0]?.sessionId === sessionId) return;
  const sessions = [
    {
      sessionId,
      uid: anchor.uid,
      wireModelId: anchor.wireModelId,
      engine: anchor.engine,
      providerId: anchor.providerId,
    },
    ...state.sessions.filter((slot) => slot.sessionId !== sessionId),
  ].slice(0, SESSION_SLOT_LIMIT);
  persist({ ...state, sessions });
}

// ── 订阅 / 分区 ───────────────────────────────────────────────────────────────

/** 订阅锚点变更(非 React 调用方 / useSyncExternalStore 的 subscribe)。 */
export function subscribeFavoriteAnchorMemory(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * React hook —— 某个会话的锚点快照。返回值引用只在真正写入 / 跨窗口同步时变化
 * (getSnapshot 读缓存,见 cache 的注释),可直接进依赖。
 */
export function useSessionFavoriteAnchor(sessionId: string | null): SessionFavoriteAnchor | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? getSessionFavoriteAnchor(sessionId) : null),
    () => null,
  );
}

/** React hook —— 某个引擎的草稿锚点快照(引用稳定性同上)。 */
export function useDraftFavoriteAnchor(engine: ModelEngine): DraftFavoriteAnchor | null {
  return useSyncExternalStore(
    subscribe,
    () => getDraftFavoriteAnchor(engine),
    () => null,
  );
}

/**
 * 随当前数据归属账号切换持久化命名空间(与 setModelFavoritesOwner 同形)。
 * 切换后丢缓存重新惰性加载 —— 不同账号各读各的锚点,不串号。
 */
export function setFavoriteAnchorMemoryOwner(ownerId: string | null): void {
  const normalized = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  if (activeDataOwnerId === normalized) return;
  activeDataOwnerId = normalized;
  cache = null;
  emit();
}

const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
  const onStorage = (event: StorageEvent): void => {
    // key === null 表示 storage.clear();其余只认本 store 当前分区的 key。
    if (event.key !== null && event.key !== storageKey()) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    // 迟到事件带旧值:**重读 localStorage**,不采信 event.newValue(见文件头)。
    cache = loadFromStorage();
    emit();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
})();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeStorageListener?.();
  });
}

/** 测试用 —— 断言落盘 key 时引用(测试隔离靠 vi.resetModules 重置模块态,不设 reset 后门)。 */
export const __STORAGE_KEY = STORAGE_KEY;
