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
 *                                   同级计数清掉。
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
import { onPatch, onRefresh } from '@/lib/sessionsBus';

// V1.7：取消 16 条上限，全量拉取由 Sidebar 中部滚动条承载。
// 后端硬上限 1000，覆盖几乎所有真实用户的 Session 总数。
const DEFAULT_LIMIT = 1000;

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

async function fetchFilter(filter: ListStatusFilter): Promise<Session[]> {
  // chat-data-localization round-5：IPC 'all'/undefined 与 HTTP 旧默认行为
  // 不一致，必须把 filter 原样透传，由 IPC handler 决定过滤语义。
  const spendRevisionAtStart = sessionSpendRevision;
  const sessions = await sessionService.list(DEFAULT_LIMIT, filter);
  return applySessionSpendOverrides(sessions, spendRevisionAtStart);
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
   * 确保指定桶已加载（命中即 noop，dedupe 并发请求）。
   * 失败时 throw 原始错误，由调用方决定如何展示。
   */
  async ensureByFilter(filter: ListStatusFilter): Promise<void> {
    if (cache.has(filter)) return;
    let promise = inflight.get(filter);
    if (!promise) {
      const request = fetchFilter(filter)
        .then((data) => {
          // reset / forceRefresh 会把旧 request 从 inflight 移除。只有仍被
          // 当前桶认领的 request 才能提交，避免旧账号请求回填新账号缓存。
          if (inflight.get(filter) === request) {
            cache.set(filter, data);
            inflight.delete(filter);
            notify();
          }
          return data;
        })
        .catch((e) => {
          if (inflight.get(filter) === request) {
            inflight.delete(filter);
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
    await this.ensureByFilter(filter);
    return cache.get(filter) ?? [];
  },

  /**
   * 重拉所有"已加载过"的桶，未加载的桶不动。
   * sessionsBus.onRefresh / sessionsPush.onCreated 走这条 ——
   * 列表成员变化（删除 / 归档 / main 端新建）需要让所有活跃订阅者同步刷新。
   */
  async forceRefreshAll(): Promise<void> {
    const filters = Array.from(cache.keys());
    if (filters.length === 0) return;
    await Promise.all(filters.map((f) => this.forceRefresh(f)));
  },

  /**
   * 局部合并（rename / pin / title / updatedAt / model / clearSession 等
   * "字段变化"全部走这里）。遍历所有桶：命中即合并字段，保留位置不重排序。
   *
   * 跨桶迁移特例：当 patch.status 出现时，session 的桶归属可能变化。
   * deleted 的归属是确定的，直接从所有已加载桶移除，不依赖后台重拉；
   * active ↔ archived 既要移出旧桶、又可能加入已加载的新桶，仍需 drop 不一致的桶重拉。
   * 如果只就地改字段而不修正归属，会导致：
   *   1. 旧桶里"假活着"（status 已变但条目仍在）
   *   2. 新桶 cache 命中但缺这一条（用户切桶后看不到）
   * 因此 status 变更后,把所有桶归属判定与实际不符的桶 drop 掉,下次
   * ensureByFilter 重拉获取一致的数据。'all' 桶仅排除 deleted。
   */
  patchLocal(id: string, patch: Partial<Session>): void {
    if (!id || !patch) return;
    if (patch.status === 'deleted') {
      sessionSpendOverrides.delete(id);
      // 删除前发出的请求可能仍会返回包含该 session 的旧快照。先解除这些
      // request 对桶的认领，再为对应桶发起替代请求，避免旧响应重新写回。
      const toRefetch = Array.from(inflight.keys());
      for (const filter of toRefetch) {
        inflight.delete(filter);
      }
      let removed = false;
      for (const [filter, list] of cache) {
        if (!list.some((session) => session.id === id)) continue;
        cache.set(
          filter,
          list.filter((session) => session.id !== id),
        );
        removed = true;
      }
      if (removed) notify();
      for (const filter of toRefetch) {
        void this.ensureByFilter(filter).catch(() => {
          /* 静默：后续主动操作或 refresh 会再次兜底。 */
        });
      }
      return;
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
    for (const [k, list] of cache) {
      const idx = list.findIndex((s) => s.id === id);
      if (idx !== -1) {
        const merged = mergeSession(list[idx], patch);
        cache.set(k, [...list.slice(0, idx), merged, ...list.slice(idx + 1)]);
        touched = true;
      }
    }
    const toRefetch: ListStatusFilter[] = [];
    if (patch.status !== undefined) {
      const newStatus = patch.status;
      const belongsIn = (filter: ListStatusFilter): boolean => {
        if (filter === 'all') return true;
        return filter === newStatus;
      };
      for (const filter of Array.from(cache.keys())) {
        const list = cache.get(filter);
        if (!list) continue;
        const has = list.some((s) => s.id === id);
        if (has !== belongsIn(filter)) {
          cache.delete(filter);
          inflight.delete(filter);
          toRefetch.push(filter);
          touched = true;
        }
      }
    }
    if (touched) notify();
    // 被 drop 的桶通常有 active 订阅者(否则不会进 cache);只 drop 不主动拉,
    // 订阅者的 subscribe 回调拿到 null 不会 setState,会一直停在陈旧 snapshot。
    // 主动 ensure 一下,IPC 回来后 notify → 订阅者拿到新数据自动 swap。
    for (const filter of toRefetch) {
      void this.ensureByFilter(filter).catch(() => {
        /* 静默:网络/IPC 失败由后续主动操作或 refresh 兜底,不上报 toast */
      });
    }
  },

  /**
   * 本地插入新建 session（renderer 主动 createSession 时用，省一次 IPC 重拉）。
   * 'active' / 'all' 桶头部插入；'archived' 桶按业务永远不应包含新建项，跳过。
   * 已存在则不重复插入（防御并发触发）。
   */
  prependCreated(session: Session): void {
    if (!session?.id) return;
    let touched = false;
    for (const [k, list] of cache) {
      if (k === 'archived') continue;
      if (list.some((s) => s.id === session.id)) continue;
      cache.set(k, [session, ...list]);
      touched = true;
    }
    if (touched) notify();
  },

  /** 仅供测试 / 登出清理。 */
  reset(): void {
    cache.clear();
    inflight.clear();
    sessionSpendOverrides.clear();
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

  window.electronAPI?.onUsageSessionSpendChanged?.(
    ({ sessionId, totalMoney, totalCostUsd }) => {
      sessionsStore.patchLocal(sessionId, {
        ...(totalMoney ? { totalMoney } : {}),
        ...(typeof totalCostUsd === 'number' ? { totalCostUsd } : {}),
      });
    },
  );

  const sessionsPush = window.electronAPI?.localDb?.sessionsPush;
  if (sessionsPush) {
    sessionsPush.onPatched(({ sessionId, patch }) =>
      sessionsStore.patchLocal(sessionId, patch),
    );
    sessionsPush.onCreated(() => {
      // payload 只有 sessionId 不带完整 Session row，prependCreated 用不上 ——
      // 直接重拉所有已加载桶让新 session 出现在 sidebar。
      void sessionsStore.forceRefreshAll();
    });
  }

  const scheduleApi = window.electronAPI?.maker?.schedule;
  if (scheduleApi) {
    scheduleApi.onEvent((event: unknown) => {
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
