import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '@cindy/maker-scheduler';

import { runSchedulerStartup } from '../scheduler-startup-lifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runSchedulerStartup', () => {
  it('stops a startup superseded while scheduler.start is pending', async () => {
    let generation = 0;
    const startGate = deferred();
    const scheduler = {
      start: vi.fn(() => startGate.promise),
      stop: vi.fn(async () => {}),
    } as unknown as Scheduler;
    const publish = vi.fn();

    const startup = runSchedulerStartup(0, () => generation, {
      create: () => scheduler,
      publish,
    });
    generation += 1;
    startGate.resolve();

    await expect(startup).rejects.toThrow('scheduler startup superseded by reset');
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it('stops a startup superseded during post-start cleanup', async () => {
    let generation = 0;
    const cleanupGate = deferred();
    const scheduler = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } as unknown as Scheduler;
    const publish = vi.fn();

    const startup = runSchedulerStartup(0, () => generation, {
      create: () => scheduler,
      afterStart: () => cleanupGate.promise,
      publish,
    });
    await Promise.resolve();
    generation += 1;
    cleanupGate.resolve();

    await expect(startup).rejects.toThrow('scheduler startup superseded by reset');
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
});
