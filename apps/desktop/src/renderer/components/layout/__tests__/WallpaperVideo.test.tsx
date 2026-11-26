// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperVideo } from '../WallpaperVideo';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';
import { parse } from 'postcss';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '@/styles/globals.css';

const state = vi.hoisted(() => ({ reduced: false }));
const ensureVideo = vi.fn();
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => state.reduced }));
vi.mock('@/lib/wallpaper', () => ({ isSceneWallpaper: (id: string) => id.startsWith('cindy-') }));

describe('dynamic wallpaper lifecycle', () => {
  it('keeps visibility on the frame over an opaque theme backing without an independent veil', () => {
    // The import tracks CSS dependencies for Vitest related; unit mode stubs CSS
    // modules, so read the source explicitly. Pixel/HDR acceptance stays separate.
    const css = parse(readFileSync(resolve(__dirname, '../../../styles/globals.css'), 'utf8'));
    const declarations = (selector: string) => {
      const values: Record<string, string> = {};
      css.walkRules(selector, (rule) => {
        rule.walkDecls((decl) => {
          values[decl.prop] = decl.value;
        });
      });
      return values;
    };
    expect(declarations('.app-wallpaper-video').background).toBe('var(--surface)');
    expect(declarations('.app-wallpaper-video').opacity).toBeUndefined();
    expect(declarations('.app-wallpaper-video :is(video, canvas)').opacity).toBe(
      'calc(100% - var(--app-wallpaper-veil))',
    );
    css.walkRules((rule) => {
      if (/\.app-wallpaper-video[^,{]*::?(before|after)/.test(rule.selector)) {
        rule.walkDecls('content', (decl) => {
          expect(['none', 'normal']).toContain(decl.value);
        });
      }
    });
  });
  beforeEach(() => {
    state.reduced = false;
    ensureVideo.mockReset().mockResolvedValue('/cindy-window-hd.mp4');
    vi.stubGlobal('electronAPI', { appearanceSettings: { ensureWallpaperVideo: ensureVideo } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('does not create a decoder for static, reduced motion or unsupported artwork', () => {
    const { rerender } = render(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="static"
      />,
    );
    expect(document.querySelector('video')).toBeNull();
    rerender(<WallpaperVideo wallpaperId="none" motion="dynamic" />);
    expect(document.querySelector('video')).toBeNull();
    state.reduced = true;
    rerender(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    expect(document.querySelector('video')).toBeNull();
    expect(ensureVideo).not.toHaveBeenCalled();
  });
  it('plays custom videos silently, freezes in static/reduced motion, and releases the replaced source', () => {
    const src = `cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`;
    const { rerender, unmount } = render(
      <WallpaperVideo wallpaperId="custom" motion="static" customWallpaperUrl={src} />,
    );
    const video = document.querySelector('video')!;
    expect(video.getAttribute('src')).toBe(src);
    expect(video.play).not.toHaveBeenCalled();
    fireEvent.loadedData(video);
    expect(video.parentElement!.style.opacity).toBe('1');
    rerender(<WallpaperVideo wallpaperId="custom" motion="dynamic" customWallpaperUrl={src} />);
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.muted && video.loop).toBe(true);
    state.reduced = true;
    rerender(<WallpaperVideo wallpaperId="custom" motion="dynamic" customWallpaperUrl={src} />);
    expect(document.querySelector('video')).toBe(video);
    expect(video.pause).toHaveBeenCalled();
    const next = src.replace('a'.repeat(64), 'b'.repeat(64));
    rerender(<WallpaperVideo wallpaperId="custom" motion="dynamic" customWallpaperUrl={next} />);
    expect(video.getAttribute('src')).toBeNull();
    expect(document.querySelector('video')!.getAttribute('src')).toBe(next);
    expect(ensureVideo).not.toHaveBeenCalled();
    unmount();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  // Regression: a viewport-sized playing video lets Chromium hold a display
  // wake lock. The macOS media layer needs a hidden decoder and a visible frame.
  it('keeps the macOS decoder out of layout and paints its frames onto the wallpaper', () => {
    vi.stubGlobal('electronAPI', { ...window.electronAPI, platform: 'darwin' });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const videoPrototype = HTMLVideoElement.prototype;
    const originalRequest = Object.getOwnPropertyDescriptor(videoPrototype, 'requestVideoFrameCallback');
    const originalCancel = Object.getOwnPropertyDescriptor(videoPrototype, 'cancelVideoFrameCallback');
    const requestFrame = vi.fn<(callback: VideoFrameRequestCallback) => number>();
    requestFrame.mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValue(3);
    const cancelFrame = vi.fn();
    Object.defineProperties(videoPrototype, {
      requestVideoFrameCallback: { configurable: true, value: requestFrame },
      cancelVideoFrameCallback: { configurable: true, value: cancelFrame },
    });
    try {
      const src = `cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`;
      const { rerender, unmount } = render(
        <WallpaperVideo wallpaperId="custom" motion="static" customWallpaperUrl={src} />,
      );
      const video = document.querySelector('video')!;
      const canvas = document.querySelector('canvas')!;
      Object.defineProperties(video, {
        readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA },
        videoWidth: { value: 1920 },
        videoHeight: { value: 1080 },
      });

      expect(video.hidden).toBe(true);
      expect(video.muted).toBe(true);
      expect(video.play).not.toHaveBeenCalled();
      fireEvent.loadedData(video);
      expect(canvas.width).toBe(1920);
      expect(canvas.height).toBe(1080);
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0);
      expect(canvas.parentElement!.style.opacity).toBe('1');

      rerender(<WallpaperVideo wallpaperId="custom" motion="dynamic" customWallpaperUrl={src} />);
      expect(video.play).toHaveBeenCalledOnce();
      const [callback] = requestFrame.mock.calls[0]!;
      callback(0, {} as VideoFrameCallbackMetadata);
      expect(drawImage).toHaveBeenCalledTimes(2);
      expect(requestFrame).toHaveBeenCalledTimes(2);
      unmount();
      expect(cancelFrame).toHaveBeenCalledWith(2);
    } finally {
      cleanup();
      if (originalRequest)
        Object.defineProperty(videoPrototype, 'requestVideoFrameCallback', originalRequest);
      else Reflect.deleteProperty(videoPrototype, 'requestVideoFrameCallback');
      if (originalCancel)
        Object.defineProperty(videoPrototype, 'cancelVideoFrameCallback', originalCancel);
      else Reflect.deleteProperty(videoPrototype, 'cancelVideoFrameCallback');
    }
  });
  it('reports an unplayable custom video and releases its decoder', () => {
    const onFailure = vi.fn();
    render(
      <WallpaperVideo
        wallpaperId="custom"
        motion="dynamic"
        customWallpaperUrl={`cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`}
        onFailure={onFailure}
      />,
    );
    const video = document.querySelector('video')!;
    fireEvent.error(video);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(document.querySelector('video')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
  });
  it('shows only decoded frames, pauses with the shared hidden gate, and releases on static', async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    const video = document.querySelector('video')!;
    video.parentElement!.style.transitionDuration = '200ms';
    expect(video.muted && video.loop).toBe(true);
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
    fireEvent.playing(video);
    expect(document.documentElement.dataset.wallpaperMotion).toBe('dynamic');
    await act(async () => document.documentElement.setAttribute(HIDDEN_ANIMATION_ATTR, 'true'));
    expect(video.pause).toHaveBeenCalled();
    await act(async () => document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR));
    expect(video.play).toHaveBeenCalledTimes(2);
    rerender(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="static"
      />,
    );
    expect(document.querySelector('video')).toBe(video);
    expect(video.getAttribute('src')).not.toBeNull();
    // DOM removal precedes passive decoder cleanup. Flush the exit timer and
    // React effects together instead of racing waitFor's DOM-only observation.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector('video')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
    expect(video.load).toHaveBeenCalled();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('fades decoded video over the still, retaining it only until the exit finishes', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    const video = document.querySelector('video')!;
    const layer = video.parentElement!;
    layer.style.transitionDuration = '0.2s';
    expect(layer.style.opacity).toBe('0');
    fireEvent.playing(video);
    expect(layer.style.opacity).toBe('1');
    rerender(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="static"
      />,
    );
    expect(layer.style.opacity).toBe('0');
    expect(document.querySelector('video')).toBe(video);
    expect(document.documentElement.dataset.wallpaperMotion).toBe('dynamic');
    act(() => vi.advanceTimersByTime(100));
    expect(video.getAttribute('src')).not.toBeNull();
    fireEvent.transitionEnd(layer, { propertyName: 'opacity' });
    expect(document.querySelector('video')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('reverses a rapid toggle without replacing the decoder or leaving a stale exit timer', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    const video = document.querySelector('video')!;
    video.parentElement!.style.transitionDuration = '200ms';
    fireEvent.playing(video);
    rerender(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="static"
      />,
    );
    act(() => vi.advanceTimersByTime(100));
    rerender(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    act(() => vi.advanceTimersByTime(250));
    expect(document.querySelector('video')).toBe(video);
    expect(video.parentElement!.style.opacity).toBe('1');
    rerender(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="static"
      />,
    );
    act(() => vi.advanceTimersByTime(200));
    expect(document.querySelector('video')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
  });
  it('releases immediately if reduced motion is enabled during a fade', () => {
    const { rerender } = render(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    const video = document.querySelector('video')!;
    fireEvent.playing(video);
    state.reduced = true;
    rerender(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    expect(document.querySelector('video')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
  });
  it('keeps the still fallback when decode or playback fails', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('decode failed'));
    render(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    await waitFor(() => expect(document.querySelector('video')).toBeNull());
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('switches scenes without retaining a second decoder', () => {
    const { rerender } = render(
      <WallpaperVideo
        officialVideoUrl="/cindy-window.mp4"
        wallpaperId="cindy-window"
        motion="dynamic"
      />,
    );
    const old = document.querySelector('video')!;
    fireEvent.playing(old);
    rerender(
      <WallpaperVideo
        officialVideoUrl="/cindy-dream.mp4"
        wallpaperId="cindy-dream"
        motion="dynamic"
      />,
    );
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(old.getAttribute('src')).toBeNull();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('keeps the static background until the downloaded video is available', () => {
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    expect(document.querySelector('video')).toBeNull();
    rerender(
      <WallpaperVideo wallpaperId="cindy-window" motion="dynamic" officialVideoUrl="/cached.mp4" />,
    );
    const video = document.querySelector('video')!;
    expect(video.parentElement!.style.opacity).toBe('0');
    fireEvent.playing(video);
    expect(video.parentElement!.style.opacity).toBe('1');
  });
  it('does not create a decoder when a download completes after motion is disabled', () => {
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    rerender(
      <WallpaperVideo wallpaperId="cindy-window" motion="static" officialVideoUrl="/cached.mp4" />,
    );
    expect(document.querySelector('video')).toBeNull();
  });
  it('keeps the same downloaded decoder when the window changes size', () => {
    const { rerender } = render(
      <WallpaperVideo wallpaperId="cindy-window" motion="dynamic" officialVideoUrl="/cached.mp4" />,
    );
    const video = document.querySelector('video');
    fireEvent(window, new Event('resize'));
    rerender(
      <WallpaperVideo wallpaperId="cindy-window" motion="dynamic" officialVideoUrl="/cached.mp4" />,
    );
    expect(document.querySelector('video')).toBe(video);
    expect(ensureVideo).not.toHaveBeenCalled();
  });
  // #10690: a native loop's short waiting must not remove the marker that
  // keeps production composer backgrounds transparent (unit tier).
  it.each(['cindy-window', 'custom'] as const)(
    'keeps the %s canvas and composer mode through short loop waits',
    (wallpaperId) => {
      vi.useFakeTimers();
      render(
        <WallpaperVideo
          wallpaperId={wallpaperId}
          motion="dynamic"
          officialVideoUrl="/cached.mp4"
          customWallpaperUrl={`cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`}
        />,
      );
      const video = document.querySelector('video')!;
      fireEvent.playing(video);
      fireEvent.waiting(video);
      act(() => vi.advanceTimersByTime(10));
      expect(video.parentElement!.style.opacity).toBe('1');
      expect(document.documentElement.dataset.wallpaperMotion).toBe('dynamic');
      fireEvent.playing(video);
      act(() => vi.advanceTimersByTime(5_000));
      expect(video.parentElement!.style.opacity).toBe('1');
      expect(document.documentElement.dataset.wallpaperMotion).toBe('dynamic');
      expect(video.load).not.toHaveBeenCalled();
    },
  );
  it('bounds repeated waiting before falling back and cancels a pending hide on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <WallpaperVideo wallpaperId="cindy-window" motion="dynamic" officialVideoUrl="/cached.mp4" />,
    );
    const video = document.querySelector('video')!;
    fireEvent.playing(video);
    fireEvent.waiting(video);
    act(() => vi.advanceTimersByTime(400));
    fireEvent.waiting(video);
    act(() => vi.advanceTimersByTime(100));
    expect(video.parentElement!.style.opacity).toBe('0');
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
    fireEvent.playing(video);
    fireEvent.waiting(video);
    unmount();
    const loads = vi.mocked(video.load).mock.calls.length;
    act(() => vi.advanceTimersByTime(10_000));
    expect(video.load).toHaveBeenCalledTimes(loads);
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('keeps a decoded custom frame when motion stops during the waiting grace period', () => {
    vi.useFakeTimers();
    const src = `cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`;
    const { rerender } = render(
      <WallpaperVideo wallpaperId="custom" motion="dynamic" customWallpaperUrl={src} />,
    );
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    fireEvent.playing(video);
    fireEvent.waiting(video);
    rerender(<WallpaperVideo wallpaperId="custom" motion="static" customWallpaperUrl={src} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(video.parentElement!.style.opacity).toBe('1');
    expect(document.documentElement.dataset.wallpaperMotion).toBe('dynamic');
    expect(video.load).not.toHaveBeenCalled();
  });
  it.each([
    ['static', 10],
    ['static', 500],
    ['reduced', 10],
    ['reduced', 500],
  ] as const)(
    'retains a custom %s frame across hide/restore after %ims waiting',
    async (mode, delay) => {
      vi.useFakeTimers();
      const src = `cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`;
      const { rerender } = render(
        <WallpaperVideo wallpaperId="custom" motion="dynamic" customWallpaperUrl={src} />,
      );
      const video = document.querySelector('video')!;
      Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
      fireEvent.playing(video);
      fireEvent.waiting(video);
      act(() => vi.advanceTimersByTime(delay));
      state.reduced = mode === 'reduced';
      rerender(
        <WallpaperVideo
          wallpaperId="custom"
          motion={mode === 'static' ? 'static' : 'dynamic'}
          customWallpaperUrl={src}
        />,
      );
      expect(video.parentElement!.style.opacity).toBe('1');
      await act(async () => document.documentElement.setAttribute(HIDDEN_ANIMATION_ATTR, 'true'));
      await act(async () => document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR));
      expect(video.parentElement!.style.opacity).toBe('1');
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      fireEvent(document, new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      fireEvent(document, new Event('visibilitychange'));
      act(() => vi.advanceTimersByTime(15_000));
      expect(document.querySelector('video')).toBe(video);
      expect(video.parentElement!.style.opacity).toBe('1');
      expect(video.play).toHaveBeenCalledOnce();
      expect(video.load).not.toHaveBeenCalled();
      Reflect.deleteProperty(document, 'hidden');
    },
  );
  it('releases a failed decoder even during a short wait', () => {
    vi.useFakeTimers();
    render(
      <WallpaperVideo wallpaperId="cindy-window" motion="dynamic" officialVideoUrl="/cached.mp4" />,
    );
    const video = document.querySelector('video')!;
    fireEvent.playing(video);
    fireEvent.waiting(video);
    fireEvent.error(video);
    expect(document.querySelector('video')).toBeNull();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
    const loads = vi.mocked(video.load).mock.calls.length;
    act(() => vi.advanceTimersByTime(10_000));
    expect(video.load).toHaveBeenCalledTimes(loads);
  });
  // #8597: the opaque video backing must not hide the still after a decoder
  // interruption. Exercise the production component's media events (unit tier).
  it.each(['waiting', 'emptied', 'stalled'])(
    'reveals the still on %s and cancels recovery when playback returns',
    (event) => {
      vi.useFakeTimers();
      render(
        <WallpaperVideo
          wallpaperId="cindy-window"
          motion="dynamic"
          officialVideoUrl="/cached.mp4"
        />,
      );
      const video = document.querySelector('video')!;
      Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
      fireEvent.playing(video);
      expect(video.parentElement!.style.opacity).toBe('1');
      fireEvent(video, new Event(event));
      if (event === 'waiting') act(() => vi.advanceTimersByTime(500));
      expect(video.parentElement!.style.opacity).toBe('0');
      expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
      act(() => vi.advanceTimersByTime(event === 'waiting' ? 4_500 : 5_000));
      expect(video.load).toHaveBeenCalledOnce();
      Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
      fireEvent.playing(video);
      expect(video.parentElement!.style.opacity).toBe('1');
      act(() => vi.advanceTimersByTime(15_000));
      expect(video.load).toHaveBeenCalledOnce();
    },
  );
  it('suspends interrupted recovery while hidden and bounds reloads after returning', async () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <WallpaperVideo wallpaperId="cindy-window" motion="dynamic" officialVideoUrl="/cached.mp4" />,
    );
    const video = document.querySelector('video')!;
    fireEvent.playing(video);
    fireEvent.waiting(video);
    await act(async () => document.documentElement.setAttribute(HIDDEN_ANIMATION_ATTR, 'true'));
    act(() => vi.advanceTimersByTime(15_000));
    expect(video.load).not.toHaveBeenCalled();
    await act(async () => document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR));
    act(() => vi.advanceTimersByTime(15_000));
    expect(video.load).toHaveBeenCalledTimes(2);
    expect(video.parentElement!.style.opacity).toBe('0');
    unmount();
    // Unmount releases once, but must cancel every pending recovery callback.
    const calls = vi.mocked(video.load).mock.calls.length;
    act(() => vi.advanceTimersByTime(15_000));
    expect(video.load).toHaveBeenCalledTimes(calls);
  });
  it('retains a decoded paused custom frame when buffering stalls with current data', () => {
    vi.useFakeTimers();
    render(
      <WallpaperVideo
        wallpaperId="custom"
        motion="static"
        customWallpaperUrl={`cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`}
      />,
    );
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
    fireEvent.loadedData(video);
    fireEvent.stalled(video);
    act(() => vi.advanceTimersByTime(15_000));
    expect(video.parentElement!.style.opacity).toBe('1');
    expect(video.load).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
  });
});
