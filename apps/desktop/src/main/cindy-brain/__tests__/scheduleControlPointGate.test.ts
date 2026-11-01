// Review of #8235: a plugin stop threw before reaching either runner, so the failure notification
// the user configured was never sent, unlike a blocking pre-run script. Unit tier, no timers.
import { describe, expect, it, vi } from 'vitest';
import type { FireContext, Schedule } from '@cindy/maker-scheduler';
import { screenScheduleRun } from '../scheduleControlPointGate';

const schedule = { id: 's1', name: 'Daily', prompt: 'go', preRunPlugin: { pluginId: 'p', onFailure: 'block' } } as unknown as Schedule;
const ctx = { runId: 'r1', firedAt: 1, signal: new AbortController().signal } as unknown as FireContext;
const stop = (action: 'skip' | 'block') => async () =>
  ({ action, ghostId: 'p', ghostName: 'Gate', reason: 'off hours', failure: false }) as const;

describe('screenScheduleRun', () => {
  it('sends the failure notification once before stopping the run', async () => {
    const notify = vi.fn(async () => {});
    await expect(screenScheduleRun(stop('block'), schedule, ctx, notify)).rejects.toThrow('off hours');
    expect(notify).toHaveBeenCalledExactlyOnceWith('Stopped by plugin "Gate": off hours');
  });

  it('does not notify a skip, which keeps its reason in the run record', async () => {
    const notify = vi.fn(async () => {});
    await expect(screenScheduleRun(stop('skip'), schedule, ctx, notify)).resolves
      .toMatchObject({ skipped: true, resultText: 'Stopped by plugin "Gate": off hours' });
    expect(notify).not.toHaveBeenCalled();
  });
});
