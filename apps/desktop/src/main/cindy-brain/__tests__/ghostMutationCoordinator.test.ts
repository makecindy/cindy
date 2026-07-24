import { describe, expect, it } from 'vitest';

import { GhostMutationCoordinator } from '../ghostMutationCoordinator';

describe('GhostMutationCoordinator', () => {
  it('waits for every active mutation before becoming idle', async () => {
    const coordinator = new GhostMutationCoordinator();
    const releaseA = coordinator.acquire();
    const releaseB = coordinator.acquire();
    let drained = false;
    const waiting = coordinator.waitForIdle().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    releaseA();
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseB();
    await waiting;
    expect(drained).toBe(true);
  });

  it('makes release idempotent and allows a later mutation', async () => {
    const coordinator = new GhostMutationCoordinator();
    const release = coordinator.acquire();
    release();
    release();
    await coordinator.waitForIdle();

    const releaseLater = coordinator.acquire();
    const waiting = coordinator.waitForIdle();
    releaseLater();
    await waiting;
  });
});
