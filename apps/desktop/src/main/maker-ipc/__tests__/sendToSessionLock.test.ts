import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireSendToSessionLock,
  hasSendToSessionLock,
  trackSendToSessionLockRun,
  withSendToSessionLock,
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
});
