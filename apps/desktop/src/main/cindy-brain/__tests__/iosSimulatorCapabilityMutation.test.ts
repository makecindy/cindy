import { describe, expect, it, vi } from 'vitest';

import {
  acquireIOSSimulatorManifestMutation,
  runIOSSimulatorCapabilityMutation,
  runIOSSimulatorManifestMutation,
} from '../iosSimulatorCapabilityMutation.js';

describe('iOS Simulator capability mutation serialization', () => {
  it('does not let a later enable complete before an older teardown finishes', async () => {
    let finishTeardown!: () => void;
    const teardownFinished = new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
    const events: string[] = [];
    const disable = runIOSSimulatorCapabilityMutation(async () => {
      events.push('disable-start');
      await teardownFinished;
      events.push('disable-finish');
    });
    const enableMutation = vi.fn(async () => {
      events.push('enable');
    });
    const enable = runIOSSimulatorCapabilityMutation(enableMutation);

    await vi.waitFor(() => expect(events).toEqual(['disable-start']));
    expect(enableMutation).not.toHaveBeenCalled();

    finishTeardown();
    await expect(Promise.all([disable, enable])).resolves.toEqual([undefined, undefined]);
    expect(events).toEqual(['disable-start', 'disable-finish', 'enable']);
  });

  it('keeps an install-lock cardpoint reentrant inside the same capability mutation', async () => {
    const events: string[] = [];

    await expect(
      runIOSSimulatorCapabilityMutation(async () => {
        events.push('outer');
        await runIOSSimulatorManifestMutation([{ slots: ['ios-simulator'] }], async () => {
          events.push('inner');
        });
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(['outer', 'inner']);
  });

  it.each([
    {
      name: 'an enabled install',
      manifests: [{ slots: ['ios-simulator'] }],
    },
    {
      name: 'an update that adds the slot',
      manifests: [{ slots: [] }, { slots: ['ios-simulator'] }],
    },
    {
      name: 'an update that removes the slot',
      manifests: [{ slots: ['ios-simulator'] }, { slots: [] }],
    },
  ])('queues $name behind an older teardown', async ({ manifests }) => {
    let finishTeardown!: () => void;
    const teardownFinished = new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
    const events: string[] = [];
    const disable = runIOSSimulatorCapabilityMutation(async () => {
      events.push('disable-start');
      await teardownFinished;
      events.push('disable-finish');
    });
    const packageMutation = runIOSSimulatorManifestMutation(manifests, async () => {
      events.push('package-mutation');
    });

    await vi.waitFor(() => expect(events).toEqual(['disable-start']));
    finishTeardown();
    await Promise.all([disable, packageMutation]);

    expect(events).toEqual(['disable-start', 'disable-finish', 'package-mutation']);
  });

  it('does not serialize an update when neither manifest owns the slot', async () => {
    let finishTeardown!: () => void;
    const teardownFinished = new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
    const events: string[] = [];
    const disable = runIOSSimulatorCapabilityMutation(async () => {
      events.push('disable-start');
      await teardownFinished;
      events.push('disable-finish');
    });

    await vi.waitFor(() => expect(events).toEqual(['disable-start']));
    await runIOSSimulatorManifestMutation([{ slots: [] }, { slots: ['panel'] }], async () => {
      events.push('ordinary-update');
    });
    expect(events).toEqual(['disable-start', 'ordinary-update']);

    finishTeardown();
    await disable;
  });

  it('lets an existing package mutation hold and release the same FIFO explicitly', async () => {
    let finishTeardown!: () => void;
    const teardownFinished = new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
    const events: string[] = [];
    const disable = runIOSSimulatorCapabilityMutation(async () => {
      events.push('disable-start');
      await teardownFinished;
      events.push('disable-finish');
    });

    await vi.waitFor(() => expect(events).toEqual(['disable-start']));
    const leasePromise = acquireIOSSimulatorManifestMutation([
      { slots: [] },
      { slots: ['ios-simulator'] },
    ]);
    let acquired = false;
    void leasePromise.then(() => {
      acquired = true;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);

    finishTeardown();
    const release = await leasePromise;
    events.push('package-mutation');
    release();
    await disable;

    expect(events).toEqual(['disable-start', 'disable-finish', 'package-mutation']);
  });
});
