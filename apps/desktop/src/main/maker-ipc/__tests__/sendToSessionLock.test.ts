import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireSendToSessionLock,
  hasSendToSessionLock,
  trackSendToSessionLockRun,
  withSendToSessionLock,
  withSessionRestartLock,
} from '../sendToSessionLock';

const h = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: (...args: unknown[]) => h.warn(...args),
    error: () => undefined,
  }),
}));

const warnMock = h.warn;

describe('sendToSessionLock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    warnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns and bails when a chained critical section never settles', async () => {
    let settleRun!: () => void;
    const run = new Promise<void>((resolve) => {
      settleRun = resolve;
    });
    let stage = 'queue-restore';
    const observed = trackSendToSessionLockRun('s1', run, () => stage);

    expect(hasSendToSessionLock('s1')).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toBe('sendToSession lock still held after expected budget');
    expect(warnMock.mock.calls[0][1]).toMatchObject({ sessionId: 's1', stage: 'queue-restore' });

    // 泄漏告警后 5min 强制 bail:条目从 map 释放,后续发送不再排队等死。
    stage = 'live-send';
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(warnMock.mock.calls[1][0]).toBe(
      'sendToSession lock bailed out; later senders proceed while the stuck holder finishes',
    );
    expect(warnMock.mock.calls[1][1]).toMatchObject({ sessionId: 's1', stage: 'live-send' });
    expect(hasSendToSessionLock('s1')).toBe(false);

    // bail 后新链不再被僵尸条目阻塞。
    const nextRun = Promise.resolve('next');
    trackSendToSessionLockRun('s1', nextRun, () => 'done');
    await expect(nextRun).resolves.toBe('next');

    // 僵尸最终结算:不得删掉/覆盖后来者的条目,也不产生额外日志。
    settleRun();
    await expect(observed).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(hasSendToSessionLock('s1')).toBe(false);
  });

  it('does not warn or bail on a critical section that settles in time', async () => {
    let resolveRun!: (value: string) => void;
    const run = new Promise<string>((resolve) => {
      resolveRun = resolve;
    });
    const observed = trackSendToSessionLockRun('s2', run, () => 'live-send');
    resolveRun('ok');
    await expect(observed).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(warnMock).not.toHaveBeenCalled();
    expect(hasSendToSessionLock('s2')).toBe(false);
  });

  it('frees the entry when the critical section rejects and still lets waiters proceed', async () => {
    const run = Promise.reject(new Error('boom'));
    const observed = trackSendToSessionLockRun('s3', run);
    await expect(observed).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(0);
    expect(hasSendToSessionLock('s3')).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
    // 下一个 waiter 无需等待即成为新队头。
    const next = withSendToSessionLock('s3', async () => 'next');
    await expect(next).resolves.toBe('next');
  });

  it('keeps FIFO order for the acquire/release lease form', async () => {
    const first = await acquireSendToSessionLock('s4');
    let secondAcquired = false;
    const second = acquireSendToSessionLock('s4').then((release) => {
      secondAcquired = true;
      release();
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondAcquired).toBe(false);
    first();
    await second;
    await vi.advanceTimersByTimeAsync(0);
    expect(secondAcquired).toBe(true);
    expect(hasSendToSessionLock('s4')).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('bails a lease whose holder never releases and does not clobber the successor entry', async () => {
    const first = await acquireSendToSessionLock('s5');
    let secondReleased = false;
    const second = acquireSendToSessionLock('s5').then((release) => {
      secondReleased = true;
      release();
    });
    await vi.advanceTimersByTimeAsync(30_000 + 5 * 60_000);
    // 第二个持有者越过僵尸条目拿到锁并正常释放。
    await second;
    expect(secondReleased).toBe(true);
    expect(hasSendToSessionLock('s5')).toBe(false);
    // 僵尸的迟到 release 不得把后继条目复活/误删。
    first();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(hasSendToSessionLock('s5')).toBe(false));
    expect(warnMock.mock.calls.filter(([m]) => m.includes('bailed out'))).toHaveLength(1);
  });

  it('serializes withSendToSessionLock tasks and cleans up on throw', async () => {
    const order: string[] = [];
    const a = withSendToSessionLock('s6', async () => {
      order.push('a:start');
      // real-wait: keep the first lock holder active while the queued call observes serialization.
      await new Promise((r) => setTimeout(r, 100));
      order.push('a:end');
    });
    const b = withSendToSessionLock('s6', async () => {
      order.push('b');
    });
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([a, b]);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
    expect(hasSendToSessionLock('s6')).toBe(false);

    await expect(
      withSendToSessionLock('s6', async () => {
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(hasSendToSessionLock('s6')).toBe(false);
  });

  it.each(['lease', 'wrapper'] as const)('reports the current %s holder stage at warn and bail', async (form) => {
    const id = `staged-${form}`;
    let stage = 'prepare';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = form === 'lease'
      ? acquireSendToSessionLock(id, undefined, () => stage).then(async (unlock) => {
        await gate;
        unlock();
      })
      : withSendToSessionLock(id, () => gate, () => stage);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnMock).toHaveBeenLastCalledWith(
      'sendToSession lock still held after expected budget',
      { sessionId: id, heldMs: 30_000, stage: 'prepare' },
    );
    stage = 'dispatch';
    await vi.advanceTimersByTimeAsync(270_000);
    expect(warnMock).toHaveBeenLastCalledWith(
      'sendToSession lock bailed out; later senders proceed while the stuck holder finishes',
      { sessionId: id, heldMs: 300_000, stage: 'dispatch' },
    );
    expect(hasSendToSessionLock(id)).toBe(false);
    release();
    await run;
  });

  it('samples only the acquired holder, then stops sampling after release', async () => {
    const firstStage = vi.fn(() => 'first');
    const secondStage = vi.fn(() => 'second');
    const first = await acquireSendToSessionLock('staged-queue', undefined, firstStage);
    const secondPending = acquireSendToSessionLock('staged-queue', undefined, secondStage);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(firstStage).toHaveBeenCalledTimes(1);
    expect(secondStage).not.toHaveBeenCalled();
    first();
    const second = await secondPending;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(firstStage).toHaveBeenCalledTimes(1);
    expect(secondStage).toHaveBeenCalledTimes(1);
    second();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(secondStage).toHaveBeenCalledTimes(1);
    expect(hasSendToSessionLock('staged-queue')).toBe(false);
  });

  it('starts each watchdog after acquisition so a stalled holder cannot release all queued sends', async () => {
    const first = await acquireSendToSessionLock('queued-watchdogs');
    let secondRelease: (() => void) | undefined;
    let thirdAcquired = false;
    const second = acquireSendToSessionLock('queued-watchdogs').then((release) => {
      secondRelease = release;
    });
    const third = acquireSendToSessionLock('queued-watchdogs').then((release) => {
      thirdAcquired = true;
      release();
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await second;
    expect(secondRelease).toBeTypeOf('function');
    expect(thirdAcquired).toBe(false);
    expect(hasSendToSessionLock('queued-watchdogs')).toBe(true);

    first();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(thirdAcquired).toBe(false);
    secondRelease!();
    await third;
    await vi.advanceTimersByTimeAsync(0);
    expect(hasSendToSessionLock('queued-watchdogs')).toBe(false);
  });

  it('same-chain reentry runs the nested task without deadlocking (reentrancy fix)', async () => {
    let innerRan = false;
    const result = await withSendToSessionLock('s-reentry', async () => {
      // 同链内再取同一把锁：修复前这里会等到 300s bail，修复后直接放行。
      const nested = await withSendToSessionLock('s-reentry', async () => {
        innerRan = true;
        return 'inner-ok';
      });
      expect(nested).toBe('inner-ok');
      expect(innerRan).toBe(true);
      return 'outer-ok';
    });
    expect(result).toBe('outer-ok');
    expect(innerRan).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasSendToSessionLock('s-reentry')).toBe(false);
    // 重入走静默放行（同 ghostInstallLock 惯例）：不应产生任何 bail 类警告。
    expect(warnMock.mock.calls.some((call) => String(call[0]).includes('bailed out'))).toBe(false);
  });

  it('a detached background send spawned inside the critical section re-queues after the outer release', async () => {
    // 模拟 enqueueQueuedMessage 的未等待后台任务：继承 ALS 上下文，但在外层
    // 释放后才取锁；此时另一个请求已持有同一会话锁，它必须排队而非绕过。
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let bgDone = false;
    let bgFinished!: Promise<void>;
    await withSendToSessionLock('s-bg', async () => {
      bgFinished = gate.then(() =>
        withSendToSessionLock('s-bg', async () => {
          bgDone = true;
        }),
      );
    });

    let releaseOther!: () => void;
    const otherHolding = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    const other = withSendToSessionLock('s-bg', () => otherHolding);

    openGate();
    await vi.advanceTimersByTimeAsync(0);
    expect(bgDone).toBe(false);

    releaseOther();
    await other;
    await bgFinished;
    expect(bgDone).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasSendToSessionLock('s-bg')).toBe(false);
  });

  it('same-chain reentry still passes when another acquisition is queued behind the holder', async () => {
    // sendToSessionLocks 存的是队尾：持锁期间到达的另一个请求会立即把自己的
    // 条目装成队尾。归属判定不能读锁表，否则持锁者的嵌套调用会被排到这个
    // 等待者之后，重新变成自锁（外层等嵌套、等待者等外层 → 300s bail）。
    let innerRan = false;
    let queuedAcquired = false;
    let releaseQueued!: () => void;
    const queuedHolding = new Promise<void>((resolve) => {
      releaseQueued = resolve;
    });
    let queuedDone!: Promise<void>;

    await withSendToSessionLock('s-queue', async () => {
      // 另一个请求（lease 形态，不参与重入放行）在持锁期间开始排队。
      queuedDone = (async () => {
        const release = await acquireSendToSessionLock('s-queue');
        queuedAcquired = true;
        await queuedHolding;
        release();
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(queuedAcquired).toBe(false);

      // 持锁者的同链嵌套必须立即执行，不能排到已排队的请求之后。
      await withSendToSessionLock('s-queue', async () => {
        innerRan = true;
      });
      expect(innerRan).toBe(true);
    });

    // 外层释放后，排队请求才取得锁。
    releaseQueued();
    await queuedDone;
    expect(innerRan).toBe(true);
    expect(queuedAcquired).toBe(true);
  });

  it('same-chain reentry is refused once a session restart is queued', async () => {
    // withSessionRestartLock 先登记重启标记再排队；“重启已在等待”与持锁无关，
    // 重入放行必须继续守栅栏，否则嵌套发送会在重启开始后执行。
    let nestedRan = false;
    let releaseRestart!: () => void;
    const restartHolding = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    let restartDone!: Promise<void>;

    await withSendToSessionLock('s-restart', async () => {
      restartDone = (async () => {
        const result = await withSessionRestartLock('s-restart', () => restartHolding);
        return result;
      })();
      // 重启在排队等外层释放，标记已登记。
      await vi.advanceTimersByTimeAsync(0);

      await expect(withSendToSessionLock('s-restart', async () => {
        nestedRan = true;
      })).rejects.toThrow('Session restart is still in progress');
      expect(nestedRan).toBe(false);
    });

    releaseRestart();
    await restartDone;
    expect(nestedRan).toBe(false);
  });
});
