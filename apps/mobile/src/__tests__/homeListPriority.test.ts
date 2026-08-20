import { describe, expect, it } from 'vitest';
import { LIVE_TASK_PRIORITY } from '@cindy/maker-shared/live-task-priority';
import {
  advanceViewedPriorityHold,
  collectHomePriorityContext,
  createViewedPriorityHoldState,
  holdViewedPriorityRank,
  naturalPriorityRankForId,
  sessionPriorityRank,
  sessionPriorityRecencyMs,
} from '@/session/homeListPriority';
import type { RemoteSessionListItem } from '@/session/sessionList';

function item(
  id: string,
  over: {
    livePhase?: 'running' | 'needs-interaction' | 'completed' | 'error';
    liveAttention?: boolean;
    pending?: number;
    unread?: number;
    running?: boolean;
  } = {},
): RemoteSessionListItem {
  return {
    lastActivityAt: '2026-06-01T00:00:00Z',
    liveActivity: over.livePhase
      ? { attention: over.liveAttention === true, compactDetail: '', phase: over.livePhase, sessionId: id }
      : null,
    pendingInteractionCount: over.pending ?? 0,
    scheduleInfo: over.unread || over.running
      ? { unreadCount: over.unread ?? 0, running: over.running === true }
      : null,
    session: { id },
    title: id,
  } as unknown as RemoteSessionListItem;
}

describe('homeListPriority hold', () => {
  it('pins the rank at open time and only writes recently-viewed when leaving unread', () => {
    const state = createViewedPriorityHoldState();
    const ctx = {
      runningSessionIds: new Set<string>(),
      unreadSessionIds: new Set(['done-1']),
      waitingSessionIds: new Set<string>(),
    };

    holdViewedPriorityRank(state, 'done-1', ctx);
    advanceViewedPriorityHold(state, 'done-1', ctx, 0);
    expect(state.heldPriorityRanks.get('done-1')).toBe(LIVE_TASK_PRIORITY.unread);

    advanceViewedPriorityHold(state, undefined, ctx, 1_700_000_000_000);
    expect(state.heldPriorityRanks.has('done-1')).toBe(false);
    expect(state.recentlyViewedAtMs.get('done-1')).toBe(1_700_000_000_000);
    // 离开后 attention 已清,自然档掉到 rest;离开时刻把它顶到其余档最前。
    const afterRead = {
      ...ctx,
      recentlyViewedAtMs: state.recentlyViewedAtMs,
      unreadSessionIds: new Set<string>(),
    };
    expect(sessionPriorityRecencyMs('done-1', 10, afterRead)).toBe(1_700_000_000_000);
  });

  it('does not rewrite recency when leaving a rest-tier task', () => {
    const state = createViewedPriorityHoldState();
    const ctx = {
      runningSessionIds: new Set<string>(),
      unreadSessionIds: new Set<string>(),
      waitingSessionIds: new Set<string>(),
    };
    holdViewedPriorityRank(state, 'idle-1', ctx);
    advanceViewedPriorityHold(state, undefined, ctx, 99);
    expect(state.recentlyViewedAtMs.has('idle-1')).toBe(false);
  });

  it('keeps the more urgent held rank if attention clears while viewing', () => {
    const state = createViewedPriorityHoldState();
    const waiting = {
      runningSessionIds: new Set<string>(),
      unreadSessionIds: new Set<string>(),
      waitingSessionIds: new Set(['ask-1']),
    };
    holdViewedPriorityRank(state, 'ask-1', waiting);
    const cleared = {
      runningSessionIds: new Set<string>(),
      unreadSessionIds: new Set<string>(),
      waitingSessionIds: new Set<string>(),
    };
    expect(sessionPriorityRank('ask-1', { ...cleared, heldPriorityRanks: state.heldPriorityRanks }))
      .toBe(LIVE_TASK_PRIORITY.waiting);
    expect(naturalPriorityRankForId('ask-1', cleared)).toBe(LIVE_TASK_PRIORITY.rest);
  });
});

describe('collectHomePriorityContext', () => {
  it('maps right-status signals onto shared waiting / unread ranks', () => {
    const hold = createViewedPriorityHoldState();
    const ctx = collectHomePriorityContext([
      item('wait', { pending: 1 }),
      item('err', { liveAttention: true, livePhase: 'error' }),
      item('done', { liveAttention: true, livePhase: 'completed' }),
      item('run', { running: true }),
      item('idle'),
    ], new Set(['run']), hold);

    expect([...ctx.waitingSessionIds].sort()).toEqual(['err', 'wait']);
    expect([...ctx.unreadSessionIds]).toEqual(['done']);
    expect(naturalPriorityRankForId('wait', ctx)).toBe(LIVE_TASK_PRIORITY.waiting);
    expect(naturalPriorityRankForId('done', ctx)).toBe(LIVE_TASK_PRIORITY.unread);
    expect(naturalPriorityRankForId('run', ctx)).toBe(LIVE_TASK_PRIORITY.running);
    expect(naturalPriorityRankForId('idle', ctx)).toBe(LIVE_TASK_PRIORITY.rest);
  });
});
