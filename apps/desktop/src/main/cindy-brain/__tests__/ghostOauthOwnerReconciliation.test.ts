import { describe, expect, it, vi } from 'vitest';

import { createGhostOauthOwnerReconciliationGate } from '../ghostOauthOwnerReconciliation';

describe('Ghost OAuth owner reconciliation gate', () => {
  it('does not let an old-owner failure suppress the new owner reconciliation', async () => {
    const gate = createGhostOauthOwnerReconciliationGate();
    let releaseOwnerA!: () => void;
    const ownerABlocked = new Promise<void>((resolve) => {
      releaseOwnerA = resolve;
    });
    const ownerA = vi.fn(async () => {
      await ownerABlocked;
      throw new Error('old owner database closed');
    });
    const ownerB = vi.fn(async () => true);

    const ownerATask = gate.run('cloud:owner-a:1', ownerA);
    const ownerBTask = gate.run('cloud:owner-b:2', ownerB);
    await ownerBTask;
    releaseOwnerA();

    await expect(ownerATask).rejects.toThrow('old owner database closed');
    expect(ownerB).toHaveBeenCalledOnce();
    await gate.run('cloud:owner-b:2', ownerB);
    expect(ownerB).toHaveBeenCalledOnce();
  });

  it('reruns when returning to a previously reconciled owner scope', async () => {
    const gate = createGhostOauthOwnerReconciliationGate();
    const ownerA = vi.fn(async () => true);
    const ownerB = vi.fn(async () => true);

    await gate.run('cloud:owner-a:1', ownerA);
    await gate.run('cloud:owner-b:2', ownerB);
    await gate.run('cloud:owner-a:1', ownerA);

    expect(ownerA).toHaveBeenCalledTimes(2);
    expect(ownerB).toHaveBeenCalledOnce();
  });
});
