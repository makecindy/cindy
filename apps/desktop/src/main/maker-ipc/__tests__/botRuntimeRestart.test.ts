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
    ensureQueueRestored: vi.fn(async () => {}),
    stopInput: vi.fn(),
    flushStopPersistence: vi.fn(async () => {}),
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

  it('persists the stop cause before rebuilding so a restart never completes without it', async () => {
    // #7534:「重启伙伴」按住的队列必须先把暂停来源落盘,再重建运行时。
    // 顺序反了的话,重启报成功时快照里还没有暂停来源,进程随后退出就会把它
    // 当成崩溃恢复暂停,外部投递会重放用户已经收手的请求。
    const deps = harness();
    const order: string[] = [];
    deps.flushStopPersistence.mockImplementation(async () => { order.push('flush'); });
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => {
      order.push('rebuild');
      assertCurrent();
    });
    await restartBotRuntime('canonical', vi.fn(), deps);
    expect(order).toEqual(['flush', 'rebuild']);
  });

  it('restores the queue before stopping so the stop cause can be persisted at all', async () => {
    // #7512 review P1:未恢复的会话上 stop 只能标内存态,maybePersistQueueSnapshot
    // 因「未恢复不写」早退,flush 空转 —— 重启报成功而快照里没有暂停来源。
    // 与 explicitStopImpl 同序:恢复 → stop → 落盘。
    const deps = harness();
    const order: string[] = [];
    deps.ensureQueueRestored.mockImplementation(async () => { order.push('restore'); });
    deps.stopInput.mockImplementation(() => { order.push('stop'); });
    deps.flushStopPersistence.mockImplementation(async () => { order.push('flush'); });
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => {
      order.push('rebuild');
      assertCurrent();
    });
    await restartBotRuntime('canonical', vi.fn(), deps);
    expect(order).toEqual(['restore', 'stop', 'flush', 'rebuild']);
  });

  it('fences sends and bounds a stalled queue restore before stopping input', async () => {
    // 测试价值
    // - 生产入口与可观察结果：restartBotRuntime + withSessionRestartLock；快照恢复挂起时，新发送被拒绝且重启 30 秒内失败。
    // - Bug／规则依据：#7512 Codex P2，重启 fence 与超时必须覆盖队列恢复。
    // - 现有覆盖缺口：既有超时用例只挂在 rebuild，未覆盖 restore 尚未完成的窗口。
    // - 最小失败输入：ensureQueueRestored 不结束，同时尝试向同一 session 发送。
    // - tier：unit；通过真实 restart lock 和注入的挂起恢复依赖验证时序。
    // - 实测耗时：4.74s wall（单文件 Vitest）。
    vi.useFakeTimers();
    const deps = harness();
    let finishRestore!: () => void;
    let enteredRestore!: () => void;
    const restoreEntered = new Promise<void>((resolve) => { enteredRestore = resolve; });
    let lockSettled!: () => void;
    const restartLockSettled = new Promise<void>((resolve) => { lockSettled = resolve; });
    deps.ensureQueueRestored.mockImplementation(async () => {
      enteredRestore();
      await new Promise<void>((resolve) => { finishRestore = resolve; });
    });
    deps.withSessionLock = async (id, run) => {
      try {
        return await withSessionRestartLock(id, run);
      } finally {
        lockSettled();
      }
    };

    const operation = restartBotRuntime('restore-hung', vi.fn(), deps);
    const failed = expect(operation).rejects.toThrow('timed out');
    await restoreEntered;
    const send = vi.fn();
    await expect(withSendToSessionLock('restore-hung', send)).rejects.toThrow(
      'restart is still in progress',
    );
    const otherSend = vi.fn();
    await withSendToSessionLock('other-bot', otherSend);
    expect(otherSend).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(deps.stopInput).not.toHaveBeenCalled();
    expect(deps.flushStopPersistence).not.toHaveBeenCalled();
    expect(deps.rebuild).not.toHaveBeenCalled();
    await expect(withSendToSessionLock('restore-hung', send)).rejects.toThrow(
      'restart is still in progress',
    );

    finishRestore();
    await restartLockSettled;
    expect(deps.stopInput).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('fails the restart before stopping when the queue snapshot cannot be restored', async () => {
    const deps = harness();
    deps.ensureQueueRestored.mockImplementation(async () => { throw new Error('snapshot read failed'); });
    await expect(restartBotRuntime('canonical', vi.fn(), deps)).rejects.toThrow('snapshot read failed');
    expect(deps.stopInput).not.toHaveBeenCalled();
    expect(deps.flushStopPersistence).not.toHaveBeenCalled();
    expect(deps.rebuild).not.toHaveBeenCalled();
    expect(deps.onClosed).not.toHaveBeenCalled();
  });

  it('fails the restart when the stop cause cannot be persisted', async () => {
    const deps = harness();
    deps.flushStopPersistence.mockImplementation(async () => { throw new Error('snapshot write failed'); });
    await expect(restartBotRuntime('canonical', vi.fn(), deps)).rejects.toThrow('snapshot write failed');
    expect(deps.rebuild).not.toHaveBeenCalled();
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
