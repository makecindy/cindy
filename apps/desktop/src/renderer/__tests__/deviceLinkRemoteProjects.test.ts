import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createReconcileBackoff,
  resolveIneligibleRemoteProjectAction,
  startRemoteSessionsReconciler,
} from '@/features/device-link/useDeviceLinkRemoteProjects';

afterEach(() => {
  vi.useRealTimers();
});

describe('startRemoteSessionsReconciler', () => {
  it('periodically refreshes every eligible device and stops cleanly', async () => {
    vi.useFakeTimers();
    const eligible = new Map([
      ['dev-a', 'Mac A'],
      ['dev-b', 'Mac B'],
    ]);
    const refresh = vi.fn(async () => 'ok');
    const stop = startRemoteSessionsReconciler(() => eligible, refresh, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh.mock.calls).toEqual([
      ['dev-a', 'Mac A'],
      ['dev-b', 'Mac B'],
    ]);

    eligible.delete('dev-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenLastCalledWith('dev-b', 'Mac B');
    expect(refresh).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('连续 gave-up 的设备按指数退避放慢,成功后复位;其它设备不受影响', async () => {
    vi.useFakeTimers();
    const eligible = new Map([
      ['dev-bad', 'Mac Bad'],
      ['dev-good', 'Mac Good'],
    ]);
    let badResult: string = 'gave-up';
    const refresh = vi.fn(async (deviceId: string) =>
      deviceId === 'dev-bad' ? badResult : 'ok',
    );
    // 无抖动 + 假时钟,退避序列确定:失败 1 次后推迟 1s(=base),2 次后 2s,3 次后 4s…
    const backoff = createReconcileBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      jitter: (d) => d,
      now: () => Date.now(),
    });
    const stop = startRemoteSessionsReconciler(() => eligible, refresh, 1_000, backoff);

    const badCalls = () => refresh.mock.calls.filter(([id]) => id === 'dev-bad').length;
    const goodCalls = () => refresh.mock.calls.filter(([id]) => id === 'dev-good').length;

    // tick1: bad 尝试并失败(退避 1s) → tick2(t=2s)已过退避,再试(失败,退避 2s)
    // → tick3(t=3s)在退避中跳过,tick4(t=4s)再试(失败,退避 4s)→ t=5s/6s/7s 跳过,t=8s 再试
    await vi.advanceTimersByTimeAsync(1_000);
    expect(badCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(badCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(badCalls()).toBe(2); // 退避中
    await vi.advanceTimersByTimeAsync(1_000);
    expect(badCalls()).toBe(3);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(badCalls()).toBe(3); // 退避 4s 中
    await vi.advanceTimersByTimeAsync(1_000);
    expect(badCalls()).toBe(4);

    // good 设备每个 tick 照常对账,不被 bad 的退避拖累
    expect(goodCalls()).toBe(8);

    // bad 恢复:下一次尝试成功后退避复位,恢复逐 tick 对账
    badResult = 'ok';
    await vi.advanceTimersByTimeAsync(8_000);
    const afterRecovery = badCalls();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(badCalls()).toBe(afterRecovery + 2);

    stop();
  });

  it('单次刷新横跨多个 tick 时只发一次、只记账一次(在途合并不重复累计退避)', async () => {
    vi.useFakeTimers();
    const eligible = new Map([['dev-slow', 'Mac Slow']]);
    let settle: ((r: string) => void) | null = null;
    const refresh = vi.fn(
      () => new Promise<string>((resolve) => {
        settle = resolve;
      }),
    );
    const failures: string[] = [];
    const backoff = createReconcileBackoff({ baseMs: 1_000, maxMs: 8_000, jitter: (d) => d });
    const origReport = backoff.report.bind(backoff);
    backoff.report = (deviceId, outcome) => {
      if (outcome === 'failure') failures.push(deviceId);
      origReport(deviceId, outcome);
    };
    const stop = startRemoteSessionsReconciler(() => eligible, refresh, 1_000, backoff);

    // 三个 tick 过去,刷新仍在途:不再重复发起,也没有任何记账
    await vi.advanceTimersByTimeAsync(3_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);

    // 在途请求最终 gave-up:恰好记一次失败
    settle!('gave-up');
    await vi.advanceTimersByTimeAsync(0);
    expect(failures).toEqual(['dev-slow']);
    stop();
  });

  it('抖动结果被 clamp 在 maxMs 内(封顶是硬上限,+15% 不得越过)', () => {
    let at = 0;
    const backoff = createReconcileBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      jitter: (d) => d * 1.15, // 模拟上向抖动
      now: () => at,
    });
    for (let i = 0; i < 10; i++) backoff.report('dev-a', 'failure');
    at = 8_000; // 恰到封顶值:若 jitter 越过 maxMs,这里仍会是退避中
    expect(backoff.shouldAttempt('dev-a')).toBe(true);
    // 负值抖动防御:不会把 nextEligibleAt 推到过去之前(行为上等价于立即可试)
    const negBackoff = createReconcileBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      jitter: () => -5_000,
      now: () => 100,
    });
    negBackoff.report('dev-b', 'failure');
    expect(negBackoff.shouldAttempt('dev-b')).toBe(true);
  });

  it('设备移出合格集后退避账本随之清理,重新合格时从零开始', () => {
    let at = 0;
    const backoff = createReconcileBackoff({
      baseMs: 1_000,
      maxMs: 8_000,
      jitter: (d) => d,
      now: () => at,
    });
    backoff.report('dev-a', 'failure');
    backoff.report('dev-a', 'failure');
    expect(backoff.shouldAttempt('dev-a')).toBe(false);
    backoff.retainOnly(new Set(['dev-b']));
    expect(backoff.shouldAttempt('dev-a')).toBe(true);
    // neutral 不改变账本
    backoff.report('dev-b', 'neutral');
    expect(backoff.shouldAttempt('dev-b')).toBe(true);
    // 封顶:多次失败后延迟不超过 maxMs
    for (let i = 0; i < 10; i++) backoff.report('dev-b', 'failure');
    at = 7_999;
    expect(backoff.shouldAttempt('dev-b')).toBe(false);
    at = 8_000;
    expect(backoff.shouldAttempt('dev-b')).toBe(true);
  });
});

describe('resolveIneligibleRemoteProjectAction', () => {
  it('keeps the cached shard when an eligible device goes offline even if the offline row reports remoteControlEnabled=false', () => {
    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: true,
        hasCachedShard: true,
        isSelf: false,
        online: false,
        remoteControlEnabled: false,
        disabledControl: false,
      }),
    ).toBe('disconnect');
  });

  it('removes an already disconnected cached shard when control is explicitly disabled later', () => {
    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: false,
        hasCachedShard: true,
        isSelf: false,
        online: true,
        remoteControlEnabled: false,
        disabledControl: false,
      }),
    ).toBe('remove');

    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: false,
        hasCachedShard: true,
        isSelf: false,
        online: false,
        remoteControlEnabled: false,
        disabledControl: true,
      }),
    ).toBe('remove');
  });
});
