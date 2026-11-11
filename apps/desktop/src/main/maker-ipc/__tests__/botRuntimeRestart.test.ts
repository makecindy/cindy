import { afterEach, describe, expect, it, vi } from 'vitest';
import { restartBotRuntime } from '../botRuntimeRestart.js';
import {
  withSessionRestartLock,
  withSendToSessionLock,
  waitForSendToSessionLock,
  sendToSessionLocks,
  trackSendToSessionLockRun,
} from '../sendToSessionLock.js';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

afterEach(() => vi.useRealTimers());

function harness() {
  return {
    stopInput: vi.fn(),
    withSessionLock: async <T>(_id: string, run: () => Promise<T>) => run(),
    rebuild: vi.fn(async (_id: string, assertCurrent: () => void) => assertCurrent()),
    onClosed: vi.fn(),
  };
}

describe('Bot runtime restart', () => {
  it('fences an uninterruptible close after timeout, rejects new work, and never watchdog-releases it', async () => {
    vi.useFakeTimers();
    const deps = harness();
    deps.withSessionLock = withSessionRestartLock;
    let settle!: () => void;
    const nativeClose = new Promise<void>((resolve) => {
      settle = resolve;
    });
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => {
      await nativeClose;
      assertCurrent();
    });
    const operation = restartBotRuntime('hung-restart', vi.fn(), deps);
    const failed = expect(operation).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    const send = vi.fn();
    await expect(withSendToSessionLock('hung-restart', send)).rejects.toThrow(
      'restart is still in progress',
    );
    await expect(restartBotRuntime('hung-restart', vi.fn(), deps)).rejects.toThrow(
      'restart is still in progress',
    );
    await expect(
      waitForSendToSessionLock('hung-restart', sendToSessionLocks.get('hung-restart')),
    ).rejects.toThrow('restart is still in progress');
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(sendToSessionLocks.has('hung-restart')).toBe(true);
    expect(deps.rebuild).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    // Other teammates continue normally throughout the hung close.
    await withSendToSessionLock('other-bot', send);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => assertCurrent());
    await restartBotRuntime('hung-restart', vi.fn(), deps);
    expect(deps.onClosed).toHaveBeenCalledTimes(1);
  });

  it('rejects queued sends without letting restart overtake their still-running predecessor', async () => {
    let finish!: () => void;
    const running = withSendToSessionLock(
      'queued-restart',
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const send = vi.fn();
    const queued = withSendToSessionLock('queued-restart', send);
    const rejected = expect(queued).rejects.toThrow('restart is in progress');
    const chain = waitForSendToSessionLock(
      'queued-restart',
      sendToSessionLocks.get('queued-restart'),
    ).then(send);
    const tracked = trackSendToSessionLockRun('queued-restart', chain);
    const chainRejected = expect(tracked).rejects.toThrow('restart is in progress');
    const rebuild = vi.fn();
    const restart = withSessionRestartLock('queued-restart', rebuild);
    await rejected;
    await chainRejected;
    expect(rebuild).not.toHaveBeenCalled();
    finish();
    await running;
    await restart;
    expect(rebuild).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('stops old input before rebuilding and publishes completion only afterwards', async () => {
    const deps = harness();
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => {
      assertCurrent();
      expect(deps.stopInput).toHaveBeenCalledWith('canonical');
      expect(deps.onClosed).not.toHaveBeenCalled();
    });
    await restartBotRuntime('canonical', vi.fn(), deps);
    expect(deps.onClosed).toHaveBeenCalledWith('canonical');
  });

  it('returns a bounded failure and prevents a late close from committing a rebuild', async () => {
    vi.useFakeTimers();
    const deps = harness();
    let closed!: () => void;
    const close = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const commit = vi.fn();
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => {
      await close;
      assertCurrent();
      commit();
    });
    const restart = restartBotRuntime('canonical', vi.fn(), deps);
    const failed = expect(restart).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    closed();
    await vi.advanceTimersByTimeAsync(1);
    expect(commit).not.toHaveBeenCalled();
    expect(deps.onClosed).not.toHaveBeenCalled();
  });

  it('does not restart after the data owner changes while waiting for the send lock', async () => {
    const deps = harness();
    let current = true;
    deps.withSessionLock = async (_id, run) => {
      current = false;
      return run();
    };
    await expect(
      restartBotRuntime(
        'canonical',
        () => {
          if (!current) throw new Error('owner changed');
        },
        deps,
      ),
    ).rejects.toThrow('owner changed');
    expect(deps.rebuild).not.toHaveBeenCalled();
    expect(deps.onClosed).not.toHaveBeenCalled();
  });
});
