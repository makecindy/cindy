/**
 * RightSidebar Tab Store —— module-level singleton,per-sessionId 分片缓存 + IPC 集成。
 *
 * 设计要点:
 *  - cache 按 sessionId 分桶(Map<sessionId, TabBucket>),跨 session 互不串。
 *  - 首次访问某 sessionId 调用 `ensureHydrated(sessionId)` 触发 IPC list 拉取并 hydrate。
 *  - 操作(addTab / closeTab / setActiveTab / patchTabState / reorderTabs)走"乐观更新 cache
 *    + IPC 写"的模式:乐观本地改,IPC 写失败回滚 cache + rethrow。
 *  - 高频 patchTabState 走全局单飞队列:同 tab 等待中的写只保留最后一份,
 *    避免 webview 导航 / title / favicon 事件无界灌入 DB worker。
 *  - subscribe(listener) 接收 sessionId-aware 通知;消费方(RightSidebarShell)通过
 *    React 的 useSyncExternalStore 订阅当前 sessionId 的桶变化。
 *
 * 错误暴露走 caller 的 catch + console.error;Phase 7 加 toast 统一暴露。
 *
 * 模块单例 → RightSidebar 整树 unmount/remount(session 切换时 MainLayout L553 条件渲染)也不丢数据。
 */

import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { getTabKind } from './registry';
import { unmarkPopupSpawnedTab } from './lib/popupTabs';
import type { TabKindId, TabState } from './types';

const log = createLogger('rightSidebar.store');

/** Bucket = 某个 session 的 tab 列表 + 激活 + hydrate 状态。 */
export interface TabBucket {
  /** false = 尚未从 IPC 加载,Shell 应渲染 placeholder。 */
  hydrated: boolean;
  tabs: TabState[];
  activeTabId: string | null;
}

type Listener = (sessionId: string) => void;
export type TabCloseInterceptor = () => Promise<boolean | void> | boolean | void;

const MAX_TABS_PER_SESSION = 20;
const MAX_STATE_JSON_BYTES = 16 * 1024;
const cache = new Map<string, TabBucket>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<Listener>();
const memoryOnlySessions = new Set<string>();
const closeInterceptors = new Map<string, TabCloseInterceptor>();
const patchRevisions = new Map<string, number>();
/**
 * 进行中的 tab 创建(tabId → 该 tab 是否**落库成功**)。
 *
 * closeTab 必须等它落定再发 close:tab 是乐观插入的,持久化 IPC 还在途时 React
 * 已能 mount 它的 body(浏览器 tab 甚至已经加载完 OAuth callback 页并
 * `window.close()`)。此时 close 先到 main 会拿到 NOT_FOUND → closeTab 回滚到
 * "含这个 tab"的快照,随后 upsert 才落地 —— cache 和 DB 里都留下一个本该消失的
 * tab。手动关闭刚建的 tab 也是同一个竞态。
 *
 * 值是 boolean 而不是 void:创建**失败**时 DB 里从来没有这行(addTab 已把它从
 * cache 回滚掉),此时若照样发 close,必然 NOT_FOUND,而 closeTab 的回滚分支会把
 * 这个幽灵 tab 又写回 cache。所以 closeTab 要能区分"创建成功了"和"创建失败了"。
 */
const pendingTabCreates = new Map<string, Promise<boolean>>();
/**
 * per-session 关闭变更队列(sessionId → 队尾)。closeTab 的变更段在这里串行,
 * 保证任意两次关闭(用户手关 / ⌘W 连按 / closeAllTabs / agent close tab-op /
 * guest `window.close()` 自关)不会拿着彼此的旧 bucket 快照交错落盘。
 */
const closeMutationQueues = new Map<string, Promise<void>>();

/**
 * 把一次关闭变更排到该 session 队尾。链上只用于**排序**:前一个任务失败不能把
 * 后续关闭全部拖挂,所以链本身吞异常;调用方仍拿到自己那次的真实结果 / 异常。
 */
function enqueueCloseMutation(sessionId: string, task: () => Promise<void>): Promise<void> {
  const prev = closeMutationQueues.get(sessionId) ?? Promise.resolve();
  const run = prev.then(task);
  const chained = run.then(
    () => undefined,
    () => undefined,
  );
  closeMutationQueues.set(sessionId, chained);
  void chained.then(() => {
    if (closeMutationQueues.get(sessionId) === chained) closeMutationQueues.delete(sessionId);
  });
  return run;
}
const persistedStateBaselines = new Map<string, unknown>();
const STATE_WRITE_OVERLOAD_RETRY_DELAYS_MS = [25, 75, 150] as const;

interface TabStateWriteInput {
  id: string;
  sessionId: string;
  kind: string;
  position: number;
  state: unknown;
}

interface PendingTabStateWrite {
  input: TabStateWriteInput;
  revision: number;
  generation: number;
  overloadRetries: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * patchTabState 的有界持久化队列:
 * - 全局最多 1 个 right-sidebar upsert 在途,不给 DB worker 制造并发洪峰。
 * - 每个 tab 最多 1 个等待槽,后来的 state 覆盖旧 payload(last-write-wins)。
 * 因 session 最多 20 tabs,等待 payload 数量也天然有界。
 */
const pendingStateWrites = new Map<string, PendingTabStateWrite>();
const pendingStateWriteOrder: string[] = [];
const activeStateWrites = new Map<string, PendingTabStateWrite>();
let stateWritePumpRunning = false;
let storeGeneration = 0;

interface RightSidebarTabsListResult {
  tabs: Array<{ id: string; kind: string; state: unknown }>;
  activeTabId: string | null;
  /** false = session is not present in this device's local sessions table. */
  persistable?: boolean;
}

/**
 * cache miss 时 getBucket 返回的稳定单例。
 *
 * 必须是单例 reference,因为 RightSidebarShell 走 useSyncExternalStore 订阅当前
 * sessionId 的桶 —— React 用 Object.is 比较 snapshot,若 cache miss 每次返回新对象
 * 会触发无限重渲染(也会报警告)。
 *
 * 语义是"尚未加载,Shell 应渲染占位而非 EmptyState"。setBucket 的 cache miss base
 * 走 hydrated:true 的 inline 对象,不复用此常量(写操作 = 已接管 session 状态)。
 */
const EMPTY_BUCKET: TabBucket = { hydrated: false, tabs: [], activeTabId: null };

function notify(sessionId: string): void {
  for (const l of listeners) l(sessionId);
}

function ipcApi() {
  return typeof window !== 'undefined'
    ? window.electronAPI?.localDb?.rightSidebarTabs
    : undefined;
}

function makeTabId(): string {
  // Phase 2 简易 id;不引入 nanoid 依赖。冲突概率 ~10^-12,实际不可能。
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function tabStateWriteKey(sessionId: string, tabId: string): string {
  return `${sessionId}\0${tabId}`;
}

function rollbackTabStateWrite(key: string, item: PendingTabStateWrite): void {
  if (patchRevisions.get(key) !== item.revision) return;
  const baseline = persistedStateBaselines.get(key);
  const bucket = getBucket(item.input.sessionId);
  const idx = bucket.tabs.findIndex((tab) => tab.id === item.input.id);
  if (idx < 0) return;
  const tabs = [...bucket.tabs];
  tabs[idx] = { ...tabs[idx], state: baseline };
  setBucket(item.input.sessionId, { tabs });
}

function isDbWorkerQueueOverloadedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('db worker RPC queue overloaded');
}

/** main 端 rightSidebarTabs 对不存在的行抛 `[NOT_FOUND] tab <id> not found`。
 *  经共享 helper 做结构化 code 比对(正则锚定 Electron 包装后的 code 位置),
 *  而不是裸 `message.includes('[NOT_FOUND]')`——后者会把 message 恰好含该
 *  字样的无关错误误判成"清理成功",让孤儿行清理被静默跳过。
 *  孤儿行清理用它区分"本来就没有"(=成功)与"清理没做成"(=必须重试/上抛)。 */
function isTabRowMissingError(err: unknown): boolean {
  return extractIpcError(err)?.code === 'NOT_FOUND';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 孤儿行清理:删除一条"cache 已经不认、但 SQLite 可能仍有"的 tab 行。
 * closeTab 的创建失败分支与 addTab 的半失败回滚共用——两处的失败语义一致:
 *  - `[NOT_FOUND]` = 行本来就没有(或另一路径已删),清理成功;
 *  - 其它(DB worker 不可用/过载)= 清理没做成,按 overload 节奏有限重试;
 *    终失败 log.error 留痕并向上抛,调用方决定是传播还是旁路记录——静默吞掉
 *    等于让孤儿行在下次 hydrate / 重启时"幽灵复活"。
 */
async function cleanupOrphanTabRow(
  sessionId: string,
  tabId: string,
  caller: string,
): Promise<void> {
  const ipc = ipcApi();
  if (!ipc || !shouldPersist(sessionId)) return;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ipc.close({ id: tabId });
      return;
    } catch (cleanupErr) {
      if (isTabRowMissingError(cleanupErr)) return;
      if (attempt < STATE_WRITE_OVERLOAD_RETRY_DELAYS_MS.length) {
        await wait(STATE_WRITE_OVERLOAD_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      log.error(`${caller}: orphan-row cleanup failed after retries`, {
        sessionId,
        tabId,
        err: cleanupErr,
      });
      throw cleanupErr;
    }
  }
}

function resetStateWriteQueue(): void {
  storeGeneration += 1;
  for (const item of activeStateWrites.values()) item.resolve();
  for (const item of pendingStateWrites.values()) item.resolve();
  activeStateWrites.clear();
  pendingStateWrites.clear();
  pendingStateWriteOrder.length = 0;
  patchRevisions.clear();
  persistedStateBaselines.clear();
}

async function drainStateWrites(): Promise<void> {
  if (stateWritePumpRunning) return;
  stateWritePumpRunning = true;
  try {
    while (pendingStateWriteOrder.length > 0) {
      const key = pendingStateWriteOrder.shift();
      if (!key) continue;
      const item = pendingStateWrites.get(key);
      if (!item) continue;
      pendingStateWrites.delete(key);
      if (item.generation !== storeGeneration) {
        item.resolve();
        continue;
      }
      activeStateWrites.set(key, item);
      try {
        const ipc = ipcApi();
        if (ipc && shouldPersist(item.input.sessionId)) {
          await ipc.upsert(item.input);
          if (item.generation !== storeGeneration) {
            item.resolve();
            continue;
          }
          persistedStateBaselines.set(key, item.input.state);
        }
        item.resolve();
      } catch (err) {
        if (item.generation !== storeGeneration) {
          item.resolve();
          continue;
        }
        if (isMissingSessionPersistenceError(err)) {
          markMemoryOnlySession(item.input.sessionId);
          item.resolve();
          continue;
        }
        if (
          isDbWorkerQueueOverloadedError(err) &&
          item.overloadRetries < STATE_WRITE_OVERLOAD_RETRY_DELAYS_MS.length
        ) {
          const delayMs = STATE_WRITE_OVERLOAD_RETRY_DELAYS_MS[item.overloadRetries];
          item.overloadRetries += 1;
          await wait(delayMs);
          if (item.generation !== storeGeneration) {
            item.resolve();
            continue;
          }
          // 等待期间若同 tab 已有更新的 state 入队,由最新写负责最终持久化;
          // 旧 promise 可直接完成,避免重试旧 payload 覆盖新状态。
          if (pendingStateWrites.has(key)) {
            item.resolve();
            continue;
          }
          pendingStateWrites.set(key, item);
          pendingStateWriteOrder.push(key);
          continue;
        }
        rollbackTabStateWrite(key, item);
        log.error('patchTabState IPC failed; rolling back cache', {
          sessionId: item.input.sessionId,
          tabId: item.input.id,
          err,
        });
        item.reject(err);
      } finally {
        if (activeStateWrites.get(key) === item) activeStateWrites.delete(key);
      }
    }
  } finally {
    stateWritePumpRunning = false;
    // finally 与新 enqueue 可能交错;若尾部又有写,重新启动 pump。
    if (pendingStateWriteOrder.length > 0) void drainStateWrites();
  }
}

function enqueueTabStateWrite(
  key: string,
  input: TabStateWriteInput,
  revision: number,
): Promise<void> {
  const existing = pendingStateWrites.get(key);
  if (existing) {
    existing.input = input;
    existing.revision = revision;
    return existing.promise;
  }
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pendingStateWrites.set(key, {
    input,
    revision,
    generation: storeGeneration,
    overloadRetries: 0,
    promise,
    resolve,
    reject,
  });
  pendingStateWriteOrder.push(key);
  void drainStateWrites();
  return promise;
}

async function settleTabStateWrites(sessionId: string, tabId: string): Promise<void> {
  const key = tabStateWriteKey(sessionId, tabId);
  // 终止性不变量:调用方 closeTab 已先把 tab 移出 cache,patchTabState 找不到该
  // tab 后只会 noop,所以不会再有新写进入这个 key。等待 active 与 pending
  // 两代写全部落定后再 DELETE,避免队列中的 UPSERT 在 close 之后把 tab 行复活。
  while (true) {
    const writes = [activeStateWrites.get(key)?.promise, pendingStateWrites.get(key)?.promise]
      .filter((promise): promise is Promise<void> => promise != null);
    if (writes.length === 0) return;
    await Promise.allSettled(writes);
  }
}

async function settleCurrentSessionStateWrites(sessionId: string): Promise<void> {
  const prefix = `${sessionId}\0`;
  // 只等待调用瞬间已经存在的旧 position 写。reorder 已先更新 cache,之后新入队的
  // patch 会携带新 position,即使与 reorder IPC 交错也不会把顺序改回去。
  const writes = [
    ...[...activeStateWrites.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, item]) => item.promise),
    ...[...pendingStateWrites.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, item]) => item.promise),
  ];
  await Promise.allSettled(writes);
}

function setBucket(sessionId: string, next: Partial<TabBucket>): TabBucket {
  const current = cache.get(sessionId);
  // cache miss + 写操作:用 hydrated:true 作 merge base —— 写入意味着我们已接管该
  // session 状态,不再需要 ensureHydrated 回填。EMPTY_BUCKET 只用于 getBucket 的
  // "尚未加载"语义,两条路径必须区分,否则 partial setBucket 会让 merged.hydrated
  // 一直停在 false,Shell 永远渲染占位。
  const base: TabBucket = current ?? { hydrated: true, tabs: [], activeTabId: null };
  const merged: TabBucket = { ...base, ...next };
  cache.set(sessionId, merged);
  notify(sessionId);
  return merged;
}

/**
 * per-session 的持久化边界。false = 纯内存模式,所有 IPC 写(以及 hydrate 的
 * list)都跳过。两类来源:
 *  - device-link 远程会话(getSessionDeviceId 命中):right_sidebar_tabs 表对
 *    sessions 表有 FK(ON DELETE CASCADE),远程会话的 sessionId 不在控制端
 *    本地 sessions 表,写入必撞 FOREIGN KEY 约束(真机实测:addTab reject →
 *    tab"一闪"加不上)。前置判定,连 list 都不发。
 *  - 运行时探测(memoryOnlySessions):hydrate 的 list 返回 persistable=false,
 *    或首次写撞 FK 错误后标记。
 * 内存模式不跨重启持久化——tab 布局属会话视图态,远程会话在控制端本就是
 * 镜像,重开重建可接受。
 */
function shouldPersist(sessionId: string): boolean {
  return !memoryOnlySessions.has(sessionId) && !getSessionDeviceId(sessionId);
}

function isMissingSessionPersistenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('SQLITE_CONSTRAINT_FOREIGNKEY') ||
    err.message.includes('FOREIGN KEY constraint failed')
  );
}

function markMemoryOnlySession(sessionId: string): void {
  memoryOnlySessions.add(sessionId);
}

function validateMemoryOnlyStateSize(state: unknown): void {
  const json = state === undefined ? '{}' : JSON.stringify(state);
  if (typeof json !== 'string') {
    throw new Error('tab state JSON must be serializable');
  }
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_STATE_JSON_BYTES) {
    throw new Error(`tab state JSON too large: ${bytes} bytes (limit ${MAX_STATE_JSON_BYTES})`);
  }
}

/**
 * 当前快照(同步)。无 sessionId 或 cache miss 时返回 EMPTY_BUCKET 单例
 * (hydrated:false,语义 "尚未加载")。
 *
 * 返回 reference 必须稳定 —— Shell 走 useSyncExternalStore 订阅,React 用 Object.is
 * 比较 snapshot,cache miss 返回新对象会触发警告 / 无限重渲染。
 */
export function getBucket(sessionId: string | null | undefined): TabBucket {
  if (!sessionId) return EMPTY_BUCKET;
  return cache.get(sessionId) ?? EMPTY_BUCKET;
}

/**
 * 按 tabId 反查所属 sessionId(只扫已水合进本 renderer 的 bucket)。
 * guest 自关(window.close)路径用:pool 的 close 事件只带 tabId,要落到
 * closeTab(sessionId, tabId) 必须先找回归属。线性扫 cache —— bucket 数 =
 * 本 renderer 摸过的 session 数,量级个位到十位,无需索引。
 */
export function findSessionIdByTabId(tabId: string): string | null {
  for (const [sessionId, bucket] of cache) {
    if (bucket.tabs.some((t) => t.id === tabId)) return sessionId;
  }
  return null;
}

/** 首次访问 sessionId 触发 IPC list 拉取;后续命中 cache 即 noop。dedupe 并发请求。 */
export async function ensureHydrated(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const current = cache.get(sessionId);
  if (current?.hydrated) return;
  const existing = inflight.get(sessionId);
  if (existing) return existing;
  const ipc = ipcApi();
  if (!ipc || !shouldPersist(sessionId)) {
    // SSR / 测试 / preload 未就绪,或纯内存会话(device-link 远程)——
    // 标记空 hydrated,防止 useEffect 无限重试;不发 list IPC。
    setBucket(sessionId, { hydrated: true, tabs: [], activeTabId: null });
    return;
  }
  const promise = (async () => {
    try {
      const result = await ipc.list({ sessionId }) as RightSidebarTabsListResult;
      if (result.persistable === false) {
        markMemoryOnlySession(sessionId);
      } else {
        memoryOnlySessions.delete(sessionId);
      }
      const tabs: TabState[] = result.tabs.map((row) => ({
        id: row.id,
        kind: row.kind as TabKindId,
        state: row.state,
      }));
      setBucket(sessionId, { hydrated: true, tabs, activeTabId: result.activeTabId });
    } finally {
      inflight.delete(sessionId);
    }
  })();
  inflight.set(sessionId, promise);
  return promise;
}

/**
 * 新增 tab —— 走乐观本地添加 + IPC upsert + setActive,失败回滚 cache。
 *
 * `opts.onOptimisticAdd`:乐观 setBucket 之后、await IPC 之前**同步**回调新
 * tabId。给需要"在 React 能看到这个 tab 的同一 tick 内登记副标记"的调用方用
 * (如 popup 来源标记:等 addTab resolve 再登记的话,持久化 IPC 在途期间 React
 * 已可能 mount webview 并加载完 callback 页,window.close 事件会赶在登记前到达
 * 且不重发)。
 *
 * 不需要对称的"回滚回调":IPC 失败回滚时 store 自己走 `forgetClosedTab(id)` 把
 * 挂在这个 tabId 上的旁路记录(含 popup 标记)清掉 —— 与关闭路径同一个收尾函数。
 * 否则 DB / IPC 异常期间反复触发 popup,标记集合会随进程生命周期无界增长。
 *
 * `opts.activate === false`:追加 tab 但**不抢激活位**(cache 与 DB 的 active 都
 * 保持原样)。钉住面板的跨会话自动补挂用 —— 用户切到某会话时补挂的页签不该
 * 把他正看着的 tab 顶掉。默认 true 维持既有语义(用户手动加 tab = 看它)。
 */
export async function addTab(
  sessionId: string,
  kind: TabKindId,
  initialState: unknown = null,
  opts?: { onOptimisticAdd?: (tabId: string) => void; activate?: boolean },
): Promise<TabState> {
  const activate = opts?.activate !== false;
  const prev = getBucket(sessionId);
  if (prev.tabs.length >= MAX_TABS_PER_SESSION) {
    throw new Error(`session ${sessionId} already has ${MAX_TABS_PER_SESSION} tabs (limit reached)`);
  }
  if (!shouldPersist(sessionId)) {
    validateMemoryOnlyStateSize(initialState);
  }
  const id = makeTabId();
  const position = prev.tabs.length;
  const newTab: TabState = { id, kind, state: initialState };
  setBucket(sessionId, {
    tabs: [...prev.tabs, newTab],
    activeTabId: activate ? id : prev.activeTabId,
  });
  try {
    opts?.onOptimisticAdd?.(id);
  } catch {
    // 调用方回调抛错不该毒化 addTab 主流程。
  }
  let rowCommitted = false;
  try {
    const ipc = ipcApi();
    if (ipc && shouldPersist(sessionId)) {
      // 同步登记 in-flight 创建(与乐观插入同一 tick),并发的 closeTab 才等得到。
      // `rowCommitted` 只跟踪 **upsert 这一步**:upsert 成功但随后的 setActive 失败
      // 时,DB 里已经有这一行了,关闭路径必须照常发 close 把它删掉,否则 addTab
      // 回滚了 renderer cache,DB 里却留下一行孤儿 tab,下次 hydrate / 重启就冒出来。
      const create = (async () => {
        await ipc.upsert({ id, sessionId, kind, position, state: initialState });
        rowCommitted = true;
        if (activate) await ipc.setActive({ sessionId, id });
      })();
      const persisted = create.then(
        () => true,
        () => rowCommitted,
      );
      pendingTabCreates.set(id, persisted);
      void persisted.then(() => {
        if (pendingTabCreates.get(id) === persisted) pendingTabCreates.delete(id);
      });
      await create;
    }
    return newTab;
  } catch (err) {
    if (isMissingSessionPersistenceError(err)) {
      markMemoryOnlySession(sessionId);
      return newTab;
    }
    log.error('addTab IPC failed; rolling back cache', { sessionId, kind, err });
    setBucket(sessionId, { tabs: prev.tabs, activeTabId: prev.activeTabId });
    // 这个 tab 从未存在过 —— `onOptimisticAdd` 里登记的旁路记录(popup 标记等)
    // 必须跟着回滚,否则没有任何 closeTab 成功分支会来清它。
    forgetClosedTab(sessionId, id);
    // rowCommitted=true 说明 upsert 已成功、SQLite 有这一行,但 addTab 整体失败
    // (通常是 setActive 抛错)。cache 已回滚且没有调用方会再发 closeTab —— 走共享
    // 的孤儿行清理(与 closeTab 创建失败分支同款 cleanupOrphanTabRow):
    // [NOT_FOUND] 即成功,瞬态失败按 overload 节奏重试,终失败 log.error 留痕。
    // await 到清理尽力完成再抛原始 err(时序确定);清理自身的失败绝不掩盖
    // 触发回滚的原始错误。
    if (rowCommitted) {
      try {
        await settleTabStateWrites(sessionId, id);
        await cleanupOrphanTabRow(sessionId, id, 'addTab rollback');
      } catch {
        // 终失败已在 helper 内 log.error 留痕;继续抛原始 err。
      }
    }
    throw err;
  }
}

/**
 * 单例 kind helper —— bucket 内若已存在该 kind 的 tab 则 setActive,
 * 否则 addTab。返回最终 tab(新建或已有)。专门给 review 这种"每 session 至多 1 个"
 * 的 plugin 用,避免分散调用方手写"先 find 再 add"的判存语义。
 *
 * 不保证 bucket 已 hydrated:调用方应在 hydrated 后才调,否则可能在 IPC list
 * 完成前先 addTab,后到的 list 结果会跟乐观写的 tab 合并冲突。RightSidebarShell
 * 的 EmptyState 触发路径已经 hydrated(bucket.hydrated=true)。
 */
export async function addOrFocusSingletonTab(
  sessionId: string,
  kind: TabKindId,
  initialState: unknown = null,
): Promise<TabState> {
  const bucket = getBucket(sessionId);
  const existing = bucket.tabs.find((t) => t.kind === kind);
  if (existing) {
    if (bucket.activeTabId !== existing.id) {
      await setActiveTab(sessionId, existing.id);
    }
    return existing;
  }
  return addTab(sessionId, kind, initialState);
}

export function setTabCloseInterceptor(
  tabId: string,
  interceptor: TabCloseInterceptor | null,
): () => void {
  if (!interceptor) {
    closeInterceptors.delete(tabId);
    return () => undefined;
  }
  closeInterceptors.set(tabId, interceptor);
  return () => {
    if (closeInterceptors.get(tabId) === interceptor) closeInterceptors.delete(tabId);
  };
}

export function hasTabCloseInterceptor(tabId: string): boolean {
  return closeInterceptors.has(tabId);
}

/**
 * tab 已确定从 store 消失后的收尾:清掉挂在 tabId 上的所有旁路记录。
 *
 * 只在"真的没了"的分支调 —— close IPC 失败会回滚 cache(tab 还在),那时这些记录
 * 必须留着。popup 来源标记同理:所有关闭入口(用户手关 / closeAllTabs / agent
 * close tab-op / guest 自关)都汇聚到 closeTab,标记不会随某条路径泄漏。
 */
function forgetClosedTab(sessionId: string, tabId: string): void {
  const key = tabStateWriteKey(sessionId, tabId);
  patchRevisions.delete(key);
  persistedStateBaselines.delete(key);
  unmarkPopupSpawnedTab(tabId);
}

/**
 * 关 tab —— 优先激活右邻 → 左邻 → null。失败回滚。
 * plugin.onBeforeClose 给 plugin 释放 main 进程资源的机会(terminal 在这里 dispose PTY)。
 * 默认失败不阻断关闭流程;只有 plugin 明确返回 false 时才否决关闭。
 *
 * 并发纪律:**变更段按 session 串行**(见 closeMutationQueues)。关闭要跨越
 * 若干 await(创建落地 / state 写落地 / close IPC / setActive IPC),而回滚用的是
 * 进入变更段时的 bucket 快照 —— 同 session 两次关闭交错跑,后完成的那次会用旧
 * 快照把对方删掉的 tab 写回,或让 setActive 指向已删 tab 拿 NOT_FOUND 后把两次
 * 删除一起回滚(cache 与 DB 从此不一致)。触发场景不需要多罕见:OAuth popup 自关
 * 撞上用户手关另一个 tab、⌘W 连按、closeAll 与自关并行,都是。
 *
 * interceptor / onBeforeClose **不进**队列:它们可能弹确认框等用户很久,不该
 * 卡住同 session 其它 tab 的关闭;放在队列外也就不存在"拦截里再调 store"自锁的
 * 可能。它们只读 closing tab 自己的状态,不依赖 bucket 快照。
 */
export async function closeTab(
  sessionId: string,
  tabId: string,
  opts: { skipBeforeClose?: boolean } = {},
): Promise<void> {
  const tab = getBucket(sessionId).tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // 先调 close interceptor / plugin onBeforeClose,后改 cache + IPC。
  // 在 cache 改之前调,plugin 拿到的还是 closing tab 的稳定状态。
  const plugin = getTabKind(tab.kind);
  if (!opts.skipBeforeClose) {
    const interceptor = closeInterceptors.get(tabId);
    if (interceptor) {
      try {
        const shouldContinue = await interceptor();
        if (shouldContinue === false) return;
      } catch (err) {
        log.warn('tab close interceptor failed (vetoed)', { sessionId, tabId, kind: tab.kind, err });
        return;
      }
    }
    if (plugin?.onBeforeClose) {
      try {
        const shouldContinue = await plugin.onBeforeClose(tab.state, { tabId, sessionId });
        if (shouldContinue === false) return;
      } catch (err) {
        log.warn('plugin onBeforeClose failed (ignored)', { sessionId, tabId, kind: tab.kind, err });
      }
    }
  }

  const mutation = enqueueCloseMutation(sessionId, async () => {
    // 队列内重取快照:排在前面的关闭可能已经动过这个 bucket(甚至已经关掉了本
    // tab)。用旧快照算 nextTabs / 回滚基线正是并发出错的根源。
    const prev = getBucket(sessionId);
    const idx = prev.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const nextTabs = prev.tabs.filter((t) => t.id !== tabId);
    let nextActiveId = prev.activeTabId;
    if (tabId === prev.activeTabId) {
      nextActiveId = nextTabs[idx]?.id ?? nextTabs[idx - 1]?.id ?? null;
    }

    setBucket(sessionId, { tabs: nextTabs, activeTabId: nextActiveId });
    // 先等这个 tab 的创建落定(见 pendingTabCreates)—— 否则 close 可能跑在 INSERT
    // 之前,拿 NOT_FOUND 把整次关闭回滚掉。
    const pendingCreate = pendingTabCreates.get(tabId);
    if (pendingCreate && !(await pendingCreate)) {
      // 创建**连 upsert 都没成**:DB 里"通常"没有这行(addTab 已经把它从 cache
      // 回滚掉)。绝不能走下面的正常分支 —— close 报 NOT_FOUND 会命中 catch 里的
      // 回滚,把这个幽灵 tab 写回 cache。
      // (upsert 成功、只是 setActive 失败的半失败情形返回 true,照常走下面的 close。)
      //
      // 但"通常"不等于"一定":state 写队列同样走 `ipc.upsert`(还带 overload 重试),
      // 乐观插入后入队的某次 patch 可能反倒把这一行写进了 DB。所以先等 state 写落定,
      // 再发一次清理 close 兜掉这种孤儿行。失败分两类:
      //  - `[NOT_FOUND]` = "本来就没有",清理目标不存在即成功,吞掉;
      //  - 其它(DB worker 不可用/过载)= **清理没做成**,孤儿行可能留在 SQLite,
      //    吞掉会让它在下次 hydrate / 重启时复活。按 overload 节奏有限重试,
      //    终失败向上抛(cache 里 tab 已被 addTab 回滚,本分支不碰 cache,
      //    不存在"复活失败 tab"的问题)——调用方至少拿到真实结果与日志留痕。
      await settleTabStateWrites(sessionId, tabId);
      await cleanupOrphanTabRow(sessionId, tabId, 'closeTab');
      forgetClosedTab(sessionId, tabId);
      return;
    }
    try {
      await settleTabStateWrites(sessionId, tabId);
      const ipc = ipcApi();
      if (ipc && shouldPersist(sessionId)) {
        await ipc.close({ id: tabId });
        // —— close 已落库:从这里起任何失败都不得进入下面的回滚分支(把已删的
        // tab 插回 cache 会与 DB 反向分叉)。active 同步单独 catch 兜底。
        // setActiveTarget:记录我们实际调用 ipc.setActive 时的目标值,供 activeErr catch 判断。
        // 声明在 inner try 外、if 块内——JavaScript let 不跨 try/catch 块,必须在两者共同的
        // 父作用域里声明才能被 catch 看到。
        let setActiveTarget: string | null | undefined;
        try {
          // active 落库前重取一次 cache 现值:关闭队列只串行关闭之间的变更,
          // 并发的 addTab / setActiveTab 可能已经把 active 换成别的 tab 并落库了 ——
          // 拿关闭前算好的旧值去写会把它盖掉,DB 与 cache 分叉(下次 hydrate 恢复出
          // 错的 active)。cache 是 renderer 侧的真相,直接对齐它即可收敛。
          //
          // detach/reattach 竞态防护:invalidateSessionCaches() 清掉旧 renderer 的
          // bucket 时 hydrated 变 false。EMPTY_BUCKET.activeTabId = null;若照常
          // setActive(null) 会把新 renderer 已接管会话的 active 标志清掉。
          const afterClose = getBucket(sessionId);
          if (afterClose.hydrated) {
            let activeNow = afterClose.activeTabId;
            if (activeNow !== prev.activeTabId) {
              // 并发 addTab 可能刚把新 tab 设为 active 而它的 INSERT 还在途:直接
              // setActive 会撞 [NOT_FOUND](main 端还会先清掉全 session 的 active 位)。
              // 等它的创建落定;等待期间 active 可能又变,落定后重取现值。
              const pendingActive = activeNow ? pendingTabCreates.get(activeNow) : undefined;
              let cacheStillOwned = true;
              if (pendingActive) {
                await pendingActive.catch(() => undefined);
                // detach/reattach 竞态防护:await 期间 invalidateSessionCaches() 可能把
                // bucket 设为 hydrated=false;再次确认 bucket 仍由本 renderer 持有。
                cacheStillOwned = getBucket(sessionId).hydrated;
                if (cacheStillOwned) {
                  activeNow = getBucket(sessionId).activeTabId;
                }
              }
              if (cacheStillOwned && activeNow !== prev.activeTabId) {
                setActiveTarget = activeNow;
                await ipc.setActive({ sessionId, id: activeNow });
              }
            }
          }
        } catch (activeErr) {
          // active 同步失败:tab 删除已成功落库,绝不能回滚。
          // 清空 cache active 让下次用户点击时 setActiveTab 照常落库——
          // 但只有 cache 仍指向我们尝试设置的 active 时才清,否则用户已切到
          // 别的 tab 且该 tab 已成功落库,强清会让 setActiveTab 对那个 tab
          // 多发一次 IPC,结果虽等价但语义上是"回退到无 active"的短暂漂移。
          log.warn('closeTab: post-close setActive failed; clearing cache activeTabId for recovery', {
            sessionId,
            tabId,
            err: activeErr,
          });
          const current = getBucket(sessionId);
          if (
            current.hydrated &&
            setActiveTarget !== undefined &&
            current.activeTabId === setActiveTarget
          ) {
            setBucket(sessionId, { tabs: current.tabs, activeTabId: null });
          }
        }
      }
      forgetClosedTab(sessionId, tabId);
    } catch (err) {
      // NOT_FOUND:行已被并发的 addTab rollback cleanup 或另一个 closeTab 删掉,
      // cache 的乐观删除与 DB 已一致,不需要重新插回——回滚反而造成 cache/DB 分叉。
      if (isTabRowMissingError(err)) {
        forgetClosedTab(sessionId, tabId);
        return;
      }
      log.error('closeTab IPC failed; rolling back cache', { sessionId, tabId, err });
      // 精准回滚:只把被乐观删除的这个 tab 插回**当前** bucket,不整份恢复 prev
      // 快照。close 队列只串行关闭之间的变更,addTab / setActiveTab 是有意留在
      // 队列外的 —— close in-flight 期间它们可能已把新 tab 写进 cache 和 DB,
      // 整快照回滚会把那些并发变更从 cache 抹掉(DB 里还在,重启 hydrate 后
      // "幽灵复活",cache 与 DB 分叉)。
      //
      // detach/reattach 竞态防护:invalidateSessionCaches() 把 bucket 清为
      // EMPTY_BUCKET(hydrated=false)。若此时仍回滚,setBucket 的 cache-miss
      // base(hydrated:true)会重建 bucket,让老 renderer 重新"接管"新 renderer
      // 已经接管的 session——只在 bucket 仍由本 renderer 持有时才回滚。
      const now = getBucket(sessionId);
      if (now.hydrated && !now.tabs.some((t) => t.id === tabId)) {
        const restored = [...now.tabs];
        restored.splice(Math.min(idx, restored.length), 0, prev.tabs[idx]);
        // activeTabId:只有"原 active 就是被关的 tab,且当前 active 仍是关闭时选出
        // 的替代者"才恢复回被关 tab;并发操作已把 active 指向别处时尊重现值。
        const activeTabId =
          prev.activeTabId === tabId && now.activeTabId === nextActiveId
            ? tabId
            : now.activeTabId;
        setBucket(sessionId, { tabs: restored, activeTabId });
      }
      throw err;
    }
  });
  return mutation;
}

/** 关闭某个 session bucket 的全部 tab,逐个走 closeTab 以触发 plugin cleanup。 */
export async function closeAllTabs(sessionId: string): Promise<void> {
  const tabIds = getBucket(sessionId).tabs.map((t) => t.id);
  for (const tabId of tabIds) {
    await closeTab(sessionId, tabId);
  }
}

/** 切换激活 tab —— 同 id 即 noop。失败回滚。 */
export async function setActiveTab(
  sessionId: string,
  tabId: string | null,
): Promise<void> {
  const prev = getBucket(sessionId);
  if (tabId === prev.activeTabId) return;
  // closeTab 已把关闭中的 tab 从 bucket 乐观移除:若此时用户点击该 tab(或
  // 并发命令调 setActiveTab),activeTabId 会指向 tabs 里不存在的 id —— sidebar
  // 无法渲染对应 body;close 落库后 DB 里也没有 active row。提前守门,拒绝激活
  // 不在当前 bucket 里的 tab。
  if (tabId !== null && !prev.tabs.some((t) => t.id === tabId)) return;
  setBucket(sessionId, { activeTabId: tabId });
  try {
    const ipc = ipcApi();
    if (ipc && shouldPersist(sessionId)) await ipc.setActive({ sessionId, id: tabId });
  } catch (err) {
    if (isMissingSessionPersistenceError(err)) {
      markMemoryOnlySession(sessionId);
      return;
    }
    log.error('setActiveTab IPC failed; rolling back cache', { sessionId, tabId, err });
    setBucket(sessionId, { activeTabId: prev.activeTabId });
    throw err;
  }
}

/** patch 单个 tab 的 state(plugin 改 URL / 文件选中等用)。失败回滚。 */
export function patchTabState(
  sessionId: string,
  tabId: string,
  patch: (current: unknown) => unknown,
): Promise<void> {
  const prev = getBucket(sessionId);
  const idx = prev.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return Promise.resolve();
  const oldTab = prev.tabs[idx];
  const newState = patch(oldTab.state);
  if (!shouldPersist(sessionId)) {
    try {
      validateMemoryOnlyStateSize(newState);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  const nextTabs = [...prev.tabs];
  nextTabs[idx] = { ...oldTab, state: newState };
  setBucket(sessionId, { tabs: nextTabs });
  if (!shouldPersist(sessionId)) return Promise.resolve();
  const key = tabStateWriteKey(sessionId, tabId);
  if (!persistedStateBaselines.has(key)) {
    persistedStateBaselines.set(key, oldTab.state);
  }
  const revision = (patchRevisions.get(key) ?? 0) + 1;
  patchRevisions.set(key, revision);
  return enqueueTabStateWrite(
    key,
    {
      id: tabId,
      sessionId,
      kind: oldTab.kind,
      position: idx,
      state: newState,
    },
    revision,
  );
}

/** 重排序 tab,orderedIds 必须包含 same session 当前**全部** tab id。失败回滚。 */
export async function reorderTabs(
  sessionId: string,
  orderedIds: string[],
): Promise<void> {
  const prev = getBucket(sessionId);
  if (orderedIds.length !== prev.tabs.length) return;
  const map = new Map(prev.tabs.map((t) => [t.id, t]));
  const nextTabs: TabState[] = [];
  for (const id of orderedIds) {
    const t = map.get(id);
    if (!t) return; // id 不在当前列表 —— 放弃 reorder
    nextTabs.push(t);
  }
  setBucket(sessionId, { tabs: nextTabs });
  try {
    await settleCurrentSessionStateWrites(sessionId);
    const ipc = ipcApi();
    if (ipc && shouldPersist(sessionId)) await ipc.reorder({ sessionId, orderedIds });
  } catch (err) {
    if (isMissingSessionPersistenceError(err)) {
      markMemoryOnlySession(sessionId);
      return;
    }
    log.error('reorderTabs IPC failed; rolling back cache', { sessionId, err });
    setBucket(sessionId, { tabs: prev.tabs });
    throw err;
  }
}

/**
 * 失效全部 session 桶缓存(保留 memoryOnlySessions 标记 —— 那是"该会话可否持久化"
 * 的事实,不随缓存失效而变)。侧边栏宿主窗口切换(内嵌 ↔ 独立子窗口)时调用:
 * 另一个 renderer 接管期间本 renderer 的缓存必然过期,下次 ensureHydrated 重新
 * 走 IPC list 拉真相。notify 所有已缓存的 sessionId,让挂着的 useSyncExternalStore
 * 立刻看到 EMPTY_BUCKET(hydrated:false)并触发重拉。
 */
export function invalidateSessionCaches(): void {
  const sessionIds = [...cache.keys()];
  cache.clear();
  inflight.clear();
  // 宿主迁移不等于登出:已入队写仍应继续落库。这里不能像 _resetStore 一样
  // resolve 后丢弃,否则新 renderer 会 hydrate 到旧 URL / title / reveal state。
  for (const sessionId of sessionIds) notify(sessionId);
}

/** 订阅任意 sessionId 的桶变化;listener 自行根据 sessionId 过滤。 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试 / 登出清理。 */
export function _resetStore(): void {
  cache.clear();
  inflight.clear();
  memoryOnlySessions.clear();
  closeInterceptors.clear();
  pendingTabCreates.clear();
  closeMutationQueues.clear();
  resetStateWriteQueue();
  listeners.clear();
}
