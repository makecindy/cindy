/**
 * Regression coverage for renewing short-lived Plugin market icon URLs.
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { earliestPluginIconRefreshAtMs, usePluginIconRefresh } from '../usePluginIconRefresh';

const START_MS = Date.parse('2026-07-25T00:00:00.000Z');

function icon(expiresAtMs: number): { expiresAt: string } {
  return { expiresAt: new Date(expiresAtMs).toISOString() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('earliestPluginIconRefreshAtMs', () => {
  it('renews thirty seconds before the earliest valid icon expiry', () => {
    expect(
      earliestPluginIconRefreshAtMs([
        icon(START_MS + 300_000),
        icon(START_MS + 120_000),
        { expiresAt: 'invalid' },
        null,
      ]),
    ).toBe(START_MS + 90_000);
  });

  it('returns null when no signed icon is visible', () => {
    expect(earliestPluginIconRefreshAtMs([null, undefined])).toBeNull();
  });
});

describe('usePluginIconRefresh', () => {
  it('uses one timer to renew visible icons before expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const refresh = vi.fn().mockResolvedValue(undefined);

    renderHook(() => usePluginIconRefresh([icon(START_MS + 300_000)], refresh));

    await act(async () => {
      vi.advanceTimersByTime(269_999);
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('renews an overdue icon when the renderer becomes visible again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    renderHook(() => usePluginIconRefresh([icon(START_MS + 60_000)], refresh));
    vi.setSystemTime(START_MS + 31_000);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('retries a failed scheduled renewal after a bounded delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    renderHook(() => usePluginIconRefresh([icon(START_MS + 60_000)], refresh));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent image failures and cools down retries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    let finishRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const { result } = renderHook(() => usePluginIconRefresh([], refresh));

    await act(async () => {
      result.current();
      result.current();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRefresh?.();
      await Promise.resolve();
    });
    result.current();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.setSystemTime(START_MS + 30_001);
    await act(async () => {
      result.current();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
