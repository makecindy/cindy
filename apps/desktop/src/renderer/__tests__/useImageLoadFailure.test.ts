// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useImageLoadFailure } from '../components/chat/useImageLoadFailure';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([403, 500, 200])('does not label HTTP %s as a deleted image', async (status) => {
  const fetch = vi.fn(async () => ({ status, body: null }));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useImageLoadFailure('xdt-image:///tmp/bad.png'));
  act(() => result.current.onError());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(result.current.status).toBe('unavailable');
});

it('labels only a confirmed local 404 as missing', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ status: 404, body: null })),
  );
  const { result } = renderHook(() => useImageLoadFailure('cindy-media://blobs/a.png'));
  act(() => result.current.onError());
  await waitFor(() => expect(result.current.status).toBe('missing'));
});

it('discards late diagnostics after a repaired source replaces the bad link', async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  );
  const { result, rerender } = renderHook(({ src }) => useImageLoadFailure(src), {
    initialProps: { src: 'xdt-image:///tmp/a.png' },
  });
  act(() => result.current.onError());
  rerender({ src: 'cindy-media://blobs/saved.png' });
  await act(async () => {
    resolve({ status: 404, body: null });
  });
  expect(result.current.status).toBeNull();
});

it('keeps incomplete streaming images loading and retries on focus without polling', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { result, rerender } = renderHook(
    ({ streaming }) => useImageLoadFailure('cindy-remote-media://transfer', streaming),
    {
      initialProps: { streaming: true },
    },
  );
  act(() => result.current.onError());
  expect(result.current.status).toBe('loading');
  expect(fetch).not.toHaveBeenCalled();
  rerender({ streaming: false });
  expect(result.current.status).toBe('unavailable');
  act(() => window.dispatchEvent(new Event('focus')));
  expect(result.current.status).toBeNull();
});
