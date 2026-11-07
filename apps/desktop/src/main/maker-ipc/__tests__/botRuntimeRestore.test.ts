import { describe, expect, it, vi } from 'vitest';

import { createBotRuntimeRestoreCoordinator } from '../botRuntimeRestore';

function harness() {
  let identity: { userId: string; clientEpoch: number } | null = null;
  const calls: string[] = [];
  const services = {
    delegation: { restore: vi.fn(async () => { calls.push('delegation'); }) },
  };
  const log = { warn: vi.fn() };
  const coordinator = createBotRuntimeRestoreCoordinator({
    readDbIdentity: () => identity,
    readServices: () => services,
    log,
  });
  return {
    coordinator,
    services,
    calls,
    log,
    setIdentity(next: typeof identity) { identity = next; },
  };
}

describe('botRuntimeRestore', () => {
  it('waits for DbClient readiness and restores all durable queues in order', async () => {
    const h = harness();

    await expect(h.coordinator.restoreCurrentOwner()).resolves.toBe(false);
    expect(h.calls).toEqual([]);

    h.setIdentity({ userId: 'owner-a', clientEpoch: 1 });
    await expect(h.coordinator.restoreCurrentOwner()).resolves.toBe(true);
    expect(h.calls).toEqual(['delegation']);
  });

  it('runs once per DbClient generation and restores again after an owner switch', async () => {
    const h = harness();
    h.setIdentity({ userId: 'owner-a', clientEpoch: 1 });

    await Promise.all([
      h.coordinator.restoreCurrentOwner(),
      h.coordinator.restoreCurrentOwner(),
    ]);
    expect(h.calls).toEqual(['delegation']);

    h.setIdentity({ userId: 'owner-b', clientEpoch: 3 });
    await h.coordinator.restoreCurrentOwner();
    expect(h.calls).toEqual(['delegation', 'delegation']);
  });

  it('does not mark a failed pass complete, so the same owner can retry', async () => {
    const h = harness();
    h.setIdentity({ userId: 'owner-a', clientEpoch: 1 });
    h.services.delegation.restore.mockRejectedValueOnce(new Error('temporary failure'));

    await expect(h.coordinator.restoreCurrentOwner()).resolves.toBe(false);
    await expect(h.coordinator.restoreCurrentOwner()).resolves.toBe(true);

    expect(h.services.delegation.restore).toHaveBeenCalledTimes(2);
    expect(h.log.warn).toHaveBeenCalledWith(
      'Bot delegation restore failed',
      expect.objectContaining({ userId: 'owner-a', clientEpoch: 1, error: 'temporary failure' }),
    );
  });

  it('stops the pass when the DbClient generation changes mid-restore', async () => {
    const h = harness();
    h.setIdentity({ userId: 'owner-a', clientEpoch: 1 });
    h.services.delegation.restore.mockImplementationOnce(async () => {
      h.calls.push('delegation');
      h.setIdentity({ userId: 'owner-b', clientEpoch: 3 });
    });

    await expect(h.coordinator.restoreCurrentOwner()).resolves.toBe(false);

    await expect(h.coordinator.restoreCurrentOwner()).resolves.toBe(true);
    expect(h.calls.slice(-1)).toEqual(['delegation']);
  });
});
