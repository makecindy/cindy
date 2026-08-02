import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createTransportTimeoutReopenLoop } from '../transportTimeoutReopen';

describe('createTransportTimeoutReopenLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次失败后按指数退避重试,成功即终止循环', async () => {
    const reopen = vi.fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);
    const loop = createTransportTimeoutReopenLoop({
      reopen,
      shouldAbort: () => false,
      baseDelayMs: 1_000,
      maxAttempts: 5,
    });

    loop.trigger('dev-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).toHaveBeenCalledTimes(1);

    // 第 1 次失败 → 1s 后重试
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reopen).toHaveBeenCalledTimes(2);

    // 第 2 次失败 → 2s 后重试(指数退避)
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reopen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reopen).toHaveBeenCalledTimes(3);

    // 第 3 次成功 → 终止,不再重试
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reopen).toHaveBeenCalledTimes(3);
    expect(loop.isActive('dev-a')).toBe(false);
  });

  it('循环进行中重复 trigger 为 no-op(per-device 去重)', async () => {
    const reopen = vi.fn().mockRejectedValue(new Error('busy'));
    const loop = createTransportTimeoutReopenLoop({
      reopen,
      shouldAbort: () => false,
      baseDelayMs: 1_000,
      maxAttempts: 3,
    });

    loop.trigger('dev-a');
    await vi.advanceTimersByTimeAsync(0);
    loop.trigger('dev-a'); // 退避等待中重复触发
    loop.trigger('dev-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reopen).toHaveBeenCalledTimes(2); // 只有原循环的两次,没有并行链

    // 不同设备互不影响
    loop.trigger('dev-b');
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).toHaveBeenCalledWith('dev-b');
    loop.dispose();
  });

  it('次数耗尽后放弃并清理;之后可再次 trigger', async () => {
    const warn = vi.fn();
    const reopen = vi.fn().mockRejectedValue(new Error('offline'));
    const loop = createTransportTimeoutReopenLoop({
      reopen,
      shouldAbort: () => false,
      baseDelayMs: 100,
      maxAttempts: 2,
      log: { info: vi.fn(), warn },
    });

    loop.trigger('dev-a');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(reopen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reopen).toHaveBeenCalledTimes(2); // 耗尽,不再重试
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gave up'));
    expect(loop.isActive('dev-a')).toBe(false);

    // 耗尽不是永久拉黑:下一个 transport-timeout 可以重新起循环
    loop.trigger('dev-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).toHaveBeenCalledTimes(3);
    loop.dispose();
  });

  it('旧代 reopen 晚到的回调不得影响新一代循环(cancel 后重触发)', async () => {
    const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    const reopen = vi.fn(() => new Promise<void>((resolve, reject) => {
      pending.push({ resolve: () => resolve(), reject });
    }));
    const loop = createTransportTimeoutReopenLoop({
      reopen,
      shouldAbort: () => false,
      baseDelayMs: 100,
      maxAttempts: 3,
    });

    loop.trigger('dev-a'); // 第 1 代 attempt#1 in-flight → pending[0]
    await vi.advanceTimersByTimeAsync(0);
    loop.cancel('dev-a');
    loop.trigger('dev-a'); // 第 2 代 attempt#1 in-flight → pending[1]
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).toHaveBeenCalledTimes(2);

    // 旧代失败晚到:不得 finish 新代 entry,也不得为旧代再排定时器
    pending[0].reject(new Error('stale failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.isActive('dev-a')).toBe(true);

    // 新代失败 → 其退避计时器仍然生效(未被旧代回调清掉)
    pending[1].reject(new Error('busy'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(reopen).toHaveBeenCalledTimes(3); // 第 2 代 attempt#2 → pending[2]

    // 旧代**成功**晚到的变体:同样不得删掉新代 entry
    loop.cancel('dev-a');
    loop.trigger('dev-a'); // 第 3 代 attempt#1 → pending[3]
    await vi.advanceTimersByTimeAsync(0);
    pending[2].resolve(); // 第 2 代 attempt#2 的晚到成功
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.isActive('dev-a')).toBe(true);
    loop.dispose();
  });

  it('shouldAbort(撤权/待命/离线)与 cancel/dispose 都终止循环', async () => {
    let abort = false;
    const reopen = vi.fn().mockRejectedValue(new Error('busy'));
    const loop = createTransportTimeoutReopenLoop({
      reopen,
      shouldAbort: () => abort,
      baseDelayMs: 100,
      maxAttempts: 10,
    });

    // 退避等待期间 abort 条件成立 → 下一轮尝试前终止
    loop.trigger('dev-a');
    await vi.advanceTimersByTimeAsync(0);
    abort = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(loop.isActive('dev-a')).toBe(false);

    // cancel 立即终止
    abort = false;
    loop.trigger('dev-b');
    await vi.advanceTimersByTimeAsync(0);
    loop.cancel('dev-b');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reopen.mock.calls.filter(([d]) => d === 'dev-b')).toHaveLength(1);

    // dispose 终止全部
    loop.trigger('dev-c');
    loop.trigger('dev-d');
    await vi.advanceTimersByTimeAsync(0);
    loop.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loop.isActive('dev-c')).toBe(false);
    expect(loop.isActive('dev-d')).toBe(false);
  });
});
