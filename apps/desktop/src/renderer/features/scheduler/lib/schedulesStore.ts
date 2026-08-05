/**
 * schedulesStore — Schedule 列表的模块级单例 store
 * ---------------------------------------------------------------------------
 * 照搬 `apps/desktop/src/renderer/lib/sessionsStore.ts` 范式,把"数据所有权"
 * 从组件树(useState)搬到模块级,解决:
 *
 *   1. Tab/路由切换让 SchedulerPage unmount → remount 重新 fetch → 旧版会闪
 *      "加载失败" 或空白 / loading 帧。store 后 remount 直接命中模块 cache,
 *      loading=false,零闪烁。
 *
 *   2. 老 useSchedules 在 cold-start race(scheduler IPC handler 注册前 mount)
 *      会拿到 "No handler registered" → 永久卡死。新模型靠两层兜底:
 *        a. main 端 handler 已经做 `awaitReady` 等待(maker-ipc/schedule.ts),
 *           cold-start 期 list IPC 自然 pending 而非 error。
 *        b. store 模块加载时挂 `onEvent('ready')` listener;切账号 relogin 场景
 *           会清 cache → 等 main 发 'ready' → 后台预热,用户切到自动化页零延迟。
 *
 *   3. 多 hook 实例(SchedulerPage / 未来其它入口)各自 fetch + 各自订阅。
 *      store 后:模块加载时订阅一次,所有 subscriber 共享一份 cache + 一次 IPC。
 *
 * ── 切账号 (logout → login) 防污染 ─────────────────────────────────────────
 *
 * `auth:logout` 不重启 renderer 进程(`bootstrap-electron.ts:1579-1606` 确认),
 * module-level cache 跟 renderer 进程同生命周期,**logout 不会清它**。如果不主动
 * 清掉,user A → logout → user B 后还会看到 user A 的 schedule 列表。
 *
 * 模式照 `apps/desktop/src/renderer/features/skillhub/hooks/useSkillhub.ts:205-212`:
 * 模块加载时挂 `window.electronAPI.onAuthStateChange(...)` 一次,登出时清 cache +
 * 置 wasReset=true,下一次 main 发 'ready' 触发后台预热。
 *
 * ── wasReset flag 的作用 ───────────────────────────────────────────────────
 *
 * `'ready'` 事件冷启动和 relogin 都会发,但两种场景处理不同:
 *   - 冷启动:useSchedules mount → ensure() 已经在 awaitReady, main 端 list IPC
 *     setSchedulerReady 后立刻返回真数据 → 没必要再触发一次 forceRefresh。
 *   - Relogin:cache 已被 logout listener 清空,但 useSchedules 可能尚未 mount
 *     (用户停在 chat 页),'ready' 触发后台预热让用户切过去时零延迟。
 *
 * wasReset 区分这两个场景:logout listener 置 true,'ready' 处理只在 true 时
 * forceRefresh + 清回 false。
 */

import { useSyncExternalStore } from 'react';
import type { Schedule, SchedulerEvent } from '@cindy/maker-scheduler';

let cache: Schedule[] | null = null;
let inflight: Promise<Schedule[]> | null = null;
let lastError: string | null = null;
/**
 * Logout listener 置 true → 下一次 'ready' 后台预热,避免冷启动场景下
 * ensure() 和 'ready' broadcast 几乎同时到造成的冗余 list 调用。
 */
let wasReset = false;
/**
 * 切账号 generation。logout 时自增,使**登出前已发起、登出后才返回**的 in-flight
 * list 请求作废 —— fetchAndStore 在发起时捕获当前 epoch,回写 cache/lastError 前
 * 校验 epoch 未变。否则会发生跨账号串库:账号 A 的 list 请求在 logout 后才返回,
 * 把 A 的任务列表写进账号 B 的 cache(review [阻断] 项)。
 * 清 cache/inflight 只断引用,断不掉已 await 在途的 promise,必须靠 epoch 失效回写。
 */
let epoch = 0;

const subs = new Set<() => void>();

function notify(): void {
  subs.forEach((fn) => fn());
}

/**
 * 真正发起 list IPC + 落 cache 的内部 helper,ensure / forceRefresh 共用。
 *
 * - inflight 去重:并发调用共享同一个 promise,只打一次 IPC。
 * - **不清 cache**:成功才用新数据覆盖,失败保留旧 cache(stale-if-error)。
 *   这是实现 stale-while-revalidate 的关键 —— 刷新期间老列表始终可见,杜绝
 *   CLAUDE.md §12 的空白帧 / 列表闪烁。
 */
async function fetchAndStore(): Promise<Schedule[]> {
  if (inflight) return inflight;
  // 捕获发起时的 epoch。所有副作用(写 cache/lastError、清 inflight)都用
  // myEpoch === epoch 守卫:
  //   - 同 epoch(未切账号):dedup 保证同一时刻只有一个 in-flight,本 promise 就是
  //     当前 inflight,正常回写 + 清 inflight。
  //   - 跨 epoch(期间登出过):本 promise 是上个账号的晚到请求,全部副作用跳过 ——
  //     不回写 cache(防串库),也不清 inflight(此刻 inflight 可能已是新账号的 pB)。
  const myEpoch = epoch;
  inflight = (async (): Promise<Schedule[]> => {
    try {
      const list = (await window.electronAPI.maker.schedule.list()) as Schedule[];
      if (myEpoch === epoch) {
        cache = list;
        lastError = null;
        notify();
      }
      return list;
    } catch (e) {
      if (myEpoch === epoch) {
        lastError = e instanceof Error ? e.message : String(e);
        notify();
      }
      throw e;
    } finally {
      if (myEpoch === epoch) inflight = null;
    }
  })();
  return inflight;
}

/** 命中 cache 直接返回(零 IPC);未命中走 fetchAndStore。 */
async function ensure(): Promise<Schedule[]> {
  if (cache) return cache;
  return fetchAndStore();
}

/**
 * 强制重拉。**不清 cache** —— 老列表在 IPC 在途期间始终可见,拉到新数据再 swap
 * (stale-while-revalidate),零空白帧(CLAUDE.md §12)。
 *
 * 区别于 sessionsStore.forceRefresh 的 clear-then-fetch:那边是**多桶** store,
 * clear 是 patchLocal 跨桶失效的需要,且 useCCSessions 在 hook 层用 "subscribe
 * 只在 non-null 时 swap" 兜底防闪。本 store 是**单列表**,没有跨桶问题,直接在
 * store 层保证 cache 永不在刷新期变 null 更简单 —— 任何 consumer(含
 * useSyncExternalStore 直读 getSnapshot)都自动零闪烁。cache 只在登出时清
 * (handleAuthStateChange)。
 */
async function forceRefresh(): Promise<Schedule[]> {
  return fetchAndStore();
}

// ── 事件 handler(抽出来 export 让 vitest 可以直接调,不经 window listener)──
// 模块顶部 if window 自动 wire 到 window.electronAPI 上;test 环境 window
// undefined 时跳过 wire,test 直接 import handler 函数手动触发。

/**
 * SchedulerEvent 入口 handler — main 端 broadcast 的所有 scheduler 事件先到这里,
 * 按 type 分流。store 只关心 'ready' / 'changed';其它事件由 useSchedules /
 * useRuns 等下游 hook 各自处理(useRuns 也订阅同一 channel)。
 */
export function handleSchedulerEvent(raw: unknown): void {
  const ev = raw as SchedulerEvent;
  if (ev.type === 'ready') {
    // 'ready' = scheduler 实例此刻就绪。两种情况要借它重拉:
    //   - wasReset:切账号 relogin,cache 已被 logout listener 清空,后台预热让用户
    //     切到自动化页时零延迟。
    //   - lastError:冷启动时 scheduler 启动 >30s,首次 list IPC 撞 main 端 readiness
    //     超时报错、store 停在错误态;'ready' 正是「现在可以重试了」的信号,借它自愈,
    //     否则 UI 会一直卡「加载失败」直到用户切走再切回页面。
    // 正常冷启动(两者都 false):ensure() 已经把数据拿到,no-op,不重复打 IPC。
    if (wasReset || lastError) {
      wasReset = false;
      void forceRefresh().catch(() => {
        /* 静默:错误已由 fetchAndStore() 内部写到 lastError + notify,SchedulerPage 会显示 */
      });
    }
    return;
  }
  if (ev.type === 'changed') {
    // schedule create/update/delete/pause/resume 等任何变化都广播 'changed',
    // 全量重拉(数据量小,几十条 KB 级,无压力)。
    void forceRefresh().catch(() => {
      /* 同上 */
    });
    return;
  }
  // fired/completed/failed/session-bound/read/all-read 等事件不影响 schedules
  // 列表本身的数据 — 留给 useSchedules / useRuns / badge hook 各自处理。
}

interface MinimalAuthState {
  isAuthenticated: boolean;
}

/** AuthStateChange handler — 登出时清 cache + 标 wasReset 让后续 'ready' 触发预热。 */
export function handleAuthStateChange(authState: MinimalAuthState): void {
  if (!authState.isAuthenticated) {
    // epoch 自增**必须在最前**:让登出前已发起、登出后才返回的 in-flight 请求
    // 在回写时校验失败 → 丢弃,杜绝跨账号 cache 串库。
    epoch += 1;
    cache = null;
    inflight = null;
    lastError = null;
    wasReset = true;
    notify();
  }
}

// 模块加载时一次性 wire(SSR / 测试环境 window undefined 时跳过)。
// `if (typeof window !== 'undefined')` 守卫照 sessionsStore.ts:214 范式。
if (typeof window !== 'undefined' && window.electronAPI?.maker?.schedule?.onEvent) {
  window.electronAPI.maker.schedule.onEvent(handleSchedulerEvent);
}
if (typeof window !== 'undefined' && window.electronAPI?.onAuthStateChange) {
  window.electronAPI.onAuthStateChange(handleAuthStateChange);
}

/**
 * Testing 入口:把 store 完全清零。仅 vitest 用,不要在 production 代码里调。
 */
export function __resetStoreForTest(): void {
  cache = null;
  inflight = null;
  lastError = null;
  wasReset = false;
  epoch = 0;
  subs.clear();
}

export const schedulesStore = {
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },

  /** 当前快照;null 表示尚未加载过(hook 据此判定 loading 初值)。 */
  getSnapshot(): Schedule[] | null {
    return cache;
  },

  /** 最近一次 ensure/forceRefresh 失败的 message;成功后清回 null。 */
  getError(): string | null {
    return lastError;
  },

  ensure,
  forceRefresh,
};

// ── React hook 助手:让 hook 端代码更短 ──────────────────────────────────
// 把 useSyncExternalStore 包一层,statically 暴露给 useSchedules 用。
// 不强制 hook 端用 — useSchedules 也可以直接 import schedulesStore 自己调
// useSyncExternalStore。
export function useSchedulesSnapshot(): Schedule[] | null {
  return useSyncExternalStore(
    schedulesStore.subscribe,
    schedulesStore.getSnapshot,
    () => null, // SSR getSnapshot;Electron 无 SSR,静默 warn
  );
}

export function useSchedulesError(): string | null {
  return useSyncExternalStore(
    schedulesStore.subscribe,
    schedulesStore.getError,
    () => null,
  );
}
