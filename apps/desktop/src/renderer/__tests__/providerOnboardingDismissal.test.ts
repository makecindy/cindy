// @vitest-environment jsdom

/**
 * providerOnboardingDismissal — 「连接供应商」引导 dismiss store 关键不变量:
 *   1. dismiss 落 localStorage(ISO 时间戳)且通知订阅方;跨"冷启动"(重读)持久。
 *   2. reset 清 key 并通知;key 本就不存在时不通知(避免无意义重渲染)。
 *   3. unsubscribe 后不再收到通知。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dismissProviderOnboarding,
  isProviderOnboardingDismissed,
  resetProviderOnboardingDismissal,
  subscribeProviderOnboardingDismissal,
} from '@/state/providerOnboardingDismissal';

const KEY = 'providerOnboarding.dismissedAt';

afterEach(() => {
  localStorage.clear();
});

describe('providerOnboardingDismissal store', () => {
  it('dismiss 写入 ISO 时间戳并通知;reset 清 key 并通知', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeProviderOnboardingDismissal(cb);

    expect(isProviderOnboardingDismissed()).toBe(false);

    dismissProviderOnboarding();
    expect(isProviderOnboardingDismissed()).toBe(true);
    const stored = localStorage.getItem(KEY);
    expect(stored).not.toBeNull();
    expect(Number.isNaN(Date.parse(stored!))).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);

    resetProviderOnboardingDismissal();
    expect(isProviderOnboardingDismissed()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(cb).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('key 不存在时 reset 不通知(no-op)', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeProviderOnboardingDismissal(cb);

    resetProviderOnboardingDismissal();
    expect(cb).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('unsubscribe 后不再收到通知', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeProviderOnboardingDismissal(cb);
    unsubscribe();

    dismissProviderOnboarding();
    expect(cb).not.toHaveBeenCalled();
  });
});
