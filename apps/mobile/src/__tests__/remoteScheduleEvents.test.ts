import { beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteScheduleEventStore } from '@/scheduler/remoteScheduleEvents';

describe('remote schedule event store', () => {
  beforeEach(() => {
    remoteScheduleEventStore.clearAll();
  });

  it('increments per-device versions for pushed schedule events', () => {
    const sub = vi.fn();
    const off = remoteScheduleEventStore.subscribe(sub);

    remoteScheduleEventStore.apply('dev-1', { type: 'changed', scheduleId: 'sched-1' });
    remoteScheduleEventStore.apply('dev-1', { type: 'fired', scheduleId: 'sched-1', runId: 'run-1' });
    remoteScheduleEventStore.apply('dev-2', { type: 'ready' });

    expect(remoteScheduleEventStore.getVersion('dev-1')).toBe(2);
    expect(remoteScheduleEventStore.getVersion('dev-2')).toBe(1);
    expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
      runsVersion: 2,
      scheduleListVersion: 1,
      sessionIndexVersion: 1,
      unreadVersion: 1,
      version: 2,
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-2')).toMatchObject({
      runsVersion: 0,
      scheduleListVersion: 1,
      sessionIndexVersion: 0,
      unreadVersion: 0,
      version: 1,
    });
    expect(sub).toHaveBeenCalledTimes(3);

    off();
  });

  it('publishes mirror invalidation even without an existing schedule event snapshot', () => {
    const before = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
    const sub = vi.fn();
    const off = remoteScheduleEventStore.subscribe(sub);

    remoteScheduleEventStore.invalidateDeviceMirror('dev-1');

    const afterFirst = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
    expect(afterFirst).not.toBe(before);
    expect(afterFirst.get('dev-1')).toBe(1);
    expect(remoteScheduleEventStore.getVersion('dev-1')).toBe(0);
    expect(sub).toHaveBeenCalledTimes(1);

    remoteScheduleEventStore.invalidateDeviceMirror('dev-1');
    const afterSecond = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
    expect(afterSecond).not.toBe(afterFirst);
    expect(afterSecond.get('dev-1')).toBe(2);
    expect(sub).toHaveBeenCalledTimes(2);

    off();
  });

  it('projects run lifecycle and read events into targeted refresh versions', () => {
    remoteScheduleEventStore.apply('dev-1', { type: 'fired', scheduleId: 'sched-1', runId: 'run-1' });
    expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
      runsVersion: 1,
      scheduleListVersion: 0,
      sessionIndexVersion: 0,
      unreadVersion: 0,
    });

    remoteScheduleEventStore.apply('dev-1', {
      type: 'completed',
      scheduleId: 'sched-1',
      runId: 'run-1',
      sessionId: 'chat-1',
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
      runsVersion: 2,
      scheduleListVersion: 0,
      sessionIndexVersion: 1,
      unreadVersion: 1,
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').lastProjection).toMatchObject({
      runPatch: {
        scheduleId: 'sched-1',
        runId: 'run-1',
        sessionId: 'chat-1',
        status: 'terminal',
      },
      unreadImpact: 'may-increase',
    });

    remoteScheduleEventStore.apply('dev-1', { type: 'all-read' });
    expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
      runsVersion: 3,
      sessionIndexVersion: 2,
      unreadVersion: 2,
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').lastProjection?.refresh.runRefresh).toEqual({ mode: 'all' });
  });

  it('unreadClearVersion 只随未读清除类事件(read / all-read)递增', () => {
    // fired / completed 属非清除类(none / may-increase),不 bump。
    remoteScheduleEventStore.apply('dev-1', { type: 'fired', scheduleId: 'sched-1', runId: 'run-1' });
    remoteScheduleEventStore.apply('dev-1', {
      type: 'completed', scheduleId: 'sched-1', runId: 'run-1', sessionId: 'chat-1',
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').unreadClearVersion).toBe(0);

    remoteScheduleEventStore.apply('dev-1', { type: 'read', scheduleId: 'sched-1', runIds: ['run-1'] });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').unreadClearVersion).toBe(1);

    remoteScheduleEventStore.apply('dev-1', { type: 'all-read' });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').unreadClearVersion).toBe(2);
  });

  it('clears stale device versions when a host disappears', () => {
    remoteScheduleEventStore.apply('dev-1', { type: 'changed', scheduleId: 'sched-1' });
    remoteScheduleEventStore.apply('dev-2', { type: 'changed', scheduleId: 'sched-2' });

    remoteScheduleEventStore.clearDevice('dev-1');
    expect(remoteScheduleEventStore.getVersion('dev-1')).toBe(0);
    expect(remoteScheduleEventStore.getVersion('dev-2')).toBe(1);

    remoteScheduleEventStore.clearAll();
    expect(remoteScheduleEventStore.getVersion('dev-2')).toBe(0);
    expect(remoteScheduleEventStore.getMirrorInvalidationSnapshot().size).toBe(0);
  });
});
