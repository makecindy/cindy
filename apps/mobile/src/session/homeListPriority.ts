import {
  LIVE_TASK_PRIORITY,
  liveTaskPriorityRank,
} from '@cindy/maker-shared/live-task-priority';
import type { RemoteSessionListItem } from './sessionList';
import { resolveMobileSessionRightStatus } from './sessionRightStatus';

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

export function sessionPriorityRank(sessionId: string, ctx: HomeListPriorityContext): number {
  const natural = naturalPriorityRankForId(sessionId, ctx);
  const held = ctx.heldPriorityRanks?.get(sessionId);
  return held === undefined ? natural : Math.min(natural, held);
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
    state.heldPriorityRanks.set(
      viewedSessionId,
      held === undefined ? natural : Math.min(held, natural),
    );
  }
  state.prevViewedId = viewedSessionId;
  return state;
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
  state.heldPriorityRanks.set(sessionId, held === undefined ? natural : Math.min(held, natural));
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
    const status = resolveMobileSessionRightStatus({
      liveAttention: item.liveActivity?.attention === true,
      livePhase: item.liveActivity?.phase,
      pendingInteractionCount: item.pendingInteractionCount,
      running: runningSessionIds.has(item.session.id) || !!item.scheduleInfo?.running,
      scheduleUnreadCount: item.scheduleInfo?.unreadCount ?? 0,
    });
    if (status === 'error' || status === 'awaiting') waitingSessionIds.add(item.session.id);
    else if (status === 'done') unreadSessionIds.add(item.session.id);
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
