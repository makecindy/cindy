// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resendRemainingSeconds, useResendCountdown } from '../useResendCountdown';

/**
 * Step 3a 倒计时契约 fake timers 用例(implementation-plan v6.19 逐条):
 * 60→0 全程、59999/1000/1/0ms 边界、重发成功重置、重发失败保持、离开清理、
 * 挂起恢复校正。绝对 deadline 模型:tick 只重算,不递减计数。
 */

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resendRemainingSeconds 显示数学(v5 冻结:max(0, ceil((deadline-now)/1000)))', () => {
  it('59999/1000/1/0ms 边界', () => {
    const deadline = T0 + 60_000;
    expect(resendRemainingSeconds(deadline, deadline - 59_999)).toBe(60);
    expect(resendRemainingSeconds(deadline, deadline - 1_000)).toBe(1);
    expect(resendRemainingSeconds(deadline, deadline - 1)).toBe(1);
    expect(resendRemainingSeconds(deadline, deadline)).toBe(0);
    // 过期后恒 0(不出现负数)
    expect(resendRemainingSeconds(deadline, deadline + 5_000)).toBe(0);
  });
});

describe('useResendCountdown(Step 3a 绝对 deadline 契约)', () => {
  it('arm 后首帧显示 60,60→0 全程逐秒重算,到 0 切链接态', () => {
    const { result } = renderHook(() => useResendCountdown(true));
    act(() => result.current.arm());
    expect(result.current.remaining).toBe(60); // 首帧 60

    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.remaining).toBe(59);
    act(() => vi.advanceTimersByTime(58_000));
    expect(result.current.remaining).toBe(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.remaining).toBe(0); // deadline<=now → 同步切「重新发送」
    // 到 0 后不再变化(interval 自停)
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.remaining).toBe(0);
  });

  it('重发成功重置:计数中途再次 arm → deadline 重置回 60', () => {
    const { result } = renderHook(() => useResendCountdown(true));
    act(() => result.current.arm());
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.remaining).toBe(50);
    act(() => result.current.arm()); // 重发成功 → 重置
    expect(result.current.remaining).toBe(60);
  });

  it('重发失败保持:不 arm 则沿当前 deadline 继续倒数', () => {
    const { result } = renderHook(() => useResendCountdown(true));
    act(() => result.current.arm());
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current.remaining).toBe(55);
    // 重发失败 = 调用方不 arm(无任何操作),下一 tick 仍按原 deadline
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.remaining).toBe(54);
  });

  it('离开 verification-code 清理 state:active 退出后归零,重进不残留旧 deadline', () => {
    const { result, rerender } = renderHook(({ active }) => useResendCountdown(active), {
      initialProps: { active: true },
    });
    act(() => result.current.arm());
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.remaining).toBe(58);

    rerender({ active: false }); // 离开(back/reset)
    expect(result.current.remaining).toBe(0);
    rerender({ active: true }); // 重进(未重新 request-code)
    expect(result.current.remaining).toBe(0);
  });

  it('挂起恢复自校正:系统时间跳跃后单个 tick 直接对齐真实剩余(非递减计数)', () => {
    const { result } = renderHook(() => useResendCountdown(true));
    act(() => result.current.arm());
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.remaining).toBe(58);

    // 模拟休眠 30s:时钟前跳但期间无 tick,恢复后第一个 tick 以 Date.now 重算
    act(() => vi.setSystemTime(T0 + 2_000 + 30_000));
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.remaining).toBe(resendRemainingSeconds(T0 + 60_000, T0 + 33_000));
    expect(result.current.remaining).toBe(27);
  });

  it('arm 先于 step 切换到 verification-code 的时序:deadline 不被入场沿清掉', () => {
    // 现实时序:identifier 提交 request-code 成功(arm)→ loginState 才切到
    // verification-code(active false→true);清理只发生在 true→false 沿。
    const { result, rerender } = renderHook(({ active }) => useResendCountdown(active), {
      initialProps: { active: false },
    });
    act(() => result.current.arm());
    rerender({ active: true });
    expect(result.current.remaining).toBe(60);
  });
});
