import { describe, expect, it } from 'vitest';
import {
  isPatchableSkippedScheduleEvent,
  normalizeSchedulerEvent,
  projectScheduleEvent,
  shouldRefreshRunsForSchedule,
} from '../scheduleEvents.js';

describe('shared scheduler event projection', () => {
  it('normalizes desktop scheduler events and rejects malformed payloads', () => {
    expect(normalizeSchedulerEvent({ type: 'completed', scheduleId: 's1', runId: 'r1', sessionId: 'chat-1' })).toEqual({
      type: 'completed',
      scheduleId: 's1',
      runId: 'r1',
      sessionId: 'chat-1',
    });
    expect(normalizeSchedulerEvent({ type: 'completed', scheduleId: 's1', runId: 'r1' })).toEqual({
      type: 'unknown',
      rawType: 'completed',
    });
    expect(normalizeSchedulerEvent({ type: 'future-event', scheduleId: 's1' })).toEqual({
      type: 'unknown',
      rawType: 'future-event',
    });
  });

  it('routes changed and ready events to schedule-list refreshes', () => {
    expect(projectScheduleEvent({ type: 'ready' }).refresh).toEqual({
      runRefresh: { mode: 'none' },
      scheduleList: true,
      sessionIndex: true,
      unreadSummary: false,
    });
    expect(projectScheduleEvent({ type: 'changed', scheduleId: 'sched-1' })).toMatchObject({
      event: { type: 'changed', scheduleId: 'sched-1' },
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: true,
        sessionIndex: true,
        unreadSummary: true,
      },
      unreadImpact: 'none',
    });
    expect(projectScheduleEvent({
      type: 'changed',
      scheduleId: 'sched-1',
      skippedRunId: 'run-compat-1',
    })).toMatchObject({
      event: { type: 'changed', scheduleId: 'sched-1', skippedRunId: 'run-compat-1' },
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: true,
        sessionIndex: true,
        unreadSummary: true,
      },
      unreadImpact: 'none',
    });
  });

  it('routes run lifecycle events to selected runs and session badges like desktop hooks', () => {
    expect(projectScheduleEvent({ type: 'fired', scheduleId: 'sched-1', runId: 'run-1' })).toMatchObject({
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: false,
        // 认领清空了 nextFireAt 并插入 running run,远端侧栏索引要立刻重拉。
        sessionIndex: true,
        unreadSummary: false,
      },
      runPatch: { scheduleId: 'sched-1', runId: 'run-1', sessionId: null, status: 'running' },
    });
    expect(projectScheduleEvent({
      type: 'completed',
      scheduleId: 'sched-1',
      runId: 'run-1',
      sessionId: 'chat-1',
    })).toMatchObject({
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: true,
      },
      runPatch: { sessionId: 'chat-1', status: 'terminal' },
      unreadImpact: 'may-increase',
    });
    expect(projectScheduleEvent({ type: 'deferred', scheduleId: 'sched-1', runId: 'run-1' }).runPatch.status).toBe('deferred');
  });

  it('projects optional failed sessionId without requiring it', () => {
    expect(normalizeSchedulerEvent({
      type: 'failed',
      scheduleId: 's1',
      runId: 'r1',
      error: 'boom',
    })).toEqual({
      type: 'failed',
      scheduleId: 's1',
      runId: 'r1',
      error: 'boom',
    });
    expect(normalizeSchedulerEvent({
      type: 'failed',
      scheduleId: 's1',
      runId: 'r1',
      error: 'boom',
      sessionId: 'chat-1',
    })).toEqual({
      type: 'failed',
      scheduleId: 's1',
      runId: 'r1',
      error: 'boom',
      sessionId: 'chat-1',
    });
    expect(projectScheduleEvent({
      type: 'failed',
      scheduleId: 'sched-1',
      runId: 'run-1',
      error: 'boom',
      sessionId: 'chat-1',
    }).runPatch.sessionId).toBe('chat-1');
    expect(projectScheduleEvent({
      type: 'failed',
      scheduleId: 'sched-1',
      runId: 'run-1',
      error: 'boom',
    }).runPatch.sessionId).toBeNull();
    expect(projectScheduleEvent({
      type: 'failed',
      scheduleId: 'sched-1',
      runId: 'run-quiet',
      error: 'pre-run hook failed: rate limit',
      sessionId: 'chat-1',
      silenced: true,
    })).toMatchObject({
      event: {
        type: 'failed',
        scheduleId: 'sched-1',
        runId: 'run-quiet',
        sessionId: 'chat-1',
        silenced: true,
      },
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: false,
      },
      unreadImpact: 'none',
    });
  });

  it('routes skipped (pre-run hook) events without touching unread badges', () => {
    expect(normalizeSchedulerEvent({ type: 'skipped', scheduleId: 's1', runId: 'r1', sessionId: 'trace-1' })).toEqual({
      type: 'skipped',
      scheduleId: 's1',
      runId: 'r1',
      sessionId: 'trace-1',
    });
    // 留痕失败时 desktop emit sessionId='':仍是合法 skipped 事件,不得降级 unknown 全量刷新
    expect(normalizeSchedulerEvent({ type: 'skipped', scheduleId: 's1', runId: 'r1', sessionId: '' })).toEqual({
      type: 'skipped',
      scheduleId: 's1',
      runId: 'r1',
      sessionId: '',
    });
    expect(projectScheduleEvent({
      type: 'skipped',
      scheduleId: 'sched-1',
      runId: 'run-1',
      sessionId: 'trace-1',
    })).toMatchObject({
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: false,
      },
      runPatch: { scheduleId: 'sched-1', runId: 'run-1', sessionId: 'trace-1', status: 'terminal' },
      unreadImpact: 'none',
    });
    // 测试价值
    // - 生产入口与可观察结果：normalizeSchedulerEvent / projectScheduleEvent 对新旧主机 skipped 事件的兼容投影。
    // - 规则依据：docs/dev-rules/protocol-compatibility.md 与 docs/dev-rules/remote-and-mobile-adaptation.md —— 新主机携带排期时间戳与 preRunCheckSucceeded，旧主机缺省仍合法；fired 置 running 后 skipped 必须保持 sessionIndex=true 收口运行态与下次时间。
    // - 现有覆盖缺口：既有测试未校验 skipped 的时间戳字段保留、preRunCheckSucceeded 对 unreadSummary 的驱动及旧主机缺省兼容。
    // - 最小失败输入：新主机带时间戳 + preRunCheckSucceeded 的 skipped 与旧主机仅含 sessionId='' 的 skipped。
    // - tier：unit。
    expect(projectScheduleEvent({
      type: 'skipped',
      scheduleId: 'sched-1',
      runId: 'run-1',
      sessionId: '',
    })).toMatchObject({
      event: {
        type: 'skipped',
        scheduleId: 'sched-1',
        runId: 'run-1',
        sessionId: '',
      },
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: false,
      },
      runPatch: { scheduleId: 'sched-1', runId: 'run-1', sessionId: null, status: 'terminal' },
      unreadImpact: 'none',
    });
    const newHostSkipped = projectScheduleEvent({
      type: 'skipped',
      scheduleId: 'sched-1',
      runId: 'run-2',
      sessionId: '',
      lastFiredAt: 1000,
      lastFinishedAt: 1050,
      nextFireAt: 301050,
      preRunCheckSucceeded: true,
    });
    expect(isPatchableSkippedScheduleEvent(newHostSkipped.event)).toBe(true);
    expect(newHostSkipped).toMatchObject({
      event: {
        type: 'skipped',
        scheduleId: 'sched-1',
        runId: 'run-2',
        sessionId: '',
        lastFiredAt: 1000,
        lastFinishedAt: 1050,
        nextFireAt: 301050,
        preRunCheckSucceeded: true,
      },
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: false,
        sessionIndex: false,
        unreadSummary: false,
      },
      runPatch: { scheduleId: 'sched-1', runId: 'run-2', sessionId: null, status: 'terminal' },
      unreadImpact: 'none',
    });
  });

  it('routes read events and unknown future events conservatively', () => {
    expect(projectScheduleEvent({ type: 'read', scheduleId: 'sched-1' })).toMatchObject({
      refresh: {
        runRefresh: { mode: 'schedule', scheduleId: 'sched-1' },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: true,
      },
      unreadImpact: 'may-clear-schedule',
    });
    expect(projectScheduleEvent({ type: 'all-read' })).toMatchObject({
      refresh: {
        runRefresh: { mode: 'all' },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: true,
      },
      unreadImpact: 'clear-all',
    });
    expect(projectScheduleEvent({ type: 'future-event' }).refresh).toEqual({
      runRefresh: { mode: 'all' },
      scheduleList: true,
      sessionIndex: true,
      unreadSummary: true,
    });
  });

  it('treats desktop runtime-state diagnostics as a no-refresh event instead of unknown', () => {
    const payload = {
      type: 'runtime-state',
      snapshot: {
        schedulerInstanceId: 'sched-instance',
        inFlight: 1,
        slotsInUse: 1,
        maxConcurrentRuns: 8,
        inFlightRuns: [],
        waitingSchedules: [],
      },
    };
    expect(normalizeSchedulerEvent(payload)).toEqual({ type: 'runtime-state' });
    // snapshot 形状不参与投影:缺失或畸形都不能退回 unknown 的全量刷新。
    expect(normalizeSchedulerEvent({ type: 'runtime-state' })).toEqual({ type: 'runtime-state' });
    expect(projectScheduleEvent(payload)).toEqual({
      event: { type: 'runtime-state' },
      refresh: {
        runRefresh: { mode: 'none' },
        scheduleList: false,
        sessionIndex: false,
        unreadSummary: false,
      },
      runPatch: { scheduleId: null, runId: null, sessionId: null, status: 'unknown' },
      unreadImpact: 'none',
    });
  });

  it('treats silenced / notified reminder toggles as no-refresh events instead of unknown', () => {
    for (const type of ['silenced', 'notified'] as const) {
      const payload = { type, scheduleId: 'sched-1', runId: 'run-1', sessionId: 'chat-1' };
      expect(normalizeSchedulerEvent(payload)).toEqual({ type, scheduleId: 'sched-1', runId: 'run-1' });
      expect(projectScheduleEvent(payload).refresh).toEqual({
        runRefresh: { mode: 'none' },
        scheduleList: false,
        sessionIndex: false,
        unreadSummary: false,
      });
      expect(projectScheduleEvent(payload).unreadImpact).toBe('none');
    }
  });

  it('decides whether a selected schedule should refresh its run list', () => {
    expect(shouldRefreshRunsForSchedule({ mode: 'none' }, 'sched-1')).toBe(false);
    expect(shouldRefreshRunsForSchedule({ mode: 'all' }, 'sched-1')).toBe(true);
    expect(shouldRefreshRunsForSchedule({ mode: 'schedule', scheduleId: 'sched-1' }, 'sched-1')).toBe(true);
    expect(shouldRefreshRunsForSchedule({ mode: 'schedule', scheduleId: 'sched-2' }, 'sched-1')).toBe(false);
  });
});
