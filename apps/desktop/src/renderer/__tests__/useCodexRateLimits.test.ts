// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

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
  cleanup();
  setDataOwnerGeneration(null);
  vi.unstubAllGlobals();
});

describe('useCodexRateLimits', () => {
  it('shows the last snapshot immediately on remount while refreshing', async () => {
    const reader = vi.fn().mockResolvedValueOnce(result).mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('electronAPI', { maker: { usage: { getCodexRateLimits: reader } } });
    const first = renderHook(() => useCodexRateLimits(true));
    await waitFor(() => expect(first.result.current.snapshot).toBe(result));
    first.unmount();
    const second = renderHook(() => useCodexRateLimits(true));
    expect(second.result.current.snapshot).toBe(result);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('switches A to B to A without showing another connection or clearing cached A', async () => {
    const b = { ...result, providerId: 'openai-b', account: { ...result.account, accountId: 'B' } };
    const reader = vi.fn().mockResolvedValueOnce(result).mockResolvedValueOnce(b)
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('electronAPI', { maker: { usage: { getCodexRateLimits: reader } } });
    const hook = renderHook(({ id }) => useCodexRateLimits(true, id), { initialProps: { id: 'openai' } });
    await waitFor(() => expect(hook.result.current.snapshot).toBe(result));
    hook.rerender({ id: 'openai-b' });
    expect(hook.result.current.snapshot).toBeNull();
    await waitFor(() => expect(hook.result.current.snapshot).toBe(b));
    hook.rerender({ id: 'openai' });
    expect(hook.result.current.snapshot).toBe(result);
  });

  it('retains the snapshot during refresh and transient failures', async () => {
    const reader = vi.fn().mockResolvedValueOnce(result).mockRejectedValue(new Error('offline'));
    vi.stubGlobal('electronAPI', { maker: { usage: { getCodexRateLimits: reader } } });
    const hook = renderHook(() => useCodexRateLimits(true));
    await waitFor(() => expect(hook.result.current.snapshot).toBe(result));
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.snapshot).toBe(result);
  });

  it('clears scoped credentials while unmounted and ignores the old in-flight read', async () => {
    let clear: ((payload: unknown) => void) | undefined;
    let resolveOld!: (value: MobileCodexRateLimitsResult) => void;
    const reader = vi.fn().mockResolvedValueOnce(result)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('electronAPI', { maker: { usage: {
      getCodexRateLimits: reader,
      onCodexAccountChanged: (callback: (payload: unknown) => void) => { clear = callback; return vi.fn(); },
    } } });
    const first = renderHook(() => useCodexRateLimits(true));
    await waitFor(() => expect(first.result.current.snapshot).toBe(result));
    act(() => first.result.current.refresh());
    first.unmount();
    act(() => clear?.(null));
    await act(async () => resolveOld(result));
    const second = renderHook(() => useCodexRateLimits(true));
    expect(second.result.current.snapshot).toBeNull();
  });

  it('refreshes scoped usage pushes without looping on read-generated pushes', async () => {
    const callbacks = new Map<string, (payload: unknown) => void>();
    const b = { ...result, providerId: 'openai-b' };
    const next = { ...b, rateLimitResetCredits: { availableCount: 1, credits: [] } };
    let resolveNext!: (value: MobileCodexRateLimitsResult) => void;
    const reader = vi.fn().mockImplementationOnce(async () => {
      callbacks.get('openai-b')?.({});
      return b;
    }).mockImplementationOnce(() => {
      callbacks.get('openai-b')?.({});
      return new Promise(resolve => { resolveNext = resolve; });
    }).mockResolvedValue(next);
    vi.stubGlobal('electronAPI', { maker: { usage: {
      getCodexRateLimits: reader,
      onCodexAccountChanged: (callback: (payload: unknown) => void, id: string) => {
        callbacks.set(id, callback);
        return () => callbacks.delete(id);
      },
    } } });
    const hook = renderHook(() => useCodexRateLimits(true, 'openai-b'));
    await waitFor(() => expect(hook.result.current.snapshot).toBe(b));
    expect(reader).toHaveBeenCalledTimes(1);
    act(() => callbacks.get('openai')?.({}));
    expect(reader).toHaveBeenCalledTimes(1);
    act(() => callbacks.get('openai-b')?.({}));
    expect(hook.result.current.snapshot).toBe(b);
    act(() => callbacks.get('openai-b')?.({}));
    expect(reader).toHaveBeenCalledTimes(2);
    await act(async () => resolveNext(next));
    expect(hook.result.current.snapshot).toBe(next);
    expect(reader).toHaveBeenCalledTimes(2);
    hook.unmount();
    act(() => callbacks.get('openai-b')?.({}));
    expect(reader).toHaveBeenCalledTimes(2);
    const mounted = renderHook(() => useCodexRateLimits(true, 'openai-b'));
    expect(mounted.result.current.snapshot).toBe(next);
    await act(async () => {});
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it('does not clear independent account quota for a catalog update', async () => {
    const b = { ...result, providerId: 'openai-b' };
    let changed: (() => void) | undefined;
    const reader = vi.fn().mockResolvedValueOnce(b).mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('electronAPI', { maker: {
      usage: { getCodexRateLimits: reader },
      onProvidersChanged: (callback: () => void) => { changed = callback; return vi.fn(); },
    } });
    const hook = renderHook(() => useCodexRateLimits(true, 'openai-b'));
    await waitFor(() => expect(hook.result.current.snapshot).toBe(b));
    act(() => changed?.());
    expect(hook.result.current.snapshot).toBe(b);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('isolates Cindy owner changes and late responses', async () => {
    let resolveOld!: (value: MobileCodexRateLimitsResult) => void;
    const reader = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('electronAPI', { maker: { usage: { getCodexRateLimits: reader } } });
    const hook = renderHook(() => useCodexRateLimits(true));
    act(() => setDataOwnerGeneration('next-owner'));
    hook.rerender();
    await act(async () => resolveOld(result));
    expect(hook.result.current.snapshot).toBeNull();
  });

  it('publishes the latest request to simultaneous consumers and rejects older replies', async () => {
    let resolveOld!: (value: MobileCodexRateLimitsResult) => void;
    const newer = { ...result, account: { ...result.account, accountId: 'new' } };
    const reader = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(newer);
    vi.stubGlobal('electronAPI', { maker: { usage: { getCodexRateLimits: reader } } });
    const first = renderHook(() => useCodexRateLimits(true));
    const second = renderHook(() => useCodexRateLimits(true));
    await waitFor(() => expect(second.result.current.snapshot).toBe(newer));
    expect(first.result.current.snapshot).toBe(newer);
    await act(async () => resolveOld(result));
    expect(first.result.current.snapshot).toBe(newer);
  });


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
