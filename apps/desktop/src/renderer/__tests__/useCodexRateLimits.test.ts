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

  it('handles account-scoped auth-ready after late old pushes and reads', async () => {
    const a = { ...result, providerId: 'openai-a' };
    const refreshedA = { ...result, providerId: 'openai-a', primary: { usedPercent: 18, resetsAt: 'later' } };
    const b = { ...result, providerId: 'openai-b' };
    const refreshedB = { ...b, primary: { usedPercent: 27, resetsAt: 'later' } };
    const accountChanges = new Map<string, (payload: unknown) => void>();
    const authStarted = new Map<string, () => void>();
    const authReady = new Map<string, () => void>();
    const catalogChanges: Array<() => void> = [];
    let resolveOldRead!: (value: MobileCodexRateLimitsResult) => void;
    const reader = vi.fn()
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldRead = resolve; }))
      .mockResolvedValueOnce(refreshedB)
      .mockResolvedValueOnce(refreshedA)
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('electronAPI', { maker: {
      usage: {
        getCodexRateLimits: reader,
        onCodexAccountChanged: (callback: (payload: unknown) => void, providerId: string) => {
          accountChanges.set(providerId, callback);
          return () => accountChanges.delete(providerId);
        },
        onCodexAccountAuthStarted: (callback: () => void, providerId: string) => {
          authStarted.set(providerId, callback);
          return () => authStarted.delete(providerId);
        },
        onCodexAccountAuthReady: (callback: () => void, providerId: string) => {
          authReady.set(providerId, callback);
          return () => authReady.delete(providerId);
        },
      },
      onProvidersChanged: (callback: () => void) => { catalogChanges.push(callback); return vi.fn(); },
    } });
    const accountA = renderHook(() => useCodexRateLimits(true, 'openai-a'));
    const accountB = renderHook(() => useCodexRateLimits(true, 'openai-b'));
    await waitFor(() => {
      expect(accountA.result.current.snapshot).toBe(a);
      expect(accountB.result.current.snapshot).toBe(b);
    });

    // Catalog edits do not refresh either connected account.
    act(() => catalogChanges.forEach(changed => changed()));
    expect(reader).toHaveBeenCalledTimes(2);

    // A read started with the old credentials remains in flight when re-login retires them.
    act(() => accountA.result.current.refresh());
    expect(reader).toHaveBeenCalledTimes(3);
    act(() => authStarted.get('openai-a')?.());
    act(() => accountChanges.get('openai-a')?.(null));
    expect(accountA.result.current.snapshot).toBeNull();

    // Both an old usage push and a hover-triggered read can arrive before auth.json is replaced.
    act(() => accountChanges.get('openai-a')?.(a));
    act(() => accountA.result.current.refresh());
    expect(reader).toHaveBeenCalledTimes(3);
    act(() => catalogChanges.forEach(changed => changed()));
    expect(reader).toHaveBeenCalledTimes(3);

    // B's provider-scoped ready is valid even though this renderer did not see its start.
    act(() => authReady.get('openai-b')?.());
    await waitFor(() => expect(accountB.result.current.snapshot).toBe(refreshedB));
    expect(reader).toHaveBeenCalledTimes(4);
    expect(accountA.result.current.snapshot).toBeNull();

    // A's ready signal releases A's wait and refreshes only A.
    act(() => authReady.get('openai-a')?.());
    expect(reader).toHaveBeenCalledTimes(5);
    await waitFor(() => expect(accountA.result.current.snapshot).toBe(refreshedA));
    expect(accountB.result.current.snapshot).toBe(refreshedB);

    // A stale pre-login response cannot overwrite the refreshed quota.
    await act(async () => resolveOldRead(a));
    expect(accountA.result.current.snapshot).toBe(refreshedA);
    expect(accountB.result.current.snapshot).toBe(refreshedB);
  });

  it('ignores a replacement identity quota read that finishes after login rollback', async () => {
    const original = { ...result, providerId: 'openai-a', account: { ...result.account, accountId: 'original' } };
    const replacement = { ...original, account: { ...result.account, accountId: 'replacement' } };
    let authStarted: (() => void) | undefined;
    let authReady: (() => void) | undefined;
    let resolveReplacement!: (value: MobileCodexRateLimitsResult) => void;
    const reader = vi.fn().mockResolvedValueOnce(original)
      .mockImplementationOnce(() => new Promise(resolve => { resolveReplacement = resolve; }))
      .mockResolvedValueOnce(original);
    vi.stubGlobal('electronAPI', { maker: { usage: {
      getCodexRateLimits: reader,
      onCodexAccountAuthStarted: (callback: () => void) => { authStarted = callback; return vi.fn(); },
      onCodexAccountAuthReady: (callback: () => void) => { authReady = callback; return vi.fn(); },
    } } });
    const hook = renderHook(() => useCodexRateLimits(true, 'openai-a'));
    await waitFor(() => expect(hook.result.current.snapshot).toBe(original));
    act(() => { authStarted?.(); authReady?.(); });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(hook.result.current.snapshot).toBeNull();

    // Capability commit failed: rollback publishes start/ready after restoring credentials.
    act(() => { authStarted?.(); authReady?.(); });
    await waitFor(() => expect(hook.result.current.snapshot).toBe(original));
    expect(reader).toHaveBeenCalledTimes(3);
    await act(async () => resolveReplacement(replacement));
    expect(hook.result.current.snapshot).toBe(original);
  });

  it('does not treat an unrelated scoped clear as a credential replacement', async () => {
    const accountChanges = new Map<string, (payload: unknown) => void>();
    const accountA = { ...result, providerId: 'openai-a' };
    const resultAfterClear = { ...accountA, rateLimitResetCredits: { availableCount: 1, credits: [] } };
    const reader = vi.fn().mockResolvedValueOnce(accountA).mockResolvedValueOnce(resultAfterClear);
    vi.stubGlobal('electronAPI', { maker: { usage: {
      getCodexRateLimits: reader,
      onCodexAccountChanged: (callback: (payload: unknown) => void, providerId: string) => {
        accountChanges.set(providerId, callback);
        return () => accountChanges.delete(providerId);
      },
    } } });
    const hook = renderHook(() => useCodexRateLimits(true, 'openai-a'));
    await waitFor(() => expect(hook.result.current.snapshot).toBe(accountA));
    act(() => accountChanges.get('openai-a')?.(null));
    expect(hook.result.current.snapshot).toBeNull();
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.snapshot).toBe(resultAfterClear));
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('refreshes on scoped auth-ready even if the renderer missed auth-start', async () => {
    const providerId = 'openai-a';
    const before = { ...result, providerId, account: { ...result.account, accountId: 'old' } };
    const after = { ...result, providerId, account: { ...result.account, accountId: 'new' } };
    let authReady: (() => void) | undefined;
    const reader = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    vi.stubGlobal('electronAPI', { maker: { usage: {
      getCodexRateLimits: reader,
      onCodexAccountAuthReady: (callback: () => void, id: string) => {
        if (id === providerId) authReady = callback;
        return () => { authReady = undefined; };
      },
    } } });
    const hook = renderHook(() => useCodexRateLimits(true, providerId));
    await waitFor(() => expect(hook.result.current.snapshot).toBe(before));
    act(() => authReady?.());
    await waitFor(() => expect(hook.result.current.snapshot).toBe(after));
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
