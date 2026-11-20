import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const fork = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ utilityProcess: { fork } }));

import '../pre-run-hook.desktop';
import { executePreRunHook } from '../pre-run-hook';

afterEach(() => {
  vi.useRealTimers();
  fork.mockReset();
});

// Unit, #11419 / #11149: only this file registers Desktop's spawner. The
// shell-hook tests use Node's native close event and cannot model a missing EOF.
it.each([
  [0, 'passed', 'run'],
  [2, 'skipped', 'skip'],
  [3, 'failed', 'block'],
] as const)('settles Desktop exit %s when stderr never ends', async (exitCode, status, decision) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    postMessage: vi.fn(),
    kill: vi.fn(() => true),
  });
  const spawned = new Promise<void>(resolve => {
    fork.mockImplementationOnce(() => {
      resolve();
      return child;
    });
  });
  const result = executePreRunHook({
    command: 'cindy-node-script "check.cjs"',
    timeoutMs: 2_000,
    stdinPayload: {
      event: 'schedule-pre-run', scheduleId: 'schedule', scheduleName: 'check',
      runId: 'run', firedAt: 1_700_000_000_000,
    },
  });
  await spawned;
  child.emit('message', { type: 'ready' });
  child.emit('exit', exitCode);
  await vi.advanceTimersByTimeAsync(5);
  child.stdout.end('check result\n');
  await vi.advanceTimersByTimeAsync(3_100);

  await expect(result).resolves.toMatchObject({
    status, decision, exitCode, timedOut: false, stdout: 'check result\n',
  });
});
