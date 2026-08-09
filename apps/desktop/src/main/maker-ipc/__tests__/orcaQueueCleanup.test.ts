import { describe, expect, it, vi } from 'vitest';

import {
  commitPendingOrcaWorkerInput,
  preparePendingOrcaWorkerInput,
} from '../orcaQueueCleanup.js';
import {
  isOrcaWorkerSessionDisableFenced,
  withOrcaWorkerDisableFence,
} from '../orcaDisableWorkerRuntime.js';

function createCoordinator(
  onDiscarded: (sessionId: string, item: { clientId: string }) => void = () => undefined,
) {
  const queues = new Map<string, Array<{ clientId: string }>>([
    ['worker-a', [{ clientId: 'orca-a' }, { clientId: 'scheduler-a' }]],
    ['worker-b', [{ clientId: 'orca-b' }]],
  ]);
  const discarded: Array<{ sessionId: string; clientId: string }> = [];
  const coordinator = {
    ensureQueueRestored: vi.fn(async () => undefined),
    getProjection: vi.fn((sessionId: string) => ({
      pendingQueue: queues.get(sessionId) ?? [],
    })),
    remove: vi.fn((sessionId: string, clientId: string) => {
      const queue = queues.get(sessionId) ?? [];
      const index = queue.findIndex((item) => item.clientId === clientId);
      if (index < 0) return;
      onDiscarded(sessionId, queue[index]!);
      queue.splice(index, 1);
      discarded.push({ sessionId, clientId });
    }),
  };
  return { coordinator, queues, discarded };
}

describe('Orca worker queue cleanup', () => {
  it('fails closed when durable queue restore rejects', async () => {
    const h = createCoordinator();
    const restoreError = new Error('queue snapshot unavailable');
    h.coordinator.ensureQueueRestored.mockRejectedValue(restoreError);

    await expect(
      preparePendingOrcaWorkerInput(h.coordinator, 'worker-a'),
    ).rejects.toBe(restoreError);
    expect(h.coordinator.getProjection).not.toHaveBeenCalled();
    expect(h.coordinator.remove).not.toHaveBeenCalled();
    expect(h.queues.get('worker-a')).toEqual([
      { clientId: 'orca-a' },
      { clientId: 'scheduler-a' },
    ]);
  });

  it('does not remove or discard when markTeamEnded rejects before durable commit', async () => {
    const discardAccepted = vi.fn();
    const schedulerWatcher = vi.fn();
    const h = createCoordinator((_sessionId, item) => {
      discardAccepted(item.clientId);
      if (item.clientId === 'scheduler-a') schedulerWatcher();
    });
    const markTeamEnded = vi.fn(async () => {
      throw new Error('team write failed');
    });

    await expect(
      withOrcaWorkerDisableFence(['worker-a'], async () => {
        expect(isOrcaWorkerSessionDisableFenced('worker-a')).toBe(true);
        const plan = await preparePendingOrcaWorkerInput(h.coordinator, 'worker-a');
        await markTeamEnded();
        commitPendingOrcaWorkerInput(h.coordinator, plan);
      }),
    ).rejects.toThrow('team write failed');
    expect(isOrcaWorkerSessionDisableFenced('worker-a')).toBe(false);
    expect(h.coordinator.remove).not.toHaveBeenCalled();
    expect(discardAccepted).not.toHaveBeenCalled();
    expect(schedulerWatcher).not.toHaveBeenCalled();
    expect(h.queues.get('worker-a')).toEqual([
      { clientId: 'orca-a' },
      { clientId: 'scheduler-a' },
    ]);
  });

  it('clears queued input through remove and fires each discard side effect once', async () => {
    const discardAccepted = vi.fn();
    const accepted = vi.fn();
    const rollback = vi.fn();
    const schedulerWatcher = vi.fn();
    const h = createCoordinator((_sessionId, item) => {
      // Mirrors register.ts onDiscardedQueuedMessage: discard, not accepted or rollback.
      discardAccepted(item.clientId);
      if (item.clientId === 'scheduler-a') schedulerWatcher();
    });

    const plan = await preparePendingOrcaWorkerInput(h.coordinator, 'worker-a');
    const removed = commitPendingOrcaWorkerInput(h.coordinator, plan);

    expect(removed).toBe(2);
    expect(h.queues.get('worker-a')).toEqual([]);
    expect(h.queues.get('worker-b')).toEqual([{ clientId: 'orca-b' }]);
    expect(h.coordinator.remove).toHaveBeenCalledTimes(2);
    expect(discardAccepted).toHaveBeenCalledTimes(2);
    expect(h.discarded).toEqual([
      { sessionId: 'worker-a', clientId: 'orca-a' },
      { sessionId: 'worker-a', clientId: 'scheduler-a' },
    ]);
    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(schedulerWatcher).toHaveBeenCalledTimes(1);
  });

  it('restores before snapshotting so persisted queued input is also removed', async () => {
    const h = createCoordinator();
    const order: string[] = [];
    h.coordinator.ensureQueueRestored.mockImplementation(async () => {
      order.push('restore');
    });
    h.coordinator.getProjection.mockImplementation((sessionId: string) => {
      order.push('snapshot');
      return { pendingQueue: h.queues.get(sessionId) ?? [] };
    });
    h.coordinator.remove.mockImplementation((sessionId: string, clientId: string) => {
      order.push(`remove:${clientId}`);
      const queue = h.queues.get(sessionId) ?? [];
      const index = queue.findIndex((item) => item.clientId === clientId);
      if (index >= 0) queue.splice(index, 1);
    });

    const plan = await preparePendingOrcaWorkerInput(h.coordinator, 'worker-b');
    commitPendingOrcaWorkerInput(h.coordinator, plan);

    expect(order).toEqual(['restore', 'snapshot', 'remove:orca-b']);
    expect(h.queues.get('worker-b')).toEqual([]);
  });
});
