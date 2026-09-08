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

  it('keeps the previous snapshot while re-requesting after a catalog revision change', async () => {
    const pendingRefresh = deferred<ProviderAccountUsageResult>();
    getProviderAccountUsage
      .mockResolvedValueOnce(firstSnapshot)
      .mockReturnValueOnce(pendingRefresh.promise);
    const hook = renderHook(
      ({ revision }) => useProviderAccountUsage('openrouter', ['codex'], revision),
      { initialProps: { revision: 'openrouter:1:codex=openrouter-key-usage-v1' } },
    );
    await waitFor(() => expect(hook.result.current.states.codex?.result).toBe(firstSnapshot));

    // 同一 providerId 下换 revision（如目录刷新）只触发重新请求，已显示的余额保留、
    // 只置 refreshing——对齐手动 refresh 的行为（PR #3472 review）。
    hook.rerender({ revision: 'openrouter:0:codex=openrouter-key-usage-v1' });
    await waitFor(() => expect(getProviderAccountUsage).toHaveBeenCalledTimes(2));
    expect(hook.result.current.states.codex).toEqual({
      result: firstSnapshot,
      refreshing: true,
    });

    await act(async () => pendingRefresh.resolve(secondSnapshot));
    expect(hook.result.current.states.codex).toEqual({
      result: secondSnapshot,
      refreshing: false,
    });
  });

  it('clears the snapshot when the agents set changes', async () => {
    getProviderAccountUsage.mockResolvedValue(firstSnapshot);
    const hook = renderHook(
      ({ agents }) =>
        useProviderAccountUsage('openrouter', agents, 'openrouter:1:codex=openrouter-key-usage-v1'),
      { initialProps: { agents: ['codex'] as ('codex' | 'pi')[] } },
    );
    await waitFor(() => expect(hook.result.current.states.codex?.result).toBe(firstSnapshot));

    hook.rerender({ agents: ['codex', 'pi'] });
    expect(hook.result.current.states.codex?.result).toBeNull();
    expect(hook.result.current.states.pi?.result).toBeNull();
    await waitFor(() => expect(hook.result.current.states.pi?.result).toBe(firstSnapshot));
  });
});
