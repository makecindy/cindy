/**
 * toastHoverPause.test.ts
 * ---------------------------------------------------------------------------
 * PR #500 review follow-up：hover 悬停时 toast 不自动消失。
 *
 * 覆盖 lib/toast.ts 的 pauseAutoDismiss / resumeAutoDismiss 语义：
 * - 暂停期间无论过多久都不退出
 * - 恢复后按剩余时长（含 1s 下限兜底）继续计时并正常退出
 * - 永久显示（duration=0）的条目 pause/resume 均为 no-op
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getToastSnapshot, toast } from '../lib/toast';

/** 退出动画时长（与 lib/toast.ts 的 EXIT_ANIMATION_MS 对齐）+ 少量余量 */
const EXIT_MS = 300 + 50;

function isVisible(id: string): boolean {
  return getToastSnapshot().some((t) => t.id === id);
}

describe('toast hover pause/resume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // 清空模块级单例状态，避免用例间串扰
    toast.dismissAll();
    vi.advanceTimersByTime(EXIT_MS);
    vi.useRealTimers();
  });

  it('暂停期间 toast 不会自动退出', () => {
    const id = toast.error('boom', { duration: 8000 });
    vi.advanceTimersByTime(5000);
    toast.pauseAutoDismiss(id);

    vi.advanceTimersByTime(60_000);
    expect(isVisible(id)).toBe(true);
  });

  it('恢复后按剩余时长继续计时并退出', () => {
    const id = toast.error('boom', { duration: 8000 });
    vi.advanceTimersByTime(5000);
    toast.pauseAutoDismiss(id); // 剩余 3000ms
    vi.advanceTimersByTime(10_000);
    toast.resumeAutoDismiss(id);

    // 剩余 3000ms 内仍可见
    vi.advanceTimersByTime(2900);
    expect(isVisible(id)).toBe(true);

    // 越过剩余时长 + 退出动画后被移除
    vi.advanceTimersByTime(200 + EXIT_MS);
    expect(isVisible(id)).toBe(false);
  });

  it('临近到期时暂停，恢复后至少再停留 1s 下限', () => {
    const id = toast.error('boom', { duration: 8000 });
    vi.advanceTimersByTime(7950); // 剩余仅 50ms
    toast.pauseAutoDismiss(id);
    toast.resumeAutoDismiss(id);

    // 不足 1s 下限时仍可见
    vi.advanceTimersByTime(900);
    expect(isVisible(id)).toBe(true);

    vi.advanceTimersByTime(200 + EXIT_MS);
    expect(isVisible(id)).toBe(false);
  });

  // PR #11084: duplicate alerts during hover must refresh the duration without
  // unpausing. Existing tests only covered pause/resume without a duplicate.
  // Minimal input: pause with 1s left, repeat the error, then leave; unit tier.
  it.each(['error', 'warning'] as const)('悬停时重复 %s 保持暂停，移开后重新获得完整时长', variant => {
    const id = toast[variant]('repeat', { duration: 8000 });
    vi.advanceTimersByTime(7000);
    toast.pauseAutoDismiss(id);
    expect(toast[variant]('repeat')).toBe(id);
    vi.advanceTimersByTime(60_000);
    expect(isVisible(id)).toBe(true);
    toast.resumeAutoDismiss(id);
    vi.advanceTimersByTime(7999);
    expect(getToastSnapshot().find(item => item.id === id)?.exiting).toBe(false);
    vi.advanceTimersByTime(1 + EXIT_MS);
    expect(isVisible(id)).toBe(false);
  });

  it('永久显示（duration=0）的条目 pause/resume 为 no-op', () => {
    const id = toast.error('sticky', { duration: 0 });
    toast.pauseAutoDismiss(id);
    toast.resumeAutoDismiss(id);

    vi.advanceTimersByTime(600_000);
    expect(isVisible(id)).toBe(true);
  });
});
