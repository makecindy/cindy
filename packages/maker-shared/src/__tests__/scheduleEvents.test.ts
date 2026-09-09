import { describe, expect, it } from 'vitest';
import {
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
      sessionIndex: false,
      unreadSummary: false,
    });
    expect(projectScheduleEvent({ type: 'changed', scheduleId: 'sched-1' })).toMatchObject({
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
        sessionIndex: false,
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
    expect(projectScheduleEvent({ type: 'skipped', scheduleId: 'sched-1', runId: 'run-1', sessionId: '' }).runPatch.sessionId).toBeNull();
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

  it('decides whether a selected schedule should refresh its run list', () => {
    expect(shouldRefreshRunsForSchedule({ mode: 'none' }, 'sched-1')).toBe(false);
    expect(shouldRefreshRunsForSchedule({ mode: 'all' }, 'sched-1')).toBe(true);
    expect(shouldRefreshRunsForSchedule({ mode: 'schedule', scheduleId: 'sched-1' }, 'sched-1')).toBe(true);
    expect(shouldRefreshRunsForSchedule({ mode: 'schedule', scheduleId: 'sched-2' }, 'sched-1')).toBe(false);
  });
});
