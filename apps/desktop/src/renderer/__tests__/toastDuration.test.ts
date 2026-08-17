/**
 * toastDuration.test.ts
 * ---------------------------------------------------------------------------
 * warning 与 error 共用 8000ms 默认停留：警告常带操作指引，1.2s 读不完。
 * info / success 仍保持 1200ms。显式 duration 覆盖默认。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getToastSnapshot, toast } from '../lib/toast';

/** 退出动画时长（与 lib/toast.ts 的 EXIT_ANIMATION_MS 对齐）+ 少量余量 */
const EXIT_MS = 300 + 50;

function item(id: string) {
  return getToastSnapshot().find((t) => t.id === id);
}

function isVisible(id: string): boolean {
  return getToastSnapshot().some((t) => t.id === id);
}

describe('toast default duration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    toast.dismissAll();
    vi.advanceTimersByTime(EXIT_MS);
    vi.useRealTimers();
  });

  it('info / success 默认 1200ms', () => {
    const infoId = toast.info('i');
    const successId = toast.success('s');
    expect(item(infoId)?.duration).toBe(1200);
    expect(item(successId)?.duration).toBe(1200);
  });

  it('warning / error 默认 8000ms', () => {
    const warningId = toast.warning('w');
    const errorId = toast.error('e');
    expect(item(warningId)?.duration).toBe(8000);
    expect(item(errorId)?.duration).toBe(8000);
  });

  it('warning 在 1200ms 后仍可见，8000ms 后退出', () => {
    const id = toast.warning('switch provider');
    vi.advanceTimersByTime(1200);
    expect(isVisible(id)).toBe(true);
    expect(item(id)?.exiting).toBe(false);

    vi.advanceTimersByTime(6800);
    expect(item(id)?.exiting).toBe(true);

    vi.advanceTimersByTime(EXIT_MS);
    expect(isVisible(id)).toBe(false);
  });

  it('显式 duration 覆盖 warning 默认', () => {
    const id = toast.warning('custom', { duration: 4000 });
    expect(item(id)?.duration).toBe(4000);

    vi.advanceTimersByTime(4000);
    expect(item(id)?.exiting).toBe(true);
  });
});
