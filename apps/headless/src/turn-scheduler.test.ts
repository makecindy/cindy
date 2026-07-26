import { describe, expect, it } from 'vitest';
import { HeadlessTurnScheduler } from './turn-scheduler.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe('HeadlessTurnScheduler', () => {
  it('serializes one session while allowing other sessions up to the global turn budget', async () => {
    const scheduler = new HeadlessTurnScheduler(2);
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const started: string[] = [];
    scheduler.enqueue('s1', async () => { started.push('s1-first'); await first.promise; });
    scheduler.enqueue('s1', async () => { started.push('s1-second'); await second.promise; });
    scheduler.enqueue('s2', async () => { started.push('s2'); await third.promise; });
    await settle();
    expect(started).toEqual(['s1-first', 's2']);
    expect(scheduler.snapshot()).toMatchObject({ activeTurns: 2, queuedTurns: 1 });

    first.resolve();
    await settle();
    expect(started).toEqual(['s1-first', 's2', 's1-second']);
    second.resolve();
    third.resolve();
    await settle();
    expect(scheduler.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
  });

  it('can discard a queued turn without interrupting the active turn', async () => {
    const scheduler = new HeadlessTurnScheduler(1);
    const active = deferred();
    const started: string[] = [];
    scheduler.enqueue('s1', async () => { started.push('active'); await active.promise; });
    scheduler.enqueue('s1', async () => { started.push('discarded'); });
    expect(scheduler.cancelQueued('s1')).toBe(1);
    active.resolve();
    await settle();
    expect(started).toEqual(['active']);
  });
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
