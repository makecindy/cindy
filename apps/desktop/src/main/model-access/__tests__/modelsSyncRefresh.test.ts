import { describe, expect, it, vi } from 'vitest';

import {
  waitForModelsSyncRefresh,
  type ModelsSyncFlightSnapshot,
} from '../modelsSyncRefresh.js';

describe('waitForModelsSyncRefresh', () => {
  it('waits through an old-account flight and accepts the current successful attempt', async () => {
    const oldFlight = Promise.resolve();
    const currentFlight = Promise.resolve();
    const snapshots: ModelsSyncFlightSnapshot[] = [
      { flight: oldFlight, generation: 1, attempt: 4 },
      { flight: currentFlight, generation: 2, attempt: 5 },
    ];
    let index = 0;
    let scheduleCalls = 0;

    await expect(
      waitForModelsSyncRefresh({
        expectedGeneration: 2,
        schedule: () => {
          if (scheduleCalls > 0) index = 1;
          scheduleCalls += 1;
        },
        snapshot: () => snapshots[index],
        currentGeneration: () => 2,
        lastSuccessfulAttempt: () => 5,
      }),
    ).resolves.toBe('succeeded');
  });

  it('stops instead of following a new account when auth changes in flight', async () => {
    let resolveFlight!: () => void;
    const flight = new Promise<void>((resolve) => { resolveFlight = resolve; });
    let generation = 7;
    const outcome = waitForModelsSyncRefresh({
      expectedGeneration: 7,
      schedule: vi.fn(),
      snapshot: () => ({ flight, generation: 7, attempt: 3 }),
      currentGeneration: () => generation,
      lastSuccessfulAttempt: () => 3,
    });

    generation = 8;
    resolveFlight();
    await expect(outcome).resolves.toBe('account-changed');
  });

  it('does not mistake an older successful attempt for the current failed request', async () => {
    await expect(
      waitForModelsSyncRefresh({
        expectedGeneration: 3,
        schedule: vi.fn(),
        snapshot: () => ({ flight: Promise.resolve(), generation: 3, attempt: 9 }),
        currentGeneration: () => 3,
        lastSuccessfulAttempt: () => 8,
      }),
    ).resolves.toBe('failed');
  });
});
