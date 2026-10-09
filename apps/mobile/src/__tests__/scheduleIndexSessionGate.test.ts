import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { remoteScheduleEventStore } from '@/scheduler/remoteScheduleEvents';
import {
  clearSessionScheduleIndexCache,
  invalidateScheduleIndexForDevice,
  loadSharedSessionScheduleIndex,
  sessionMayHaveScheduleRuns,
} from '@/session/scheduleIndex';

afterEach(() => clearSessionScheduleIndexCache());

function maker() {
  const list = vi.fn(async () => [
    { id: 'heartbeat', name: 'PR heartbeat', status: 'active', targetSessionId: 'pr-task' },
    { id: 'nightly', name: 'Nightly', status: 'active' },
  ]);
  const listSidebarIndexRuns = vi.fn(async () => ({
    runs: [{ runId: 'r1', scheduleId: 'nightly', scheduleName: 'Nightly', scheduleStatus: 'active', sessionId: 'nightly-run', status: 'success', firedAt: 1 }],
  }));
  return { list, listSidebarIndexRuns, maker: { schedule: { list, listSidebarIndexRuns, listRuns: vi.fn() } } as unknown as Pick<MobileMakerTransport, 'schedule'> };
}

describe('task page schedule index gate', () => {
  it('loads for any task until the device index is known', () => {
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', undefined)).toBe(true);
  });

  it('skips ordinary tasks once the current index shows they have no automation binding', async () => {
    const remote = maker();
    await loadSharedSessionScheduleIndex('mac', remote.maker);
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', 'desktop')).toBe(false);
    // Tasks an automation reuses (targetSessionId) and tasks with runs still load.
    expect(sessionMayHaveScheduleRuns('mac', 'pr-task', 'desktop')).toBe(true);
    expect(sessionMayHaveScheduleRuns('mac', 'nightly-run', 'desktop')).toBe(true);
    // Automation-created tasks always load, even before they appear in an index.
    expect(sessionMayHaveScheduleRuns('mac', 'brand-new-run', 'scheduler')).toBe(true);
    // Knowledge is per device.
    expect(sessionMayHaveScheduleRuns('pc', 'ordinary', 'desktop')).toBe(true);
  });

  it('stays usable across run events and learns the tasks they bind', async () => {
    const remote = maker();
    await loadSharedSessionScheduleIndex('mac', remote.maker);
    remoteScheduleEventStore.apply('mac', { type: 'completed', scheduleId: 'nightly', runId: 'r2', sessionId: 'nightly-run' });
    remoteScheduleEventStore.apply('mac', { type: 'read', scheduleId: 'nightly', runId: 'r2' });
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', 'desktop')).toBe(false);
    // A run that lands in a task the index did not know about makes that task load.
    remoteScheduleEventStore.apply('mac', { type: 'session-bound', scheduleId: 'nightly', runId: 'r3', sessionId: 'ordinary' });
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', 'desktop')).toBe(true);
    expect(sessionMayHaveScheduleRuns('mac', 'other', 'desktop')).toBe(false);
    // Automation definitions changed (could rebind a task): unknown until the next index.
    remoteScheduleEventStore.apply('mac', { type: 'changed', scheduleId: 'heartbeat' });
    expect(sessionMayHaveScheduleRuns('mac', 'other', 'desktop')).toBe(true);
    remoteScheduleEventStore.clearDevice('mac');
  });

  it('treats a non-event reset after the index as unknown again', async () => {
    const remote = maker();
    await loadSharedSessionScheduleIndex('mac', remote.maker);
    invalidateScheduleIndexForDevice('mac'); // link recovery / offline
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', 'desktop')).toBe(true);

    await loadSharedSessionScheduleIndex('mac', remote.maker);
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', 'desktop')).toBe(false);
    clearSessionScheduleIndexCache(); // account switch
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', 'desktop')).toBe(true);
  });

  it('does not trust an index whose load overlapped a schedule event', async () => {
    const remote = maker();
    let release!: () => void;
    remote.listSidebarIndexRuns.mockImplementationOnce(async () => {
      await new Promise<void>((resolveRelease) => { release = resolveRelease; });
      return { runs: [] };
    });
    const pending = loadSharedSessionScheduleIndex('mac', remote.maker);
    await vi.waitFor(() => expect(remote.listSidebarIndexRuns).toHaveBeenCalled());
    invalidateScheduleIndexForDevice('mac');
    release();
    await pending;
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', 'desktop')).toBe(true);
  });

  it('does not let a scan from before an account switch record bindings afterwards', async () => {
    const remote = maker();
    let release!: () => void;
    remote.listSidebarIndexRuns.mockImplementationOnce(async () => {
      await new Promise<void>((resolveRelease) => { release = resolveRelease; });
      return { runs: [] };
    });
    const oldAccountScan = loadSharedSessionScheduleIndex('mac', remote.maker);
    await vi.waitFor(() => expect(remote.listSidebarIndexRuns).toHaveBeenCalled());
    clearSessionScheduleIndexCache(); // account switch: versions restart at 0
    release();
    await oldAccountScan;
    expect(sessionMayHaveScheduleRuns('mac', 'pr-task', 'desktop')).toBe(true);
    expect(sessionMayHaveScheduleRuns('mac', 'ordinary', 'desktop')).toBe(true);
  });

  it('gates the task page read-marking scan before it starts', () => {
    const page = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8').replace(/\r\n/g, '\n');
    const effect = page.slice(page.indexOf('const cancel = deferScheduleIndexHydration(() => {'));
    expect(effect.indexOf('if (!sessionMayHaveScheduleRuns(deviceId, sessionId, sessionSourceForSchedule)) return;'))
      .toBeLessThan(effect.indexOf('markSessionScheduleRunsRead(maker, sessionId, deviceId, isActive'));
    expect(page).toContain('scheduleNoticeSource, sessionId, sessionSourceForSchedule]));');
  });
});
