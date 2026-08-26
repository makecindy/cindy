/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProviderAccountUsageRequest,
  ProviderAccountUsageResult,
} from '../../../shared/providerAccountUsage';

import { useProviderAccountUsage } from '../useProviderAccountUsage';

const firstSnapshot: ProviderAccountUsageResult = {
  status: 'ready',
  stale: false,
  snapshot: {
    kind: 'openrouter-key-usage',
    fetchedAt: 1,
    limit: 10,
    limitRemaining: 8,
    limitReset: 'monthly',
    usage: 2,
    usageDaily: 1,
    usageWeekly: 2,
    usageMonthly: 2,
  },
};

const secondSnapshot: ProviderAccountUsageResult = {
  status: 'ready',
  stale: false,
  snapshot: {
    kind: 'openrouter-key-usage',
    fetchedAt: 2,
    limit: 20,
    limitRemaining: 15,
    limitReset: 'monthly',
    usage: 5,
    usageDaily: 2,
    usageWeekly: 4,
    usageMonthly: 5,
  },
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve,
  };
}

describe('useProviderAccountUsage', () => {
  const getProviderAccountUsage = vi.fn<
    (input: ProviderAccountUsageRequest) => Promise<ProviderAccountUsageResult>
  >();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { maker: { getProviderAccountUsage } },
    });
  });

  it('keeps the previous snapshot visible during a manual refresh', async () => {
    const pendingRefresh = deferred<ProviderAccountUsageResult>();
    getProviderAccountUsage
      .mockResolvedValueOnce(firstSnapshot)
      .mockReturnValueOnce(pendingRefresh.promise);
    const { result } = renderHook(() =>
      useProviderAccountUsage('openrouter', ['codex'], null),
    );

    await waitFor(() => expect(result.current.states.codex?.result).toBe(firstSnapshot));

    act(() => result.current.refresh('codex'));
    expect(result.current.states.codex).toEqual({
      result: firstSnapshot,
      refreshing: true,
    });

    await act(async () => pendingRefresh.resolve(secondSnapshot));
    expect(result.current.states.codex).toEqual({
      result: secondSnapshot,
      refreshing: false,
    });
  });

  it('ignores a late response after switching providers', async () => {
    const first = deferred<ProviderAccountUsageResult>();
    const second = deferred<ProviderAccountUsageResult>();
    getProviderAccountUsage.mockImplementation((input) =>
      input.providerId === 'first' ? first.promise : second.promise,
    );
    const hook = renderHook(
      ({ providerId }) => useProviderAccountUsage(providerId, ['codex'], null),
      { initialProps: { providerId: 'first' } },
    );
    await waitFor(() => expect(getProviderAccountUsage).toHaveBeenCalledTimes(1));

    hook.rerender({ providerId: 'second' });
    await waitFor(() => expect(getProviderAccountUsage).toHaveBeenCalledTimes(2));
    expect(hook.result.current.states.codex?.result).toBeNull();

    await act(async () => first.resolve(firstSnapshot));
    expect(hook.result.current.states.codex?.result).toBeNull();

    await act(async () => second.resolve(secondSnapshot));
    expect(hook.result.current.states.codex?.result).toBe(secondSnapshot);
  });

  it('hides the previous snapshot immediately after the provider catalog identity changes', async () => {
    const pendingRefresh = deferred<ProviderAccountUsageResult>();
    getProviderAccountUsage
      .mockResolvedValueOnce(firstSnapshot)
      .mockReturnValueOnce(pendingRefresh.promise);
    const hook = renderHook(
      ({ revision }) => useProviderAccountUsage('openrouter', ['codex'], revision),
      { initialProps: { revision: {} } },
    );
    await waitFor(() => expect(hook.result.current.states.codex?.result).toBe(firstSnapshot));

    hook.rerender({ revision: {} });
    await waitFor(() => expect(getProviderAccountUsage).toHaveBeenCalledTimes(2));
    expect(hook.result.current.states.codex).toEqual({
      result: null,
      refreshing: true,
    });

    await act(async () => pendingRefresh.resolve(secondSnapshot));
    expect(hook.result.current.states.codex?.result).toBe(secondSnapshot);
  });
});
