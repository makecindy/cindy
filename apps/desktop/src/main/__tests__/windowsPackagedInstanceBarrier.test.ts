import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireWindowsPackagedInstanceBarrier,
  __testing,
} from '../windowsPackagedInstanceBarrier.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function helperProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: { end: vi.fn(() => exit(0)) },
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => { exit(1); return true; }),
  });
  function exit(code: number) {
    child.exitCode = code;
    child.emit('exit', code, null);
  }
  vi.mocked(spawn).mockReturnValue(child as never);
  return {
    child,
    status: (status: string) => child.stdout.write(`${JSON.stringify({ status })}\n`),
  };
}

describe('windowsPackagedInstanceBarrier', () => {
  it('parses only complete helper statuses', () => {
    expect(__testing.parseBarrierStatus('{"status":"started"}')).toEqual({
      status: 'started',
    });
    expect(__testing.parseBarrierStatus('{"status":"locked"}')).toEqual({
      status: 'locked',
    });
    expect(__testing.parseBarrierStatus('{"status":"acquired"}')).toEqual({
      status: 'acquired',
    });
    expect(__testing.parseBarrierStatus('{"status":"busy"}')).toEqual({ status: 'busy' });
    expect(__testing.parseBarrierStatus('{"status":"occupied","pid":4242}')).toEqual({
      status: 'occupied',
      pid: 4242,
    });
    expect(() => __testing.parseBarrierStatus('{"status":"occupied","pid":0}')).toThrow(
      'invalid status',
    );
  });

  it('uses Electron ProcessSingleton names and a message-only-window probe', () => {
    expect(__testing.processSingletonNames('Cindy')).toEqual({
      mutexName: 'Local\\CindyProcessSingletonStartup',
      windowClass: 'Chrome_MessageWindow',
    });
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain('FindWindowEx');
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain(
      'CINDY_SINGLETON_WINDOW_CLASS',
    );
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain(
      'CINDY_SINGLETON_WINDOW_TITLE',
    );
    // Add-Type 编译必须在 mutex 锁住之后才发生，否则冷启动会吃掉竞争预算。
    expect(
      __testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT.indexOf('{"status":"locked"}'),
    ).toBeLessThan(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT.indexOf('Add-Type'));
  });

  it('waits for the helper exit after forced termination', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    let finished = false;
    const waiting = __testing
      .waitForExit(child as never, 20)
      .then(() => {
        finished = true;
      });

    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await waiting;
    expect(finished).toBe(true);
  });

  // CI cold starts must not consume the mutex wait budget. Real Win32 behavior
  // lives in the windows-resource tier; this unit drives the production handshake.
  it('keeps cold start and probe time independent from mutex contention', async () => {
    vi.useFakeTimers();
    const helper = helperProcess();
    const acquiring = acquireWindowsPackagedInstanceBarrier({
      userDataDir: 'test-profile', programName: 'CindyTest', timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(14_000);
    helper.status('started');
    await vi.advanceTimersByTimeAsync(1_000);
    helper.status('locked');
    await vi.advanceTimersByTimeAsync(14_000);
    helper.status('acquired');
    const lease = await acquiring;
    expect(lease.isHeld()).toBe(true);
    expect(helper.child.kill).not.toHaveBeenCalled();
    await lease.release();
    expect(lease.isHeld()).toBe(false);
  });

  it.each([
    { stage: 'starting', statuses: [], delay: 15_000 },
    { stage: 'waiting for', statuses: ['started'], delay: 1_050 },
    { stage: 'probing', statuses: ['started', 'locked'], delay: 15_000 },
  ])('terminates a helper stalled while $stage', async ({ stage, statuses, delay }) => {
    vi.useFakeTimers();
    const helper = helperProcess();
    const rejected = expect(acquireWindowsPackagedInstanceBarrier({
      userDataDir: 'test-profile', programName: 'CindyTest', timeoutMs: 50,
    })).rejects.toThrow(`timed out ${stage} Windows packaged-instance barrier`);
    for (const status of statuses) helper.status(status);
    await vi.advanceTimersByTimeAsync(delay);
    await rejected;
    expect(helper.child.kill).toHaveBeenCalled();
  });
});
