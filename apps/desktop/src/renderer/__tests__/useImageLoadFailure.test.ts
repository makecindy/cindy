// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useImageLoadFailure } from '../components/chat/useImageLoadFailure';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['INTERNAL', 'PERMISSION_DENIED', 'INVALID_PARAMS'])(
  'does not label %s as a deleted image',
  async (code) => {
    const read = vi.fn().mockRejectedValue(new Error(`[${code}] Cannot read image`));
    vi.stubGlobal('electronAPI', { readCachedImageAsBase64: read });
    const { result } = renderHook(() => useImageLoadFailure('xdt-image:///tmp/bad.png'));
    act(() => result.current.onError());
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('unavailable');
  },
);

it.each(['cindy-media://blobs/a.png', 'xdt-image://images/a.png'])(
  'uses the preload reader to confirm missing bytes for %s without CORS fetch',
  async (src) => {
    const read = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'image-cache:read-base64': Error: [NOT_FOUND] Image file not found",
        ),
      );
    vi.stubGlobal('electronAPI', { readCachedImageAsBase64: read });
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useImageLoadFailure(src));
    act(() => result.current.onError());
    await waitFor(() => expect(result.current.status).toBe('missing'));
    expect(read).toHaveBeenCalledWith({ url: src });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('keeps existing bytes with decode errors unavailable', async () => {
  vi.stubGlobal('electronAPI', {
    readCachedImageAsBase64: vi.fn().mockResolvedValue({ base64: 'bad', mimeType: 'image/png' }),
  });
  const { result } = renderHook(() => useImageLoadFailure('cindy-media://blobs/a.png'));
  act(() => result.current.onError());
  await act(async () => {});
  expect(result.current.status).toBe('unavailable');
});

it('discards late diagnostics after a repaired source replaces the bad link', async () => {
  let reject!: (value: unknown) => void;
  vi.stubGlobal('electronAPI', {
    readCachedImageAsBase64: vi.fn(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    ),
  });
  const { result, rerender } = renderHook(({ src }) => useImageLoadFailure(src), {
    initialProps: { src: 'xdt-image:///tmp/a.png' },
  });
  act(() => result.current.onError());
  rerender({ src: 'cindy-media://blobs/saved.png' });
  await act(async () => {
    reject(new Error('[NOT_FOUND] Image file not found'));
  });
  expect(result.current.status).toBeNull();
});

it.each(['focus', 'online'])(
  'keeps remote images unavailable and retries on %s without polling',
  (event) => {
    const read = vi.fn();
    vi.stubGlobal('electronAPI', { readCachedImageAsBase64: read });
    const { result, rerender } = renderHook(
      ({ streaming }) => useImageLoadFailure('cindy-remote-media://transfer', streaming),
      {
        initialProps: { streaming: true },
      },
    );
    act(() => result.current.onError());
    expect(result.current.status).toBe('loading');
    expect(read).not.toHaveBeenCalled();
    rerender({ streaming: false });
    expect(result.current.status).toBe('unavailable');
    expect(read).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event(event)));
    expect(result.current.status).toBeNull();
  },
);
