import { describe, expect, it } from 'vitest';
import { createRemoteSyncRunner } from '@/device-link/remoteSyncTask';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('remote sync task runner', () => {
  it('coalesces repeated triggers into one in-flight run and one follow-up run', async () => {
    const gates = [deferred(), deferred()];
    const starts: number[] = [];
    const runner = createRemoteSyncRunner(async () => {
      const index = starts.length;
      starts.push(index);
      await gates[index].promise;
    });

    const first = runner.run();
    const second = runner.run();
    const third = runner.run();

    expect(runner.isRunning()).toBe(true);
    expect(starts).toEqual([0]);
    expect(second).toBe(first);
    expect(third).toBe(first);

    gates[0].resolve();
    await nextTick();
    expect(starts).toEqual([0, 1]);

    gates[1].resolve();
    await first;

    expect(runner.isRunning()).toBe(false);
    expect(starts).toEqual([0, 1]);
  });

  it('runs again normally after the previous drain finishes', async () => {
    let count = 0;
    const runner = createRemoteSyncRunner(async () => {
      count += 1;
    });

    await runner.run();
    await runner.run();

    expect(count).toBe(2);
  });
});
