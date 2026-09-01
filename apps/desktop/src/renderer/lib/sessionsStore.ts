/**
 * sessionsStore — CC Agent Session 列表的模块级单例 store
 * ---------------------------------------------------------------------------
 * 模块级单例 store，把 session 列表的"数据所有权"
 * 从组件树（useState）搬到模块级，解决两个问题：
 *
 *   1. Tab 切换 / 路由切换导致 SidebarUpper unmount → 重 mount 时丢掉本地
 *      state，每次都闪 SessionListSkeleton。改为 store 后，remount 直接命中
 *      模块缓存，isLoading=false，无闪烁。
 *
 *   2. 多个 useCCSessions 实例（Sidebar / SessionView / ScheduleFormDialog…）
 *      此前各自向 sessionsBus / electronAPI.sessionsPush 重复订阅、各自全量
 *      重 fetch。改为 store 后只在模块加载时订阅一次，所有 subscriber 共享
 *      一份 cache 与一次 IPC。
 *
 * 桶维度：ListStatusFilter = 'active' | 'archived' | 'all'
 *   每个 filter 一个独立桶。filter 之间互不影响（active 桶有内容不代表
 *   archived 桶可以推导出来）。
 *
 * 写策略：
 *   - patchLocal(id, patch)        遍历所有桶就地合并字段，保留排序与位置；
 *                                   _count 浅合并，避免 { messages: 1 } 把
 *                                   同级计数清掉。patch.status 会复用任一桶
 *                                   里的完整 row，同步迁移 active / archived /
 *                                   all；完全找不到 row 时才定向补查目标桶。
 *   - prependCreated(session)      新建时本地插入：active / all 桶头部插入；
 *                                   archived 桶按业务永远不应包含新建项，跳过。
 *                                   保留旧 createSession 的"省一次 IPC"优化。
 *   - forceRefresh(filter)         单桶强制重拉，drop 桶 + 走 ensure。
 *   - forceRefreshAll()            重拉所有"已加载过"的桶，未加载桶不动。
 *                                   sessionsBus.onRefresh / sessionsPush.onCreated
 *                                   走这条。
 *
 * 自订阅（模块加载时一次性挂上，hook 不再重复订阅）：
 *   - sessionsBus.onPatch                → patchLocal
 *   - sessionsBus.onRefresh              → forceRefreshAll
 *   - electronAPI.sessionsPush.onPatched → patchLocal
 *   - electronAPI.sessionsPush.onCreated → forceRefreshAll
 *     （payload 只带 sessionId 不带完整 row，无法 prepend，需要重拉）
 *   - electronAPI.onUsageSessionSpendChanged → patchLocal(totalCostUsd)
 *   - maker.schedule.onEvent session-bound → forceRefreshAll
 *     （scheduler runner 在 main 进程创建 session，不一定走 localDb sessionsPush）
 */

import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import type { ListStatusFilter } from '@/lib/sessionService';
import { createLogger } from '@/lib/logger';
import {
  DEFAULT_DRAFT_SESSION_TITLE,
  isDefaultDraftSessionTitle,
} from '@cindy/maker-shared/session-title';

import {
  onAutoTitlePreview,
  onAutoTitlePreviewCleared,
  onPatch,
  onRefresh,
} from '@/lib/sessionsBus';
import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';

// V1.7：取消 16 条上限，全量拉取由 Sidebar 中部滚动条承载。
// 后端硬上限 1000，覆盖几乎所有真实用户的 Session 总数。
const DEFAULT_LIMIT = 1000;
const startupPerfLog = createLogger('perf/startup');
const initialFetchLogged = new Set<ListStatusFilter>();

const cache = new Map<ListStatusFilter, Session[]>();
const inflight = new Map<ListStatusFilter, Promise<Session[]>>();
/** 列表请求期间收到的 session 费用权威值及其本地事件版本。 */
interface SessionSpendOverride {
  revision: number;
  totalCostUsd?: number;
  /** CN 构建推送只带结构化金额,与 totalCostUsd 一样需要防旧列表覆盖。 */
  totalMoney?: NonNullable<Session['totalMoney']>;
}

function sameMoney(
  a: Session['totalMoney'],
  b: Session['totalMoney'],
): boolean {
  if (!a || !b) return a === b;
  return (
    a.amount === b.amount &&
    a.currency === b.currency &&
    a.approximate === b.approximate &&
    a.kind === b.kind
  );
}

const sessionSpendOverrides = new Map<string, SessionSpendOverride>();
let sessionSpendRevision = 0;
type StoreChange = 'updated' | 'reset';

const subs = new Set<(change: StoreChange) => void>();

function notify(change: StoreChange = 'updated'): void {
  subs.forEach((fn) => fn(change));
}

/**
 * 浅合并 patch 到 session，处理 _count 嵌套对象的合并语义
 * （patch._count = { messages: 1 } 不应清掉同级 _count.tokens 等）。
 */
function mergeSession(prev: Session, patch: Partial<Session>): Session {
  const next: Session = { ...prev, ...patch };
  if (patch._count) {
    next._count = { ...prev._count, ...patch._count };
  }
  return next;
}

function mergeSessionPatch(
  prev: Partial<Session>,
  patch: Partial<Session>,
): Partial<Session> {
  const next = { ...prev, ...patch };
  if (patch._count) {
    next._count = { ...prev._count, ...patch._count };
  }
  return next;
}

/**
 * 自动起名的「即时标题预览」叠加层（sessionId → 预览标题）。
 *
 * 为什么必须是叠加层、而不是一次性 patchLocal：新建会话的 `sessions:created` push 会
 * 触发 `forceRefreshAll`，那次重拉从 DB 拿回的行**仍带默认哨兵**（权威标题要等
 * `maker:auto-title` 落库才有），会把只写进缓存的乐观标题冲掉 —— 表现为标题先显示
 * 用户那句话、又退回「未命名任务」，直到 IPC 回来（PR #1031 review P1）。
 *
 * 语义与 device-link 远程侧的 `remoteProjectsStore.pendingTitlePreview` 对称：只在
 * **权威标题仍是哨兵**时顶替显示，权威标题一到就自动让位并回收条目，不需要显式失效。
 */
const autoTitlePreviews = new Map<string, string>();

/**
 * 把预览叠加到「权威标题仍是哨兵」的行上；已经拿到权威标题的行顺手回收条目。
 *
 * 与 {@link applySessionSpendOverrides} 同构：都在 fetch 结果回填进缓存前跑一遍，
 * 让本地 override 活过全量刷新。
 *
 * **前置条件**:传进来的 list 里只能有「DB 值」与「权威 override 重放的值」——
 * 乐观值绝不能出现在这里,否则下面那条「非哨兵 → 回收」会把自己写上去的乐观值当成
 * 权威标题、把叠加层误回收(PR #1031 review P1)。这条前置由「乐观写入走
 * {@link applyOptimisticTitle}、不进 patchLocal」保证。
 */
function applyAutoTitlePreviews(list: Session[]): Session[] {
  if (autoTitlePreviews.size === 0) return list;
  let changed = false;
  const next = list.map((session) => {
    const preview = autoTitlePreviews.get(session.id);
    if (!preview) return session;
    // 权威标题已落地（不再是哨兵）→ 预览让位并回收，避免长期顶着真实标题。
    if (!isDefaultDraftSessionTitle(session.title)) {
      autoTitlePreviews.delete(session.id);
      return session;
    }
    if (session.title === preview) return session;
    changed = true;
    return mergeSession(session, { title: preview });
  });
  return changed ? next : list;
}

/**
 * 权威标题的「防旧快照」叠加层(sessionId → 标题 + 本地事件版本)。
 *
 * 与 {@link sessionSpendOverrides} 同一套机制、同一个理由:进行中的 `sessions:list`
 * 请求发起于这次标题变更**之前**,它的快照里还是旧标题,回来会 `cache.set` 整桶覆盖,
 * 把刚 patch 进去的权威标题冲掉。
 *
 * 典型时序(新建会话):`sessions:created` push → `forceRefreshAll()` 起飞(快照里是
 * 哨兵)→ main 写完占位 → `sessions:patched` 落进缓存 → 那个更早的请求才回来,把哨兵
 * 写回去,界面退到「未命名任务」直到下一次刷新。乐观预览叠加层此刻已按权威值到达的
 * 规则回收,没人再替它顶回来(PR #1031 review P1)。
 *
 * 方向与 {@link autoTitlePreviews} 互补:那一层管「请求发起于乐观写入**之后**、DB 里还
 * 没有值」,这一层管「请求发起于权威写入**之前**、快照里还是旧值」。
 */
interface SessionTitleOverride {
  revision: number;
  title: string;
}

const sessionTitleOverrides = new Map<string, SessionTitleOverride>();
let sessionTitleRevision = 0;

interface SessionStatusOverride {
  /** status 事件版本；rollback 用它区分同向状态是否有更晚的权威写入。 */
  revision: number;
  /** 后到的非 status 权威字段版本；只用于挡住更早起飞的列表快照。 */
  rowRevision: number;
  patch: Partial<Session>;
  /** 状态变化前从任一已加载桶捕获的完整行；目标桶缺行时可直接迁移。 */
  session: Session | null;
}

/**
 * 列表请求发起后到达的 status 事件。请求返回时重放这些事件，避免旧快照把已归档、
 * 已恢复或已删除的行写回旧桶；有完整行时也能把它补进目标桶。
 */
const sessionStatusOverrides = new Map<string, SessionStatusOverride>();
let sessionStatusRevision = 0;
let sessionStatusRowRevision = 0;

export interface SessionStatusTransitionToken {
  sessionId: string;
  token: number;
}

interface StatusBucketSnapshot {
  tailBefore: Session | null;
  evictedByOptimisticInsert: Session | null;
}

interface PendingStatusTransition {
  tokens: Set<number>;
  optimisticStatus: Session['status'];
  optimisticRevision: number;
  hasSucceeded: boolean;
  rollbackPatch: Partial<Session>;
  sourceSession: Session | null;
  /** 状态写在途期间后到的非 status 权威字段；成功行落缓存前必须最后重放。 */
  concurrentAuthoritativePatch: Partial<Session>;
  titleRevisionAtStart: number;
  spendRevisionAtStart: number;
  buckets: Map<ListStatusFilter, StatusBucketSnapshot>;
  /** 乐观移除前恰好满 1000 条的桶；等状态写收敛后定向补回新的尾项。 */
  vacatedFullBuckets: Set<ListStatusFilter>;
}

const pendingStatusTransitions = new Map<string, PendingStatusTransition>();
const pendingStatusTransitionWaiters = new Map<string, Set<() => void>>();
let statusTransitionToken = 0;
let statusTransitionGeneration = 0;

function clearPendingStatusTransition(
  sessionId: string,
  pending: PendingStatusTransition,
): void {
  if (pendingStatusTransitions.get(sessionId) !== pending) return;
  pendingStatusTransitions.delete(sessionId);
  const waiters = pendingStatusTransitionWaiters.get(sessionId);
  pendingStatusTransitionWaiters.delete(sessionId);
  waiters?.forEach((resolve) => resolve());
}

/** 同桶补查已有请求在途时只记一个 dirty 位，请求结束后最多追加一轮 fresh。 */
const trailingFilterRefreshes = new Set<ListStatusFilter>();

function belongsInFilter(status: Session['status'], filter: ListStatusFilter): boolean {
  if (status === 'deleted') return false;
  return filter === 'all' || filter === status;
}

function updatedAtMs(session: Session): number {
  const parsed = Date.parse(session.updatedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function statusPatchNeedsTargetBackfill(patch: Partial<Session>): boolean {
  if (patch.status === undefined || patch.status === 'deleted') return false;
  return typeof patch.updatedAt !== 'string' || !Number.isFinite(Date.parse(patch.updatedAt));
}

/** 与 sessions:list 的 updatedAt DESC 保持一致，并保留 1000 条硬上限。 */
function upsertSessionByUpdatedAt(list: Session[], session: Session): Session[] {
  const withoutSession = list.filter((item) => item.id !== session.id);
  const timestamp = updatedAtMs(session);
  const earlierIndex = withoutSession.findIndex((item) => timestamp > updatedAtMs(item));
  const insertAt = earlierIndex === -1 ? withoutSession.length : earlierIndex;
  return [
    ...withoutSession.slice(0, insertAt),
    session,
    ...withoutSession.slice(insertAt),
  ].slice(0, DEFAULT_LIMIT);
}

function recordPendingStatusEviction(
  sessionId: string,
  filter: ListStatusFilter,
  before: Session[],
  after: Session[],
): void {
  const pending = pendingStatusTransitions.get(sessionId);
  const tailBefore = before.length >= DEFAULT_LIMIT ? (before[before.length - 1] ?? null) : null;
  if (!pending || !tailBefore || after.some((item) => item.id === tailBefore.id)) return;
  pending.buckets.set(filter, {
    tailBefore,
    evictedByOptimisticInsert: tailBefore,
  });
}

function restorePendingStatusEvictions(
  pending: PendingStatusTransition,
  finalStatus: Session['status'],
): void {
  let restoredTail = false;
  for (const [filter, snapshot] of pending.buckets) {
    if (belongsInFilter(finalStatus, filter)) continue;
    const evicted = snapshot.evictedByOptimisticInsert;
    const list = cache.get(filter);
    if (!evicted || !list || list.some((item) => item.id === evicted.id)) continue;
    cache.set(filter, upsertSessionByUpdatedAt(list, evicted));
    restoredTail = true;
  }
  if (restoredTail) notify();
}

/**
 * 满桶移除一行会让数据库原第 1001 行进入结果集。pending 期间先记账，避免状态尚未
 * 落库时反复 fresh；没有 pending 时可立即定向补拉。
 */
function recordFullBucketVacancy(
  sessionId: string,
  filter: ListStatusFilter,
  before: Session[],
  after: Session[],
  pendingFallback?: PendingStatusTransition,
): boolean {
  if (after.length >= before.length) return false;
  let inheritsFullBucketVacancy = pendingFallback?.vacatedFullBuckets.has(filter) ?? false;
  if (!inheritsFullBucketVacancy) {
    for (const candidate of pendingStatusTransitions.values()) {
      if (!candidate.vacatedFullBuckets.has(filter)) continue;
      inheritsFullBucketVacancy = true;
      break;
    }
  }
  if (before.length < DEFAULT_LIMIT && !inheritsFullBucketVacancy) return false;
  const pending = pendingStatusTransitions.get(sessionId) ?? pendingFallback;
  if (pending) {
    pending.vacatedFullBuckets.add(filter);
    return false;
  }
  return true;
}

function requestPendingStatusVacancyBackfills(
  pending: PendingStatusTransition,
  finalStatus: Session['status'],
): void {
  for (const filter of pending.vacatedFullBuckets) {
    if (belongsInFilter(finalStatus, filter)) continue;
    const list = cache.get(filter);
    if (list && list.length >= DEFAULT_LIMIT) continue;
    requestFilterBackfill(filter);
  }
}

function applySessionStatusOverrides(
  list: Session[],
  filter: ListStatusFilter,
  afterRevision: number,
  afterRowRevision: number,
): Session[] {
  if (sessionStatusOverrides.size === 0) return list;
  let next = list;
  let changed = false;
  for (const [sessionId, override] of sessionStatusOverrides) {
    // 乐观状态在写库完成前必须跨过 request-start revision 持续生效；否则归档后、
    // DB 提交前启动的列表查询会把旧 active 行写回来。
    if (
      override.revision <= afterRevision &&
      override.rowRevision <= afterRowRevision &&
      !pendingStatusTransitions.has(sessionId)
    ) {
      continue;
    }
    const status = override.patch.status;
    if (!status) continue;
    const idx = next.findIndex((session) => session.id === sessionId);
    if (!belongsInFilter(status, filter)) {
      if (idx === -1) continue;
      const before = next;
      next = [...before.slice(0, idx), ...before.slice(idx + 1)];
      if (recordFullBucketVacancy(sessionId, filter, before, next)) {
        // 当前列表请求仍在 inflight 中，requestFilterBackfill 会把它折叠成一轮尾刷。
        requestFilterBackfill(filter);
      }
      changed = true;
      continue;
    }
    if (idx !== -1) {
      const before = next;
      next = upsertSessionByUpdatedAt(before, mergeSession(before[idx], override.patch));
      recordPendingStatusEviction(sessionId, filter, before, next);
      changed = true;
      continue;
    }
    if (override.session) {
      const before = next;
      next = upsertSessionByUpdatedAt(before, override.session);
      recordPendingStatusEviction(sessionId, filter, before, next);
      changed = true;
    }
  }
  return changed ? next : list;
}

/** 仅重放请求启动后到达的标题事件,避免旧事件覆盖未来数据库刷新。 */
function applySessionTitleOverrides(list: Session[], afterRevision: number): Session[] {
  if (sessionTitleOverrides.size === 0) return list;
  let changed = false;
  const next = list.map((session) => {
    const override = sessionTitleOverrides.get(session.id);
    if (!override || override.revision <= afterRevision) return session;
    if (override.title === session.title) return session;
    changed = true;
    return mergeSession(session, { title: override.title });
  });
  return changed ? next : list;
}

/** 仅重放请求启动后到达的费用事件，避免旧事件覆盖未来数据库刷新。 */
function applySessionSpendOverrides(list: Session[], afterRevision: number): Session[] {
  let changed = false;
  const next = list.map((session) => {
    const override = sessionSpendOverrides.get(session.id);
    if (!override || override.revision <= afterRevision) return session;
    const patch: Partial<Session> = {};
    if (
      override.totalCostUsd !== undefined &&
      override.totalCostUsd !== session.totalCostUsd
    ) {
      patch.totalCostUsd = override.totalCostUsd;
    }
    if (override.totalMoney && !sameMoney(override.totalMoney, session.totalMoney)) {
      patch.totalMoney = override.totalMoney;
    }
    if (Object.keys(patch).length === 0) return session;
    changed = true;
    return mergeSession(session, patch);
  });
  return changed ? next : list;
}

/**
 * **乐观标题的唯一写入口**:只把标题合并进各桶,什么簿记都不做。
 *
 * 与 `patchLocal`(权威写入口)刻意分开 —— 这是本 PR 反复栽的那个坑的结构性修法:
 * 两者共用一个门时,缓存里的串就分不出「乐观值」还是「权威值」,于是
 *
 *   - `patchLocal` 会给乐观值也登记 {@link sessionTitleOverrides},那层重放出来的乐观值
 *     又被 {@link applyAutoTitlePreviews} 当成权威标题、把叠加层误回收,后一次仍返回
 *     哨兵的刷新就再没人保护标题(PR #1031 review P1);
 *   - 反过来「权威值与乐观值同值」时也分不出来,失败撤回会把已落库的标题打回哨兵。
 *
 * 分门之后两层各自的判据都重新成立:override 里只有 main 说过的值,叠加层只对 DB 值
 * 让位。也因此不再需要「先 patch 后登记」那种依赖调用顺序的写法。
 */
function applyOptimisticTitle(id: string, title: string): void {
  let touched = false;
  for (const [filter, list] of cache) {
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) continue;
    if (list[idx].title === title) continue;
    cache.set(filter, [
      ...list.slice(0, idx),
      mergeSession(list[idx], { title }),
      ...list.slice(idx + 1),
    ]);
    touched = true;
  }
  if (touched) notify();
}

async function fetchFilter(
  filter: ListStatusFilter,
  opts?: { fresh?: boolean },
): Promise<Session[]> {
  // chat-data-localization round-5：IPC 'all'/undefined 与 HTTP 旧默认行为
  // 不一致，必须把 filter 原样透传，由 IPC handler 决定过滤语义。
  const spendRevisionAtStart = sessionSpendRevision;
  const titleRevisionAtStart = sessionTitleRevision;
  const statusRevisionAtStart = sessionStatusRevision;
  const statusRowRevisionAtStart = sessionStatusRowRevision;
  const startedAt = performance.now();
  const sessions = await sessionService.list(
    DEFAULT_LIMIT,
    filter,
    opts?.fresh ? { fresh: true } : undefined,
  );
  // 顺序:status override 可能携带写库返回的完整旧行,必须先应用；再重放请求期间到达的
  // 费用与权威标题,最后叠乐观标题预览。否则完整状态行会把这三类更新盖回旧值。
  const result = applyAutoTitlePreviews(
    applySessionTitleOverrides(
      applySessionSpendOverrides(
        applySessionStatusOverrides(
          sessions,
          filter,
          statusRevisionAtStart,
          statusRowRevisionAtStart,
        ),
        spendRevisionAtStart,
      ),
      titleRevisionAtStart,
    ),
  );
  const fields = {
    event: 'renderer.sessions.initial-fetch.done',
    filter,
    rows: result.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    rendererUptimeMs: Math.round(performance.now()),
  };
  if (initialFetchLogged.has(filter)) startupPerfLog.debug(fields);
  else {
    initialFetchLogged.add(filter);
    startupPerfLog.info(fields);
  }
  return result;
}

function runFilterBackfill(filter: ListStatusFilter): void {
  void sessionsStore.ensureByFilter(filter, { fresh: true }).catch(() => {
    /* 静默：后续状态广播、主动操作或 refresh 会再次兜底。 */
  });
}

/**
 * 缺少完整 row 时只补查需要包含它的桶。同桶若已有请求在途，不取消、不并发重启，
 * 只保留一个尾部 fresh；这样连续归档不会把每个状态事件放大成一轮列表查询。
 */
function requestFilterBackfill(filter: ListStatusFilter): void {
  if (inflight.has(filter)) {
    trailingFilterRefreshes.add(filter);
    return;
  }
  runFilterBackfill(filter);
}

function runTrailingFilterBackfill(filter: ListStatusFilter): void {
  if (!trailingFilterRefreshes.delete(filter)) return;
  runFilterBackfill(filter);
}

function recordStatusOverride(
  sessionId: string,
  patch: Partial<Session>,
  session: Session | null,
): void {
  sessionStatusRevision += 1;
  sessionStatusOverrides.set(sessionId, {
    revision: sessionStatusRevision,
    rowRevision: sessionStatusRowRevision,
    patch: { ...patch },
    session: patch.status === 'deleted' ? null : session,
  });
}

/**
 * 状态覆盖可能携带一整行；后到的权威字段必须同时合并进去，否则旧 list 响应重放状态时
 * 会把 model / effort / permissionMode 等 settings-only 更新盖回旧值。
 */
function mergeAuthoritativePatchIntoStatusOverride(
  sessionId: string,
  patch: Partial<Session>,
): void {
  const pending = pendingStatusTransitions.get(sessionId);
  if (pending) {
    pending.concurrentAuthoritativePatch = mergeSessionPatch(
      pending.concurrentAuthoritativePatch,
      patch,
    );
    if (pending.sourceSession) {
      pending.sourceSession = mergeSession(pending.sourceSession, patch);
    }
  }
  const override = sessionStatusOverrides.get(sessionId);
  if (!override) return;
  if (override.patch.status !== 'deleted') {
    sessionStatusRowRevision += 1;
    override.rowRevision = sessionStatusRowRevision;
    override.patch = mergeSessionPatch(override.patch, patch);
    if (override.session) {
      override.session = mergeSession(override.session, patch);
    }
  }
}

function applyAuthoritativeStatusSession(
  session: Session,
  pendingForBackfills?: PendingStatusTransition,
): void {
  recordStatusOverride(session.id, session, session);
  if (session.status === 'deleted') {
    autoTitlePreviews.delete(session.id);
    sessionTitleOverrides.delete(session.id);
    sessionSpendOverrides.delete(session.id);
  }
  let touched = false;
  const toBackfill = new Set<ListStatusFilter>();
  for (const [filter, list] of cache) {
    if (!belongsInFilter(session.status, filter)) {
      const next = list.filter((item) => item.id !== session.id);
      if (next.length === list.length) continue;
      cache.set(filter, next);
      if (
        recordFullBucketVacancy(
          session.id,
          filter,
          list,
          next,
          pendingForBackfills,
        )
      ) {
        toBackfill.add(filter);
      }
      touched = true;
      continue;
    }
    cache.set(filter, upsertSessionByUpdatedAt(list, session));
    touched = true;
  }
  if (touched) notify();
  for (const filter of toBackfill) requestFilterBackfill(filter);
}

export const sessionsStore = {
  subscribe(fn: (change: StoreChange) => void): () => void {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },

  /** 当前桶快照；null 表示该桶尚未加载过（hook 据此判定 isLoading 初值）。 */
  getByFilter(filter: ListStatusFilter): Session[] | null {
    return cache.get(filter) ?? null;
  },

  /**
   * 跨桶按 id 取当前缓存行；未加载 / 不在任何桶里时返回 null。
   *
   * 只读快照，给"下笔前先看一眼当前值"的乐观更新用（例如自动起名的即时标题预览
   * 要先确认标题仍是系统占位，别把用户手动改的名在 UI 上顶掉）。不触发拉取——
   * 拿不到就不做乐观更新，交给权威广播回填。
   */
  findById(id: string): Session | null {
    if (!id) return null;
    for (const bucket of cache.values()) {
      const hit = bucket.find((s) => s.id === id);
      if (hit) return hit;
    }
    return null;
  },

  /**
   * 确保指定桶已加载（命中即 noop，dedupe 并发请求）。
   * 失败时 throw 原始错误，由调用方决定如何展示。
   */
  async ensureByFilter(filter: ListStatusFilter, opts?: { fresh?: boolean }): Promise<void> {
    if (!opts?.fresh && cache.has(filter)) return;
    let promise = inflight.get(filter);
    if (!promise) {
      const request = fetchFilter(filter, opts)
        .then((data) => {
          // reset / forceRefresh 会把旧 request 从 inflight 移除。只有仍被
          // 当前桶认领的 request 才能提交，避免旧账号请求回填新账号缓存。
          if (inflight.get(filter) === request) {
            cache.set(filter, data);
            inflight.delete(filter);
            notify();
            runTrailingFilterBackfill(filter);
          }
          return data;
        })
        .catch((e) => {
          if (inflight.get(filter) === request) {
            inflight.delete(filter);
            runTrailingFilterBackfill(filter);
          }
          throw e;
        });
      promise = request;
      inflight.set(filter, promise);
    }
    await promise;
  },

  /** 强制重拉单桶（先 drop 再 ensure）。返回新数据。 */
  async forceRefresh(filter: ListStatusFilter): Promise<Session[]> {
    cache.delete(filter);
    inflight.delete(filter);
    trailingFilterRefreshes.delete(filter);
    await this.ensureByFilter(filter, { fresh: true });
    return cache.get(filter) ?? [];
  },

  /**
   * 重拉所有"已加载过"的桶，未加载的桶不动。
   * sessionsBus.onRefresh / sessionsPush.onCreated 走这条 ——
   * 无完整 row 的列表成员变化（main 端新建等）需要让所有活跃订阅者同步刷新。
   */
  async forceRefreshAll(): Promise<void> {
    const filters = Array.from(cache.keys());
    if (filters.length === 0) return;
    await Promise.all(filters.map((f) => this.forceRefresh(f)));
  },

  /**
   * 开始一次本地乐观状态迁移。pending 期间 status override 对之后启动的列表请求也
   * 持续生效；写库成功后必须 complete，失败后必须 rollback。
   */
  beginStatusTransition(
    id: string,
    patch: Partial<Session> & { status: Session['status'] },
  ): SessionStatusTransitionToken | null {
    if (!id) return null;
    statusTransitionToken += 1;
    const token = statusTransitionToken;
    const existing = pendingStatusTransitions.get(id);
    if (existing?.optimisticStatus === patch.status) {
      existing.tokens.add(token);
      return { sessionId: id, token };
    }
    const source = this.findById(id);
    const buckets = new Map<ListStatusFilter, StatusBucketSnapshot>();
    for (const [filter, list] of cache) {
      buckets.set(filter, {
        tailBefore: list.length >= DEFAULT_LIMIT ? (list[list.length - 1] ?? null) : null,
        evictedByOptimisticInsert: null,
      });
    }
    const rollbackPatch: Partial<Session> = {
      status:
        source?.status ??
        (patch.status === 'archived' ? 'active' : patch.status === 'active' ? 'archived' : 'active'),
      ...(patch.pinnedAt !== undefined ? { pinnedAt: source?.pinnedAt } : {}),
    };
    pendingStatusTransitions.set(id, {
      tokens: new Set([token]),
      optimisticStatus: patch.status,
      optimisticRevision: sessionStatusRevision + 1,
      hasSucceeded: false,
      rollbackPatch,
      sourceSession: source,
      concurrentAuthoritativePatch: {},
      titleRevisionAtStart: sessionTitleRevision,
      spendRevisionAtStart: sessionSpendRevision,
      buckets,
      vacatedFullBuckets: new Set(),
    });
    this.patchLocal(id, patch);
    for (const [filter, snapshot] of buckets) {
      const tail = snapshot.tailBefore;
      const current = cache.get(filter);
      if (tail && current && !current.some((item) => item.id === tail.id)) {
        snapshot.evictedByOptimisticInsert = tail;
      }
    }
    return { sessionId: id, token };
  },

  hasPendingStatusTransition(id: string): boolean {
    return Boolean(id) && pendingStatusTransitions.has(id);
  },

  /** 等同一会话的状态写收敛；reset 代表数据 owner 已切换，返回 false 让旧动作停止。 */
  async waitForStatusTransition(id: string): Promise<boolean> {
    if (!id) return false;
    const generation = statusTransitionGeneration;
    while (pendingStatusTransitions.has(id)) {
      await new Promise<void>((resolve) => {
        const waiters = pendingStatusTransitionWaiters.get(id) ?? new Set<() => void>();
        waiters.add(resolve);
        pendingStatusTransitionWaiters.set(id, waiters);
      });
      if (generation !== statusTransitionGeneration) return false;
    }
    return generation === statusTransitionGeneration;
  },

  /**
   * 等待既有状态写收敛后原子地 begin；多个等待者即使同时被唤醒，后续等待者也会
   * 看到前一个刚登记的 pending，不会用异向迁移覆盖它。apply 可保留调用侧 flushSync。
   */
  async beginStatusTransitionWhenReady(
    id: string,
    patch: Partial<Session> & { status: Session['status'] },
    apply?: (
      begin: () => SessionStatusTransitionToken | null,
    ) => SessionStatusTransitionToken | null,
  ): Promise<SessionStatusTransitionToken | null> {
    if (!id) return null;
    const generation = statusTransitionGeneration;
    while (pendingStatusTransitions.has(id)) {
      await new Promise<void>((resolve) => {
        const waiters = pendingStatusTransitionWaiters.get(id) ?? new Set<() => void>();
        waiters.add(resolve);
        pendingStatusTransitionWaiters.set(id, waiters);
      });
      if (generation !== statusTransitionGeneration) return null;
    }
    if (generation !== statusTransitionGeneration) return null;
    const begin = () => this.beginStatusTransition(id, patch);
    return apply ? apply(begin) : begin();
  },

  /** 用写库返回的完整行结束乐观迁移，并按服务端 updatedAt DESC 重排所有已加载桶。 */
  completeStatusTransition(token: SessionStatusTransitionToken, persisted: Session): boolean {
    const pending = pendingStatusTransitions.get(token.sessionId);
    if (!pending || persisted.id !== token.sessionId || !pending.tokens.delete(token.token)) {
      return false;
    }
    const latestOverride = sessionStatusOverrides.get(token.sessionId);
    if (latestOverride?.patch.status !== persisted.status) {
      clearPendingStatusTransition(token.sessionId, pending);
      if (latestOverride?.patch.status) {
        restorePendingStatusEvictions(pending, latestOverride.patch.status);
        requestPendingStatusVacancyBackfills(pending, latestOverride.patch.status);
      }
      return false;
    }
    pending.hasSucceeded = true;
    if (pending.tokens.size === 0) clearPendingStatusTransition(token.sessionId, pending);
    const current = this.findById(token.sessionId);
    const authoritativeBase =
      current?.status === persisted.status && updatedAtMs(current) >= updatedAtMs(persisted)
        ? current
        : persisted;
    // 只有源桶加载时，乐观归档会先移除最后一份缓存行；这期间到达的 settings-only
    // 权威广播无法从 findById 取回。它们晚于状态请求起飞，必须在 persisted 完整行之上
    // 最后重放，同时保留 persisted 的新 status / updatedAt。
    const authoritative = mergeSession(authoritativeBase, pending.concurrentAuthoritativePatch);
    const [withOverrides] = applyAutoTitlePreviews(
      applySessionTitleOverrides(
        applySessionSpendOverrides([authoritative], pending.spendRevisionAtStart),
        pending.titleRevisionAtStart,
      ),
    );
    applyAuthoritativeStatusSession(withOverrides ?? authoritative, pending);
    if (pending.tokens.size === 0) {
      requestPendingStatusVacancyBackfills(pending, persisted.status);
    }
    return true;
  },

  /** 写库失败时恢复原状态，并补回乐观插入在 1000 条上限处挤出的尾项。 */
  rollbackStatusTransition(token: SessionStatusTransitionToken): boolean {
    const pending = pendingStatusTransitions.get(token.sessionId);
    if (!pending || !pending.tokens.delete(token.token)) return false;
    const latestOverride = sessionStatusOverrides.get(token.sessionId);
    if (latestOverride?.patch.status !== pending.optimisticStatus) {
      clearPendingStatusTransition(token.sessionId, pending);
      if (latestOverride?.patch.status) {
        restorePendingStatusEvictions(pending, latestOverride.patch.status);
        requestPendingStatusVacancyBackfills(pending, latestOverride.patch.status);
      }
      return false;
    }
    if (pending.tokens.size > 0) return true;
    clearPendingStatusTransition(token.sessionId, pending);
    if (
      pending.hasSucceeded ||
      (latestOverride.revision !== pending.optimisticRevision &&
        latestOverride.patch.status === pending.optimisticStatus)
    ) {
      requestPendingStatusVacancyBackfills(pending, pending.optimisticStatus);
      return true;
    }
    if (pending.sourceSession) {
      const [withOverrides] = applyAutoTitlePreviews(
        applySessionTitleOverrides(
          applySessionSpendOverrides(
            [mergeSession(pending.sourceSession, pending.rollbackPatch)],
            pending.spendRevisionAtStart,
          ),
          pending.titleRevisionAtStart,
        ),
      );
      applyAuthoritativeStatusSession(
        withOverrides ?? mergeSession(pending.sourceSession, pending.rollbackPatch),
        pending,
      );
    } else {
      this.patchLocal(token.sessionId, pending.rollbackPatch);
    }
    restorePendingStatusEvictions(
      pending,
      pending.rollbackPatch.status ?? pending.sourceSession?.status ?? 'active',
    );
    requestPendingStatusVacancyBackfills(
      pending,
      pending.rollbackPatch.status ?? pending.sourceSession?.status ?? 'active',
    );
    return true;
  },

  /**
   * 局部合并（rename / pin / title / updatedAt / model / clearSession 等
   * "字段变化"全部走这里）。遍历所有桶：命中即合并字段，保留位置不重排序。
   *
   * 跨桶迁移特例：当 patch.status 出现时，session 的桶归属可能变化。
   * 如果只就地改字段而不修正归属，会导致：
   *   1. 旧桶里"假活着"（status 已变但条目仍在）
   *   2. 新桶 cache 命中但缺这一条（用户切桶后看不到）
   *
   * 两种不一致都优先在本地修正，别退回"一律 drop 重拉"：
   *   - 「在桶里但已不该在」（归档时的 active 桶）→ **就地移除**。归属判定是
   *     确定的（status 已经变了），无需等 IPC。
   *     这里 drop 桶是曾经的性能陷阱：桶变 null 后 useCCSessions 的
   *     `next !== null` 守卫会跳过 setState，视图停在**仍含该行**的陈旧快照，
   *     一直等到重拉的 sessions:list 回来才更新 —— 表现为"点归档后半秒对话
   *     才消失"，把调用方 useSessionLifecycleActions 的乐观更新整段抵消掉。
   *   - 「不在桶里但该在」（归档时的 archived 桶）→ 从 active / all 任一桶捕获
   *     完整 row 后直接插入。所有桶都找不到 row，或 status 广播没有携带 DB 已更新的
   *     updatedAt 时，再定向补查目标桶以校正排序和 1000 条边界。
   * deleted 从所有桶移除即可；旧在途请求由 status override 过滤，不再取消并重启。
   */
  patchLocal(id: string, patch: Partial<Session>): void {
    if (!id || !patch) return;
    const pendingBeforePatch =
      patch.status !== undefined ? pendingStatusTransitions.get(id) : undefined;
    const sourceSession = patch.status !== undefined ? this.findById(id) : null;
    const migratedSession = sourceSession ? mergeSession(sourceSession, patch) : null;
    const needsTargetBackfill = statusPatchNeedsTargetBackfill(patch);
    if (patch.status !== undefined) {
      recordStatusOverride(id, patch, migratedSession);
    } else {
      mergeAuthoritativePatchIntoStatusOverride(id, patch);
    }
    // 权威标题落地(main 写完占位 / 智能标题后经 sessions:patched 回流,或用户手动改名)
    // → 无条件回收预览条目。留着它会在下一次全量刷新时把真实标题又顶掉。
    //
    // **包括「权威标题与预览逐字相同」的常见情形**(两端共用 normalizeAutoTitle,占位本来
    // 就该一样)。曾经在这里放过 `preview !== patch.title` 的例外,结果是缓存里那个串到底
    // 是「叠加上去的乐观值」还是「已落库的权威值」再也分不出来 —— 随后的失败撤回会把
    // **已经落库**的标题打回哨兵、界面退到「未命名任务」并与 DB 不一致(PR #1031 review P1)。
    // 语义上也该无条件回收:DB 已经有值,叠加层的唯一用途(盖住仍是哨兵的行)已经消失。
    //
    // 乐观预览不走这个门(见 {@link applyOptimisticTitle}),所以这里见到的标题一律是
    // main 说过的权威值 —— 判据不必、也无法再去分辨来源。
    //
    // **不看值、只看「是不是权威写入」**:用户完全可以手动把标题改成字面量 "New Maker"
    // (main 侧专门有 manuallyRenamed 记号处理这种同值改名),那也是一次权威写入。曾经
    // 在这里排除过哨兵值,结果是那种改名之后预览还留着,下一次刷新先重放权威值、紧接着
    // 又被陈旧预览盖回第一句话,用户的标题显示不出来(PR #1031 review P1)。
    if (typeof patch.title === 'string') {
      autoTitlePreviews.delete(id);
    }
    // 每一次**权威**标题写入(占位 / 智能标题回流、用户改名)都登记版本化 override:
    // 发起于本次写入之前的 list 请求回来时,快照里还是旧标题,必须被这一层挡住,
    // 否则整桶覆盖会把刚写进缓存的标题冲掉(见 sessionTitleOverrides 的说明)。
    // 每次写入都登记 = 最新一次写入总是最高版本,先后顺序天然正确。
    if (typeof patch.title === 'string') {
      sessionTitleRevision += 1;
      sessionTitleOverrides.set(id, { revision: sessionTitleRevision, title: patch.title });
    }
    if (patch.status === 'deleted') {
      autoTitlePreviews.delete(id);
      sessionTitleOverrides.delete(id);
      sessionSpendOverrides.delete(id);
    }
    if (patch.totalCostUsd !== undefined || patch.totalMoney !== undefined) {
      sessionSpendRevision += 1;
      const prev = sessionSpendOverrides.get(id);
      sessionSpendOverrides.set(id, {
        revision: sessionSpendRevision,
        totalCostUsd: patch.totalCostUsd ?? prev?.totalCostUsd,
        totalMoney: patch.totalMoney ?? prev?.totalMoney,
      });
    }
    let touched = false;
    const toBackfill = new Set<ListStatusFilter>();
    if (patch.status === undefined) {
      for (const [filter, list] of cache) {
        const idx = list.findIndex((session) => session.id === id);
        if (idx === -1) continue;
        cache.set(filter, [
          ...list.slice(0, idx),
          mergeSession(list[idx], patch),
          ...list.slice(idx + 1),
        ]);
        touched = true;
      }
    } else {
      const loadedFilters = new Set<ListStatusFilter>([...cache.keys(), ...inflight.keys()]);
      for (const filter of loadedFilters) {
        const belongs = belongsInFilter(patch.status, filter);
        // sessions.setStatus 等批量入口只广播 { status }，但 DB 已把 updatedAt bump 到当前
        // 时间。先用缓存行即时迁移，再补拉应包含它的桶，否则会按旧时间错排，满 1000 条
        // 时甚至可能把本应进入结果集的新近任务裁掉。pending 本地写入会在下方继续延后，
        // 由 completeStatusTransition 返回的完整持久行直接收敛，避免多打一轮请求。
        if (belongs && needsTargetBackfill) toBackfill.add(filter);
        const list = cache.get(filter);
        if (!list) {
          if (belongs && !migratedSession) toBackfill.add(filter);
          continue;
        }
        const idx = list.findIndex((session) => session.id === id);
        if (!belongs) {
          if (idx === -1) continue;
          const next = [...list.slice(0, idx), ...list.slice(idx + 1)];
          cache.set(filter, next);
          if (recordFullBucketVacancy(id, filter, list, next)) {
            toBackfill.add(filter);
          }
          touched = true;
          continue;
        }
        if (idx !== -1) {
          const merged = mergeSession(list[idx], patch);
          cache.set(
            filter,
            needsTargetBackfill
              ? [...list.slice(0, idx), merged, ...list.slice(idx + 1)]
              : upsertSessionByUpdatedAt(list, merged),
          );
          touched = true;
          continue;
        }
        if (migratedSession) {
          cache.set(filter, upsertSessionByUpdatedAt(list, migratedSession));
          touched = true;
        } else {
          toBackfill.add(filter);
        }
      }
    }
    if (touched) notify();
    if (
      pendingBeforePatch &&
      patch.status !== undefined &&
      patch.status !== pendingBeforePatch.optimisticStatus &&
      pendingStatusTransitions.get(id) === pendingBeforePatch
    ) {
      clearPendingStatusTransition(id, pendingBeforePatch);
      restorePendingStatusEvictions(pendingBeforePatch, patch.status);
      requestPendingStatusVacancyBackfills(pendingBeforePatch, patch.status);
    }
    if (pendingStatusTransitions.has(id)) return;
    for (const filter of toBackfill) {
      requestFilterBackfill(filter);
    }
  },

  /**
   * 本地插入新建 session（renderer 主动 createSession 时用，省一次 IPC 重拉）。
   * 'active' / 'all' 桶头部插入；'archived' 桶按业务永远不应包含新建项，跳过。
   * 已存在则不重复插入（防御并发触发）。
   */
  prependCreated(session: Session): void {
    if (!session?.id) return;
    // 插入前叠乐观预览:createSession 往往先于 sessions:created 刷新返回,但预览
    // 必须在入库前就登记。若不在这里叠,第一帧仍是哨兵,用户会先看到「未命名任务」。
    const [withPreview] = applyAutoTitlePreviews([session]);
    let touched = false;
    for (const [k, list] of cache) {
      if (k === 'archived') continue;
      if (list.some((s) => s.id === session.id)) continue;
      cache.set(k, [withPreview, ...list]);
      touched = true;
    }
    if (touched) notify();
  },

  /** 仅供测试 / 登出清理。 */
  reset(): void {
    cache.clear();
    inflight.clear();
    sessionSpendOverrides.clear();
    autoTitlePreviews.clear();
    sessionTitleOverrides.clear();
    sessionStatusOverrides.clear();
    statusTransitionGeneration += 1;
    pendingStatusTransitions.clear();
    for (const waiters of pendingStatusTransitionWaiters.values()) {
      waiters.forEach((resolve) => resolve());
    }
    pendingStatusTransitionWaiters.clear();
    trailingFilterRefreshes.clear();
    initialFetchLogged.clear();
    notify('reset');
  },
};

/* ============================== 自订阅 ============================== */
/* 模块加载时一次性挂上，避免每个 hook 实例重复订阅。
 * 守卫 window/electronAPI 的存在性，规避 SSR / 测试 / preload 未就绪场景。 */

if (typeof window !== 'undefined') {
  onPatch((sessionId, patch) => sessionsStore.patchLocal(sessionId, patch));
  onRefresh(() => {
    void sessionsStore.forceRefreshAll();
  });

  // 自动起名的即时标题预览 —— 条件更新,判定放在这里是因为**本模块持有列表缓存**:
  //
  //   - 标题仍是「尚未起名」哨兵 → 乐观写入,侧边栏 / 会话头 / tab 立刻显示用户刚写
  //     的话,不必干等 `maker:auto-title` 的 IPC 往返 + DB 广播回流;
  //   - 已经起过名 / 用户手动改过名 / fork 与纯附件的合成占位 → 一律不动。能否覆写
  //     那几类占位由 main 的归属表裁决,这里猜错会把用户的标题在 UI 上顶掉。
  //
  // 先记进 autoTitlePreviews 叠加层再 patch:光 patch 缓存会被随后的 forceRefreshAll
  // (新建会话的 sessions:created push 触发)用仍带哨兵的 DB 快照冲掉。**登记不看当前
  // 缓存**——桶未加载时 findById 拿不到行,但那之后的首次 fetch 同样需要叠加。
  //
  // 只改本地缓存、不写 DB:权威标题仍由 main 落库后经 sessions:patched 广播回来,
  // 那个串与这里预览的是同一个(共用 normalizeAutoTitle),所以回流时不跳变。
  onAutoTitlePreview((sessionId, title) => {
    const current = sessionsStore.findById(sessionId);
    // 已有权威标题(非哨兵)→ 连叠加层都不登记,免得之后顶掉它。
    if (current && !isDefaultDraftSessionTitle(current.title)) return;
    // 乐观写入走专门的门:不登记权威 override、不回收叠加层,顺序无所谓。
    autoTitlePreviews.set(sessionId, title);
    if (current) applyOptimisticTitle(sessionId, title);
  });

  // 起名彻底失败 → 撤回预览。叠加层的失效条件是「权威标题落地」,失败时那个条件永远
  // 不成立,预览会在每次全量刷新后继续顶着 DB 里的哨兵,会话永久显示一个库里不存在的
  // 标题(重启后又变回兜底文案)。见 sessionsBus.emitAutoTitlePreviewCleared。
  onAutoTitlePreviewCleared((sessionId) => {
    const preview = autoTitlePreviews.get(sessionId);
    if (preview === undefined) return;
    autoTitlePreviews.delete(sessionId);
    // 只在缓存里那行仍显示着**这次**预览时才还原:权威标题已经回流(或用户手动改名)
    // 时缓存里是别的串,迟到的撤回不许把它冲掉。
    const current = sessionsStore.findById(sessionId);
    if (current?.title !== preview) return;
    // 撤回是**本地回滚**(把乐观值抹掉、露出 DB 里的哨兵),不是权威写入:同样走乐观门,
    // 免得往 override 层里塞一个 main 从没说过的值。
    applyOptimisticTitle(sessionId, DEFAULT_DRAFT_SESSION_TITLE);
  });

  window.electronAPI?.onUsageSessionSpendChanged?.(
    ({ sessionId, totalMoney, totalCostUsd }, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      sessionsStore.patchLocal(sessionId, {
        ...(totalMoney ? { totalMoney } : {}),
        ...(typeof totalCostUsd === 'number' ? { totalCostUsd } : {}),
      });
    },
  );

  const sessionsPush = window.electronAPI?.localDb?.sessionsPush;
  if (sessionsPush) {
    sessionsPush.onPatched(({ sessionId, patch }, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      sessionsStore.patchLocal(sessionId, patch);
    });
    sessionsPush.onCreated((_payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      // payload 只有 sessionId 不带完整 Session row，prependCreated 用不上 ——
      // 直接重拉所有已加载桶让新 session 出现在 sidebar。
      void sessionsStore.forceRefreshAll();
    });
  }

  const scheduleApi = window.electronAPI?.maker?.schedule;
  if (scheduleApi) {
    scheduleApi.onEvent((event: unknown, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      if (
        event &&
        typeof event === 'object' &&
        'type' in event &&
        event.type === 'session-bound'
      ) {
        void sessionsStore.forceRefreshAll();
      }
    });
  }
}
