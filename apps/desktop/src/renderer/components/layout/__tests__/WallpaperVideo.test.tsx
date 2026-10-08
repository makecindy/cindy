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

const state = vi.hoisted(() => ({ reduced: false, tier: 'standard', cdn: true }));
const ensureVideo = vi.fn();
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => state.reduced }));
vi.mock('@/hooks/useWallpaperVideoTier', () => ({ useWallpaperVideoTier: () => state.tier }));
vi.mock('@/lib/wallpaper', () => ({
  usesCdnWallpaperVideo: () => state.cdn,
  getWallpaperVideo: (id: string, tier = 'standard') =>
    id.startsWith('cindy-') ? `/${id}${tier === 'hd' ? '-hd' : ''}.mp4` : undefined,
}));

describe('dynamic wallpaper lifecycle', () => {
  it('keeps visibility on the video over an opaque theme backing without an independent veil', () => {
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
    expect(declarations('.app-wallpaper-video video').opacity).toBe(
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
    state.tier = 'standard';
    state.cdn = true;
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
    state.cdn = false;
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
    expect(document.querySelector('video')).toBeNull();
    rerender(<WallpaperVideo wallpaperId="none" motion="dynamic" />);
    expect(document.querySelector('video')).toBeNull();
    state.reduced = true;
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
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
    state.cdn = false;
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
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
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
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
    state.cdn = false;
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const video = document.querySelector('video')!;
    const layer = video.parentElement!;
    layer.style.transitionDuration = '0.2s';
    expect(layer.style.opacity).toBe('0');
    fireEvent.playing(video);
    expect(layer.style.opacity).toBe('1');
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
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
    state.cdn = false;
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const video = document.querySelector('video')!;
    video.parentElement!.style.transitionDuration = '200ms';
    fireEvent.playing(video);
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
    act(() => vi.advanceTimersByTime(100));
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    act(() => vi.advanceTimersByTime(250));
    expect(document.querySelector('video')).toBe(video);
    expect(video.parentElement!.style.opacity).toBe('1');
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
    act(() => vi.advanceTimersByTime(200));
    expect(document.querySelector('video')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
  });
  it('releases immediately if reduced motion is enabled during a fade', () => {
    state.cdn = false;
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const video = document.querySelector('video')!;
    fireEvent.playing(video);
    state.reduced = true;
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    expect(document.querySelector('video')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
  });
  it('keeps the still fallback when decode or playback fails', async () => {
    state.cdn = false;
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('decode failed'));
    render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    await waitFor(() => expect(document.querySelector('video')).toBeNull());
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('switches scenes without retaining a second decoder', () => {
    state.cdn = false;
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const old = document.querySelector('video')!;
    fireEvent.playing(old);
    rerender(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(old.getAttribute('src')).toBeNull();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('releases the previous tier and keeps the still visible until the new video plays', async () => {
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const standard = document.querySelector('video')!;
    fireEvent.playing(standard);
    state.tier = 'hd';
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    // A new DOM node can precede passive cleanup of the old decoder. Wait for
    // both lifecycle obligations, not just the mutation observer's DOM signal.
    await waitFor(() => {
      expect(document.querySelector('video')!.src).toContain('-hd.mp4');
      expect(standard.getAttribute('src')).toBeNull();
    });
    const hd = document.querySelector('video')!;
    expect(hd.src).toContain('cindy-window-hd.mp4');
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(standard.getAttribute('src')).toBeNull();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
    fireEvent.playing(hd);
    expect(document.documentElement.dataset.wallpaperMotion).toBe('dynamic');
    state.tier = 'standard';
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    expect(hd.getAttribute('src')).toBeNull();
    expect(document.querySelector('video')!.src).not.toContain('-hd');
  });
  it.each(['cindy-window', 'cindy-studio', 'cindy-dream'] as const)(
    'plays bundled %s without requesting CDN or reloading on resize',
    async (id) => {
      state.cdn = false;
      const { rerender } = render(<WallpaperVideo wallpaperId={id} motion="dynamic" />);
      const original = document.querySelector('video');
      state.tier = 'hd';
      rerender(<WallpaperVideo wallpaperId={id} motion="dynamic" />);
      await act(async () => {});
      expect(document.querySelector('video')).toBe(original);
      expect(ensureVideo).not.toHaveBeenCalled();
    },
  );
  it.each(['error', 'rejection'])(
    'falls back from HD once on %s, then to a still if standard fails',
    async (failure) => {
      state.tier = 'hd';
      ensureVideo.mockImplementation(async () => {
        if (failure === 'rejection')
          vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
            new Error('unsupported HD'),
          );
        return '/cindy-dream-hd.mp4';
      });
      const { rerender } = render(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
      if (failure === 'error') {
        await waitFor(() => expect(document.querySelector('video')!.src).toContain('-hd.mp4'));
        fireEvent.error(document.querySelector('video')!);
      }
      await act(async () => {});
      await waitFor(() =>
        expect(document.querySelector('video')!.src).toContain('/cindy-dream.mp4'),
      );
      const standard = document.querySelector('video')!;
      state.tier = 'standard';
      rerender(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
      state.tier = 'hd';
      rerender(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
      expect(document.querySelector('video')).toBe(standard);
      fireEvent.error(standard);
      expect(document.querySelector('video')).toBeNull();
      expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
    },
  );
  it.each(['missing', 'offline'])('keeps playing standard when CDN is %s', async (reason) => {
    state.tier = 'hd';
    if (reason === 'missing') ensureVideo.mockResolvedValue(null);
    else ensureVideo.mockRejectedValue(new Error('offline'));
    render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const standard = document.querySelector('video');
    await act(async () => {});
    expect(document.querySelector('video')).toBe(standard);
    expect(ensureVideo).toHaveBeenCalledOnce();
  });
  it('ignores a completed download after switching to static or another scene', async () => {
    state.tier = 'hd';
    let finish!: (url: string) => void;
    ensureVideo.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
    await act(async () => finish('/old-hd.mp4'));
    expect(document.querySelector('video')).toBeNull();
    ensureVideo.mockResolvedValue(null);
    rerender(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
    await act(async () => {});
    expect(document.querySelector('video')!.src).toContain('/cindy-dream.mp4');
  });
});
