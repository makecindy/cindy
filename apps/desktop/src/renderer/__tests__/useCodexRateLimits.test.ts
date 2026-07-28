// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import {
  readCodexRateLimitsSafely,
  useCodexRateLimits,
} from '@/hooks/useCodexRateLimits';

const result: MobileCodexRateLimitsResult = {
  account: { email: null, accountId: null, planType: 'plus' },
  rateLimits: {},
  rateLimitsByLimitId: null,
  rateLimitResetCredits: { availableCount: 2, credits: [] },
  resetOffer: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCodexRateLimits', () => {
  it('loads the existing Desktop Codex rate-limit channel when enabled', async () => {
    const getCodexRateLimits = vi.fn().mockResolvedValue(result);
    vi.stubGlobal('electronAPI', {
      maker: { usage: { getCodexRateLimits } },
    });

    const { result: hook } = renderHook(() => useCodexRateLimits(true));

    await waitFor(() => expect(hook.current.snapshot).toBe(result));
    expect(getCodexRateLimits).toHaveBeenCalledTimes(1);
  });

  it('does not read local Codex account data when disabled', () => {
    const getCodexRateLimits = vi.fn().mockResolvedValue(result);
    vi.stubGlobal('electronAPI', {
      maker: { usage: { getCodexRateLimits } },
    });

    const { result: hook } = renderHook(() => useCodexRateLimits(false));

    expect(hook.current.snapshot).toBeNull();
    expect(getCodexRateLimits).not.toHaveBeenCalled();
  });

  it('retries a transient initial failure when the tooltip asks for fresh data', async () => {
    const getCodexRateLimits = vi.fn()
      .mockRejectedValueOnce(new Error('app-server starting'))
      .mockResolvedValueOnce(result);
    vi.stubGlobal('electronAPI', {
      maker: { usage: { getCodexRateLimits } },
    });

    const { result: hook } = renderHook(() => useCodexRateLimits(true));

    await waitFor(() => expect(getCodexRateLimits).toHaveBeenCalledTimes(1));
    expect(hook.current.snapshot).toBeNull();

    act(() => hook.current.refresh());

    await waitFor(() => expect(hook.current.snapshot).toBe(result));
    expect(getCodexRateLimits).toHaveBeenCalledTimes(2);
  });

  it('clears the old account and refetches after a Codex auth change', async () => {
    const nextResult: MobileCodexRateLimitsResult = {
      ...result,
      account: { ...result.account, accountId: 'next-account' },
      rateLimitResetCredits: { availableCount: 1, credits: [] },
    };
    const getCodexRateLimits = vi.fn()
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(nextResult);
    let onStateChanged: ((payload: { agentKind: string }) => void) | undefined;
    vi.stubGlobal('electronAPI', {
      maker: {
        auth: {
          onStateChanged: vi.fn((callback) => {
            onStateChanged = callback;
            return vi.fn();
          }),
        },
        usage: { getCodexRateLimits },
      },
    });

    const { result: hook } = renderHook(() => useCodexRateLimits(true));
    await waitFor(() => expect(hook.current.snapshot).toBe(result));

    act(() => onStateChanged?.({ agentKind: 'codex' }));

    await waitFor(() => expect(hook.current.snapshot).toBe(nextResult));
    expect(getCodexRateLimits).toHaveBeenCalledTimes(2);
  });

  it('degrades to null when the preload API is absent or the read fails', async () => {
    await expect(readCodexRateLimitsSafely(undefined)).resolves.toBeNull();
    await expect(readCodexRateLimitsSafely(
      vi.fn().mockRejectedValue(new Error('app-server unavailable')),
    )).resolves.toBeNull();
  });
});
