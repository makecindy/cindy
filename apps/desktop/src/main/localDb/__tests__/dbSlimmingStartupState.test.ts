import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginDbSlimmingStartupProgress,
  cancelDbSlimmingStartupProgress,
  getDbSlimmingStartupProgress,
  subscribeDbSlimmingStartupProgress,
  type DbSlimmingStartupProgressJob,
} from '../dbSlimmingStartupState';
import type { DbSlimmingRequestRecord } from '../maintenanceStore';

let activeJob: DbSlimmingStartupProgressJob | null = null;

afterEach(() => {
  activeJob?.finish();
  activeJob = null;
});

function request(): DbSlimmingRequestRecord {
  return {
    version: 1,
    id: 'request-1',
    ownerId: 'owner-1',
    createdAt: 1,
    scannedAt: 2,
    archivedBeforeMs: 3,
    archiveAgeMonths: '7-days',
    deletedTaskCount: 4,
    archivedTaskCount: 5,
    messageCount: 6,
    estimatedMessageBytes: 100,
    beforeBytes: 96 * 1024 * 1024,
    backupEnabled: false,
    phase: 'scheduled',
  };
}

describe('database cleanup startup progress state', () => {
  it('publishes monotonic progress and turns cancellation into an abort signal', () => {
    let now = 1_000;
    const listener = vi.fn();
    const unsubscribe = subscribeDbSlimmingStartupProgress(listener);
    activeJob = beginDbSlimmingStartupProgress(request(), () => now);

    expect(getDbSlimmingStartupProgress()).toMatchObject({
      requestId: 'request-1',
      phase: 'preparing',
      progress: 1,
      cancellable: true,
      startedAt: 1_000,
    });

    now = 4_000;
    activeJob.update({ phase: 'compacting', progress: 60, cancellable: true });
    activeJob.update({ phase: 'compacting', progress: 55, cancellable: true });
    expect(getDbSlimmingStartupProgress()).toMatchObject({
      phase: 'compacting',
      progress: 60,
      cancellable: true,
    });

    expect(cancelDbSlimmingStartupProgress()).toBe(true);
    expect(activeJob.signal.aborted).toBe(true);
    expect(getDbSlimmingStartupProgress()).toMatchObject({
      phase: 'cancelling',
      cancellable: false,
    });
    expect(cancelDbSlimmingStartupProgress()).toBe(false);

    activeJob.finish();
    activeJob = null;
    expect(getDbSlimmingStartupProgress()).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
  });

  it('rejects cancellation once final replacement begins', () => {
    activeJob = beginDbSlimmingStartupProgress(request(), () => 1_000);
    activeJob.update({ phase: 'finalizing', progress: 96, cancellable: false });

    expect(cancelDbSlimmingStartupProgress()).toBe(false);
    expect(activeJob.signal.aborted).toBe(false);
  });
});
