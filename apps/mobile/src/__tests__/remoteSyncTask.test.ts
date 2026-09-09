import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteSyncCoordinator,
  createRemoteSyncReopenCoordinator,
  createRemoteSyncRunner,
} from '@/device-link/remoteSyncTask';

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

function readSessionScreenSource(): string {
  return readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8').replace(/\r\n/g, '\n');
}

describe('remote sync task runner', () => {
  it('shares one successful peer reopen across staggered retries in the same sync run', async () => {
    const reopen = vi.fn(async () => undefined);
    const coordinator = createRemoteSyncReopenCoordinator(reopen);
    const failedAtVersion = coordinator.captureVersion();

    const first = coordinator.reopenAfter(failedAtVersion);
    await first;
    const later = coordinator.reopenAfter(failedAtVersion);

    expect(later).toBe(first);
    await later;
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('allows a new reopen when an operation fails after the previous recovery', async () => {
    const reopen = vi.fn(async () => undefined);
    const coordinator = createRemoteSyncReopenCoordinator(reopen);

    await coordinator.reopenAfter(coordinator.captureVersion());
    const requestStartedAfterRecovery = coordinator.captureVersion();
    await coordinator.reopenAfter(requestStartedAfterRecovery);

    expect(reopen).toHaveBeenCalledTimes(2);
    expect(coordinator.captureVersion()).toBe(2);
  });

  it('allows the same sync run to retry after a failed peer reopen', async () => {
    const reopen = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const coordinator = createRemoteSyncReopenCoordinator(reopen);
    const failedAtVersion = coordinator.captureVersion();

    await expect(coordinator.reopenAfter(failedAtVersion)).rejects.toThrow('offline');
    await expect(coordinator.reopenAfter(failedAtVersion)).resolves.toBeUndefined();
    expect(reopen).toHaveBeenCalledTimes(2);
  });

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

describe('remote sync coordinator', () => {
  it('merges repeated passive requests into one follow-up run', async () => {
    const gates = [deferred(), deferred()];
    const runs: Array<{ reasons: readonly string[]; replaceMessages: boolean }> = [];
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      const index = runs.length;
      runs.push({ reasons: run.reasons, replaceMessages: run.replaceMessages });
      await gates[index].promise;
    });
    coordinator.setContext('dev-1:session-1');

    const first = coordinator.request({ reason: 'mount' });
    const second = coordinator.request({ reason: 'presence' });
    const third = coordinator.request({ reason: 'breaker' });

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(runs).toEqual([{ reasons: ['mount'], replaceMessages: false }]);

    gates[0].resolve();
    await nextTick();
    expect(runs).toEqual([
      { reasons: ['mount'], replaceMessages: false },
      { reasons: ['presence', 'breaker'], replaceMessages: false },
    ]);

    gates[1].resolve();
    await first;
    expect(coordinator.isRunning()).toBe(false);
  });

  it('lets an authoritative replacement invalidate an in-flight passive run', async () => {
    const gates = [deferred(), deferred()];
    const staleChecks: Array<() => boolean> = [];
    const replaceModes: boolean[] = [];
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      const index = replaceModes.length;
      replaceModes.push(run.replaceMessages);
      staleChecks.push(run.isStale);
      await gates[index].promise;
    });
    coordinator.setContext('dev-1:session-1');

    const task = coordinator.request({ reason: 'mount' });
    expect(staleChecks[0]()).toBe(false);
    void coordinator.request({ reason: 'rewind', replaceMessages: true });
    expect(staleChecks[0]()).toBe(true);

    gates[0].resolve();
    await nextTick();
    expect(replaceModes).toEqual([false, true]);
    expect(staleChecks[1]()).toBe(false);

    gates[1].resolve();
    await task;
  });

  it('invalidates old identity runs and drops their queued follow-up', async () => {
    const gates = [deferred(), deferred()];
    const runs: Array<{ reasons: readonly string[]; isStale: () => boolean }> = [];
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      const index = runs.length;
      runs.push({ reasons: run.reasons, isStale: run.isStale });
      await gates[index].promise;
    });
    coordinator.setContext('dev-1:session-a');

    const task = coordinator.request({ reason: 'mount-a' });
    void coordinator.request({ reason: 'retry-a' });
    coordinator.setContext('dev-1:session-b');
    void coordinator.request({ reason: 'mount-b' });

    expect(runs[0].isStale()).toBe(true);
    gates[0].resolve();
    await nextTick();
    expect(runs.map((run) => run.reasons)).toEqual([['mount-a'], ['mount-b']]);
    expect(runs[1].isStale()).toBe(false);

    gates[1].resolve();
    await task;
  });

  it('continues with a queued follow-up after a failed run', async () => {
    const runs: string[][] = [];
    const firstStarted = deferred();
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      runs.push([...run.reasons]);
      if (runs.length === 1) {
        firstStarted.resolve();
        await nextTick();
        throw new Error('first failed');
      }
    });
    coordinator.setContext('dev-1:session-1');

    const task = coordinator.request({ reason: 'first' });
    await firstStarted.promise;
    void coordinator.request({ reason: 'follow-up' });

    await expect(task).rejects.toThrow('first failed');
    expect(runs).toEqual([['first'], ['follow-up']]);
  });

  it('clears loading when a queued sync is blocked for a newly-created session', () => {
    const source = readSessionScreenSource();
    expect(source).toContain(
      'if (shouldBlockSessionSync(sessionId)) {\n      if (!syncRun.isStale()) setLoading(false);\n      return;\n    }',
    );
  });

  it('resets loading when the reused screen switches sessions', () => {
    const source = readSessionScreenSource();
    expect(source).toContain(
      'setRewindState({ kind: \'idle\' });\n    setMessageActionBusy(null);\n    setLoading(false);',
    );
  });

  it('uses the force-reopen callback for subscription and snapshot retries', () => {
    const source = readSessionScreenSource();
    expect(source).toContain(
      'reopenLink: () => syncReopenCoordinator.reopenAfter(subscriptionAttemptVersion)',
    );
    expect(source).toContain(
      'await syncReopenCoordinator.reopenAfter(failedAtVersion);',
    );
    expect(source).toContain(
      'const syncReopenCoordinator = createRemoteSyncReopenCoordinator(',
    );
    expect(source).not.toContain(
      'reopenLink: async () => {\n          await openLink(deviceId);\n        }',
    );
  });

  it('applies coordinator context and task changes after render commits', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/device-link/remoteSyncTask.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(source).toContain(
      'useLayoutEffect(() => {\n    taskRef.current = task;\n    coordinatorRef.current?.setContext(contextKey);\n  }, [contextKey, task]);',
    );
    expect(source).not.toContain(
      '  taskRef.current = task;\n  const coordinatorRef =',
    );
    expect(source).not.toContain('coordinatorRef.current.setContext(contextKey);');
  });
});
