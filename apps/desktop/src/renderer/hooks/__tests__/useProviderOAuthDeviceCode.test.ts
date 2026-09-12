// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProviderOAuthDeviceCode } from '../useProviderOAuthDeviceCode';

describe('useProviderOAuthDeviceCode', () => {
  const unsubscribe = vi.fn();
  const cancel = vi.fn(async () => ({ ok: true as const }));
  let listener: ((progress: {
    providerId: string;
    phase: 'device-code';
    verificationUrl: string;
    userCode: string;
    expiresAt?: number;
  } | {
    providerId: string;
    ownerId: string;
    phase: 'browser-url';
    url: string | null;
  }) => void) | null = null;

  beforeEach(() => {
    unsubscribe.mockReset();
    cancel.mockReset();
    cancel.mockResolvedValue({ ok: true });
    listener = null;
    Object.assign(window, {
      electronAPI: {
        maker: {
          providerOAuthCancel: cancel,
          onProviderOAuthProgress: vi.fn((next) => {
            listener = next;
            return unsubscribe;
          }),
        },
      },
    });
  });

  it('keeps only matching progress in memory', () => {
    const { result } = renderHook(() => useProviderOAuthDeviceCode('provider-a'));

    act(() => {
      listener?.({
        providerId: 'provider-b',
        phase: 'device-code',
        verificationUrl: 'https://example.com/b',
        userCode: 'BBBB',
      });
      listener?.({
        providerId: 'provider-a',
        phase: 'device-code',
        verificationUrl: 'https://example.com/a',
        userCode: 'AAAA',
        expiresAt: 123,
      });
    });

    expect(result.current.deviceCode).toEqual({
      verificationUrl: 'https://example.com/a',
      userCode: 'AAAA',
      expiresAt: 123,
    });
  });
  it('keeps browser links only for the active owner and clears on cancel, finish and provider switch', () => {
    const { result, rerender } = renderHook(({ id }) => useProviderOAuthDeviceCode(id), {
      initialProps: { id: 'provider-a' },
    });
    let first!: ReturnType<typeof result.current.beginOwnedLogin>;
    act(() => { first = result.current.beginOwnedLogin(); });
    const progress = (ownerId = first.ownerId!, url: string | null = 'https://auth.openai.com/authorize?fake=1') =>
      listener?.({ providerId: 'provider-a', ownerId, phase: 'browser-url', url });
    act(() => progress('unrelated'));
    expect(result.current.browserUrl).toBeNull();
    act(() => progress());
    expect(result.current.browserUrl).toContain('fake=1');
    act(() => result.current.cancelOwnedLogin());
    expect(result.current.browserUrl).toBeNull();
    let next!: typeof first;
    act(() => { next = result.current.beginOwnedLogin(); progress(next.ownerId); });
    act(() => { progress(); first.finish(); });
    expect(result.current.browserUrl).toContain('fake=1');
    act(() => next.finish());
    expect(result.current.browserUrl).toBeNull();
    act(() => progress(next.ownerId));
    expect(result.current.browserUrl).toBeNull();
    act(() => { next = result.current.beginOwnedLogin(); progress(next.ownerId); });
    rerender({ id: 'provider-b' });
    expect(result.current.browserUrl).toBeNull();
  });

  it('unsubscribes without cancelling a login observed from another view', () => {
    const { rerender, unmount } = renderHook(
      ({ providerId }) => useProviderOAuthDeviceCode(providerId),
      { initialProps: { providerId: 'provider-a' as string | null } },
    );

    rerender({ providerId: 'provider-b' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels only a login started by this hook when its provider is switched', () => {
    const { result, rerender, unmount } = renderHook(
      ({ providerId }) => useProviderOAuthDeviceCode(providerId),
      { initialProps: { providerId: 'provider-a' as string | null } },
    );

    const owned = result.current.beginOwnedLogin();
    rerender({ providerId: 'provider-b' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('provider-a', {
      releaseOwner: true,
      ownerId: owned.ownerId,
    });

    const nextOwned = result.current.beginOwnedLogin();
    nextOwned.finish();
    unmount();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('owns and cancels authorization-code login without subscribing to device progress', () => {
    const onProgress = window.electronAPI.maker.onProviderOAuthProgress as ReturnType<typeof vi.fn>;
    const { result, unmount } = renderHook(() =>
      useProviderOAuthDeviceCode('provider-a', { observeProgress: false }),
    );

    expect(onProgress).not.toHaveBeenCalled();
    const owned = result.current.beginOwnedLogin();
    unmount();

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('provider-a', {
      releaseOwner: true,
      ownerId: owned.ownerId,
    });
  });

  it('ignores a synchronous cancellation failure during cleanup', async () => {
    cancel.mockImplementationOnce(() => {
      throw new Error('sync cancellation failure');
    });
    const { result, unmount } = renderHook(() => useProviderOAuthDeviceCode('provider-a'));

    const owned = result.current.beginOwnedLogin();
    expect(() => unmount()).not.toThrow();
    await act(async () => {
      await Promise.resolve();
    });

    expect(cancel).toHaveBeenCalledWith('provider-a', {
      releaseOwner: true,
      ownerId: owned.ownerId,
    });
  });
});
