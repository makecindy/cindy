// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
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

    await waitFor(() => expect(hook.current).toBe(result));
    expect(getCodexRateLimits).toHaveBeenCalledTimes(1);
  });

  it('does not read local Codex account data when disabled', () => {
    const getCodexRateLimits = vi.fn().mockResolvedValue(result);
    vi.stubGlobal('electronAPI', {
      maker: { usage: { getCodexRateLimits } },
    });

    const { result: hook } = renderHook(() => useCodexRateLimits(false));

    expect(hook.current).toBeNull();
    expect(getCodexRateLimits).not.toHaveBeenCalled();
  });

  it('degrades to null when the preload API is absent or the read fails', async () => {
    await expect(readCodexRateLimitsSafely(undefined)).resolves.toBeNull();
    await expect(readCodexRateLimitsSafely(
      vi.fn().mockRejectedValue(new Error('app-server unavailable')),
    )).resolves.toBeNull();
  });
});
