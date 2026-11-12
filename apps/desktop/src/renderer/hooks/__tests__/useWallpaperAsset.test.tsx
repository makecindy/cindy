// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWallpaperAsset } from '../useWallpaperAsset';
import { type WallpaperId, type WallpaperDownloadProgress } from '@/../shared/appearanceSettings';
import manifest from '@/../shared/wallpaper-video-manifest.json';

const image = vi.fn();
const video = vi.fn();
const decode = vi.fn();
const progressListeners = new Set<(progress: WallpaperDownloadProgress) => void>();
const emit = (progress: WallpaperDownloadProgress) => {
  for (const listener of progressListeners) listener(progress);
};
beforeEach(() => {
  progressListeners.clear();
  image.mockReset().mockResolvedValue('cindy-media://client-wallpaper/image.webp');
  video.mockReset().mockResolvedValue('cindy-media://client-wallpaper/video.mp4');
  decode.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', {
    appearanceSettings: {
      ensureWallpaperImage: image,
      ensureWallpaperVideo: video,
      onWallpaperDownloadProgress: (callback: (progress: WallpaperDownloadProgress) => void) => {
        progressListeners.add(callback);
        return () => progressListeners.delete(callback);
      },
    },
  });
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decode = decode;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('on-demand wallpaper assets', () => {
  // Regression: A -> B -> A used to discard A's ready original and briefly
  // expose its thumbnail and loading feedback again, even with a warm cache.
  it('returns an already decoded original immediately when switching back', async () => {
    image.mockImplementation(async (id: string) => `cindy-media://client-wallpaper/${id}.webp`);
    const { result, rerender } = renderHook(
      ({ id }: { id: WallpaperId }) => useWallpaperAsset(id, 'image', true),
      { initialProps: { id: 'night-launch' as WallpaperId } },
    );
    await waitFor(() => expect(result.current.url).toContain('night-launch.webp'));
    rerender({ id: 'dune-dawn' });
    await waitFor(() => expect(result.current.url).toContain('dune-dawn.webp'));
    rerender({ id: 'night-launch' });
    expect(result.current.url).toBe('cindy-media://client-wallpaper/night-launch.webp');
    expect(result.current.loading).toBe(false);
    expect(image).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('tracks only the selected asset bytes, accepts retry resets and unsubscribes after completion', async () => {
    let finish!: (url: string) => void;
    image.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const total = manifest['cindy-window'].image.bytes;
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useWallpaperAsset('cindy-window', 'image', enabled),
      { initialProps: { enabled: true } },
    );
    const progress = {
      wallpaperId: 'cindy-window' as const,
      kind: 'image' as const,
      loaded: total / 2,
      total,
    };
    act(() => {
      emit({ ...progress, wallpaperId: 'cindy-dream' });
      emit({ ...progress, kind: 'video' });
      emit({ ...progress, total: 123 });
      emit({ ...progress, loaded: Number.NaN });
    });
    expect(result.current.loaded).toBe(0);
    act(() => emit(progress));
    expect(result.current.loaded).toBe(total / 2);
    expect(result.current.total).toBe(total);
    act(() => emit({ ...progress, loaded: 0 }));
    expect(result.current.loaded).toBe(0);
    await act(async () => finish('cindy-media://client-wallpaper/image.webp'));
    expect(result.current.loaded).toBe(total);
    expect(progressListeners.size).toBe(0);
    rerender({ enabled: false });
    expect(result.current.total).toBe(0);
    expect(result.current.loaded).toBe(0);
    unmount();
    expect(progressListeners.size).toBe(0);
  });
  // User request 2026-10-17: selecting a still now downloads its image, while
  // inactive images and still-only videos stay idle. Existing scene-only tests
  // missed that distinction. Minimal input: one selected static ID; unit tier.
  it('downloads only selected and visible media and never requests a still-only video', async () => {
    const { rerender } = renderHook(
      ({ id, enabled }: { id: WallpaperId; enabled: boolean }) => {
        useWallpaperAsset(id, 'image', enabled);
        return useWallpaperAsset(id, 'video', enabled);
      },
      { initialProps: { id: 'none' as WallpaperId, enabled: false } },
    );
    rerender({ id: 'custom', enabled: true });
    rerender({ id: 'dune-dawn', enabled: false });
    expect(image).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();
    rerender({ id: 'dune-dawn', enabled: true });
    await waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(image).toHaveBeenCalledWith('dune-dawn');
    expect(video).not.toHaveBeenCalled();
    rerender({ id: 'cindy-window', enabled: true });
    await waitFor(() => expect(video).toHaveBeenCalledOnce());
  });
  it('downloads video even in a small window and reuses the resolved source when toggled', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useWallpaperAsset('cindy-window', 'video', enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.url).toContain('video.mp4'));
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(video).toHaveBeenCalledOnce();
  });
  it('never displays a late result belonging to another selection', async () => {
    let finish!: (url: string) => void;
    image.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: WallpaperId }) => useWallpaperAsset(id, 'image', true),
      { initialProps: { id: 'cindy-window' as WallpaperId } },
    );
    rerender({ id: 'cindy-dream' });
    await waitFor(() => expect(result.current.url).toContain('image.webp'));
    await act(async () => finish('cindy-media://client-wallpaper/old.webp'));
    expect(result.current.url).toContain('image.webp');
  });
  it('keeps the preview until an image has decoded and permits retry after a decode failure', async () => {
    decode.mockRejectedValueOnce(new Error('decode'));
    const { result } = renderHook(() => useWallpaperAsset('cindy-window', 'image', true));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.url).toBeNull();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.url).toContain('image.webp'));
    expect(result.current.failed).toBe(false);
  });
  it('retries after network recovery, caps automatic attempts and keeps manual retry available', async () => {
    vi.useFakeTimers();
    video.mockResolvedValue(null);
    const { result } = renderHook(() => useWallpaperAsset('cindy-window', 'video', true));
    await act(async () => {});
    expect(result.current.failed).toBe(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(video).toHaveBeenCalledTimes(3);
    video.mockResolvedValue('cindy-media://client-wallpaper/video.mp4');
    await act(async () => result.current.retry());
    expect(video).toHaveBeenCalledTimes(4);
    expect(result.current.url).toContain('video.mp4');
  });
  it('stops automatic retries when the user disables the wallpaper', async () => {
    vi.useFakeTimers();
    video.mockResolvedValue(null);
    const { result, rerender } = renderHook(
      ({ enabled }) => useWallpaperAsset('cindy-window', 'video', enabled),
      { initialProps: { enabled: true } },
    );
    await act(async () => {});
    rerender({ enabled: false });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(video).toHaveBeenCalledOnce();
    expect(result.current.failed).toBe(false);
  });
});
