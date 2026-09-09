import {
  LIVE_TASK_PRIORITY,
  liveTaskPriorityRank,
} from '@cindy/maker-shared/live-task-priority';
import type { RemoteSessionListItem } from './sessionList';

export type HomeListSortBy = 'recency' | 'priority';
export type HomeStatusFilter = 'active' | 'archived' | 'all';

export interface HomeListPriorityContext {
  runningSessionIds: ReadonlySet<string>;
  unreadSessionIds: ReadonlySet<string>;
  waitingSessionIds: ReadonlySet<string>;
  heldPriorityRanks?: ReadonlyMap<string, number>;
  recentlyViewedAtMs?: ReadonlyMap<string, number>;
}

export interface ViewedPriorityHoldState {
  prevViewedId?: string;
  heldPriorityRanks: Map<string, number>;
  recentlyViewedAtMs: Map<string, number>;
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

export const EMPTY_HOME_PRIORITY_CONTEXT: HomeListPriorityContext = {
  runningSessionIds: EMPTY_ID_SET,
  unreadSessionIds: EMPTY_ID_SET,
  waitingSessionIds: EMPTY_ID_SET,
};

export function createViewedPriorityHoldState(): ViewedPriorityHoldState {
  return {
    heldPriorityRanks: new Map(),
    recentlyViewedAtMs: new Map(),
  };
}

/** 首页打开任务时钉住档位;跨 Home 重挂载仍要记住刚看过的完成未读。 */
export const homeViewedPriorityHold = createViewedPriorityHoldState();

export function naturalPriorityRankForId(
  sessionId: string,
  ctx: Pick<HomeListPriorityContext, 'runningSessionIds' | 'unreadSessionIds' | 'waitingSessionIds'>,
): number {
  return liveTaskPriorityRank({
    running: ctx.runningSessionIds.has(sessionId),
    unread: ctx.unreadSessionIds.has(sessionId),
    waiting: ctx.waitingSessionIds.has(sessionId),
  });
}

function viewedPriorityRank(natural: number, held: number | undefined): number {
  // 当前轮已经运行时,释放上一轮 unread / waiting 的 hold。否则看的过程中跑完后,
  // 旧 hold 会再次把任务抬回高档位,直到点击离开才突然重排。
  if (natural === LIVE_TASK_PRIORITY.running) return natural;
  return held === undefined ? natural : Math.min(natural, held);
}

export function sessionPriorityRank(sessionId: string, ctx: HomeListPriorityContext): number {
  const natural = naturalPriorityRankForId(sessionId, ctx);
  const held = ctx.heldPriorityRanks?.get(sessionId);
  return viewedPriorityRank(natural, held);
}

/**
 * 看的时候钉住打开时的档位。只有离开时仍钉着完成未读档,才写离开时刻——
 * 已读已完成任务之间跟按时间排序一样,浏览不改序。
 */
export function advanceViewedPriorityHold(
  state: ViewedPriorityHoldState,
  viewedSessionId: string | undefined,
  ctx: Pick<HomeListPriorityContext, 'runningSessionIds' | 'unreadSessionIds' | 'waitingSessionIds'>,
  nowMs: number,
): ViewedPriorityHoldState {
  if (state.prevViewedId && state.prevViewedId !== viewedSessionId) {
    if (state.heldPriorityRanks.get(state.prevViewedId) === LIVE_TASK_PRIORITY.unread) {
      state.recentlyViewedAtMs.set(state.prevViewedId, nowMs);
    }
    state.heldPriorityRanks.delete(state.prevViewedId);
  }
  if (viewedSessionId) {
    const natural = naturalPriorityRankForId(viewedSessionId, ctx);
    const held = state.heldPriorityRanks.get(viewedSessionId);
    state.heldPriorityRanks.set(viewedSessionId, viewedPriorityRank(natural, held));
  }
  state.prevViewedId = viewedSessionId;
  return state;
}

/**
 * 详情页打开期间首页仍会收到任务状态更新。自然档变化时推进当前查看 hold,
 * 返回值只表示档位是否真的变化,供首页决定是否重算排序。
 */
export function advanceCurrentViewedPriorityHold(
  state: ViewedPriorityHoldState,
  ctx: Pick<HomeListPriorityContext, 'runningSessionIds' | 'unreadSessionIds' | 'waitingSessionIds'>,
  nowMs: number,
): boolean {
  const viewedSessionId = state.prevViewedId;
  if (!viewedSessionId) return false;
  const previousRank = state.heldPriorityRanks.get(viewedSessionId);
  advanceViewedPriorityHold(state, viewedSessionId, ctx, nowMs);
  return state.heldPriorityRanks.get(viewedSessionId) !== previousRank;
}

/**
 * 点击进任务会先于路由更新清掉 attention。必须在那之前按当前档位钉住,
 * 否则首次 hold 只能读到 rest,刚打开的完成未读仍会立刻沉底。
 */
export function holdViewedPriorityRank(
  state: ViewedPriorityHoldState,
  sessionId: string,
  ctx: Pick<HomeListPriorityContext, 'runningSessionIds' | 'unreadSessionIds' | 'waitingSessionIds'>,
): void {
  const natural = naturalPriorityRankForId(sessionId, ctx);
  const held = state.heldPriorityRanks.get(sessionId);
  state.heldPriorityRanks.set(sessionId, viewedPriorityRank(natural, held));
}

export function sessionPriorityRecencyMs(
  sessionId: string,
  activityMs: number,
  ctx: HomeListPriorityContext,
): number {
  if (naturalPriorityRankForId(sessionId, ctx) !== LIVE_TASK_PRIORITY.rest) return activityMs;
  const viewedAt = ctx.recentlyViewedAtMs?.get(sessionId) ?? 0;
  return Math.max(activityMs, viewedAt);
}

export function activityMsFromIso(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function collectHomePriorityContext(
  items: readonly RemoteSessionListItem[],
  runningSessionIds: ReadonlySet<string>,
  hold: ViewedPriorityHoldState,
): HomeListPriorityContext {
  const unreadSessionIds = new Set<string>();
  const waitingSessionIds = new Set<string>();
  for (const item of items) {
    // 各信号独立收集,不从互斥的 resolveMobileSessionRightStatus 反推:定时任务同时
    // 「完成未读」又「下一轮运行中」时,右侧展示状态会先返回 running 把 unread 吞掉,导致
    // 排序丢失上一轮完成未读。这里对齐桌面(attentionSessionIds / runningSessionIds
    // 各自独立集合),让同一会话可同时进 unread 与 running,由共享尺子裁决:
    // 当前轮 running 压过旧 done 未读,但纯完成未读仍排在纯 running 前面。
    const liveAttention = item.liveActivity?.attention === true;
    const livePhase = item.liveActivity?.phase;
    const isError = liveAttention && livePhase === 'error';
    const isAwaiting = item.pendingInteractionCount > 0
      || (liveAttention && livePhase === 'needs-interaction');
    const isUnread = (item.scheduleInfo?.unreadCount ?? 0) > 0
      || (liveAttention && livePhase === 'completed');
    if (isError || isAwaiting) waitingSessionIds.add(item.session.id);
    if (isUnread) unreadSessionIds.add(item.session.id);
  }
  return {
    heldPriorityRanks: hold.heldPriorityRanks,
    recentlyViewedAtMs: hold.recentlyViewedAtMs,
    runningSessionIds,
    unreadSessionIds,
    waitingSessionIds,
  };
}

export const __testing = {
  LIVE_TASK_PRIORITY,
  resetHomeViewedPriorityHold() {
    homeViewedPriorityHold.prevViewedId = undefined;
    homeViewedPriorityHold.heldPriorityRanks.clear();
    homeViewedPriorityHold.recentlyViewedAtMs.clear();
  },
};
