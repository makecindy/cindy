// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperSettingsProvider, useWallpaperSettings } from '../useWallpaperSettings';
import { DEFAULT_APPEARANCE_SETTINGS } from '@/../shared/appearanceSettings';

function Controls() {
  const settings = useWallpaperSettings();
  return (
    <>
      <button onClick={() => settings.setWallpaper('cindy-window')}>Choose</button>
      <button onClick={settings.resetWallpaper}>Reset</button>
      <button onClick={() => settings.setMotion('dynamic')}>Animate</button>
      <span data-testid="motion">{settings.wallpaperMotion}</span>
    </>
  );
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('application wallpaper lifecycle', () => {
  it('loads client artwork without subscribing to account changes', async () => {
    const url = `cindy-media://client-wallpaper/${'b'.repeat(64)}.webp`;
    const subscribeAuth = vi.fn();
    const get = vi
      .fn()
      .mockResolvedValue({
        value: { ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'custom', customWallpaperUrl: url },
      });
    vi.stubGlobal('electronAPI', {
      onAuthStateChange: subscribeAuth,
      appearanceSettings: {
        getSync: () => DEFAULT_APPEARANCE_SETTINGS,
        get,
        onChanged: () => () => {},
      },
    });
    render(
      <WallpaperSettingsProvider>
        <Controls />
      </WallpaperSettingsProvider>,
    );
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toContain(
        url,
      ),
    );
    expect(document.querySelector('video')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toContain(url);
    expect(subscribeAuth).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toContain(url);
  });
  it('does not enable transparent surfaces for a missing custom image', () => {
    vi.stubGlobal('electronAPI', {
      appearanceSettings: {
        getSync: () => ({
          ...DEFAULT_APPEARANCE_SETTINGS,
          wallpaperId: 'custom',
          customWallpaperUrl: 'file:///private.png',
        }),
        onChanged: () => () => {},
      },
    });
    render(
      <WallpaperSettingsProvider>
        <Controls />
      </WallpaperSettingsProvider>,
    );
    expect(document.documentElement.dataset.wallpaperActive).toBeUndefined();
  });
  it.each(['cindy-window', 'cindy-studio', 'cindy-dream'] as const)(
    'keeps %s as one full-window scene across pane and theme changes',
    async (wallpaperId) => {
      let changed: (value: typeof DEFAULT_APPEARANCE_SETTINGS) => void = () => {};
      vi.stubGlobal('electronAPI', {
        appearanceSettings: {
          getSync: () => ({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'none' }),
          onChanged: (fn: typeof changed) => {
            changed = fn;
            return () => {};
          },
        },
      });
      render(
        <WallpaperSettingsProvider>
          <Controls />
        </WallpaperSettingsProvider>,
      );
      act(() => changed({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId }));
      const style = document.documentElement.style;
      const artwork = style.getPropertyValue('--app-wallpaper-image');
      const veil = parseFloat(style.getPropertyValue('--app-wallpaper-veil'));
      expect(artwork.match(/url\(/g)).toHaveLength(1);
      expect(style.getPropertyValue('--app-wallpaper-figure-size')).toBe('');
      expect(style.getPropertyValue('--app-wallpaper-figure-position')).toBe('');
      await act(async () => {
        window.dispatchEvent(new Event('resize'));
        document.documentElement.classList.add('dark');
      });
      await waitFor(() =>
        expect(parseFloat(style.getPropertyValue('--app-wallpaper-veil'))).toBeGreaterThan(veil),
      );
      expect(style.getPropertyValue('--app-wallpaper-image')).toBe(artwork);
      expect(style.getPropertyValue('--app-wallpaper-figure-position')).toBe('');
    },
  );
  it('covers the document, including portals, and restores the theme on reset/unmount', () => {
    vi.stubGlobal('electronAPI', undefined);
    const { unmount } = render(
      <WallpaperSettingsProvider>
        <Controls />
      </WallpaperSettingsProvider>,
    );
    expect(document.documentElement.dataset.wallpaperActive).toBeUndefined();
    fireEvent.click(screen.getByText('Choose'));
    expect(document.documentElement.dataset.wallpaperActive).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toMatch(
      /^url\(/,
    );
    fireEvent.click(screen.getByText('Reset'));
    expect(document.documentElement.dataset.wallpaperActive).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toBe('');
    unmount();
    expect(document.documentElement.dataset.wallpaperActive).toBeUndefined();
  });

  it('applies another window’s settings and removes the image when that window disables it', () => {
    let changed: (value: typeof DEFAULT_APPEARANCE_SETTINGS) => void = () => {};
    const unsubscribe = vi.fn();
    vi.stubGlobal('electronAPI', {
      appearanceSettings: {
        getSync: () => ({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'cindy-studio' }),
        onChanged: (fn: typeof changed) => {
          changed = fn;
          return unsubscribe;
        },
      },
    });
    const { unmount } = render(
      <WallpaperSettingsProvider>
        <Controls />
      </WallpaperSettingsProvider>,
    );
    expect(document.documentElement.dataset.wallpaperActive).toBe('true');
    act(() => changed({ ...DEFAULT_APPEARANCE_SETTINGS }));
    expect(document.documentElement.dataset.wallpaperActive).toBeUndefined();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('rolls back the document background if saving the selection fails', async () => {
    const setPatch = vi.fn().mockRejectedValue(new Error('save failed'));
    vi.stubGlobal('electronAPI', {
      appearanceSettings: {
        getSync: () => DEFAULT_APPEARANCE_SETTINGS,
        onChanged: () => () => {},
        setPatch,
      },
    });
    render(
      <WallpaperSettingsProvider>
        <Controls />
      </WallpaperSettingsProvider>,
    );
    fireEvent.click(screen.getByText('Choose'));
    await waitFor(() => expect(setPatch).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.documentElement.dataset.wallpaperActive).toBeUndefined());
  });

  it('persists motion independently, follows other windows, and resets it with wallpaper', async () => {
    let changed: (value: typeof DEFAULT_APPEARANCE_SETTINGS) => void = () => {};
    const setPatch = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('electronAPI', {
      appearanceSettings: {
        getSync: () => ({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'cindy-studio' }),
        onChanged: (callback: typeof changed) => {
          changed = callback;
          return () => {};
        },
        setPatch,
      },
    });
    render(
      <WallpaperSettingsProvider>
        <Controls />
      </WallpaperSettingsProvider>,
    );
    const original = document.documentElement.style.getPropertyValue('--app-wallpaper-image');
    fireEvent.click(screen.getByText('Animate'));
    await waitFor(() => expect(setPatch).toHaveBeenCalledWith({ wallpaperMotion: 'dynamic' }));
    expect(screen.getByTestId('motion').textContent).toBe('dynamic');
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper-image')).toBe(original);
    act(() =>
      changed({
        ...DEFAULT_APPEARANCE_SETTINGS,
        wallpaperId: 'cindy-studio',
        wallpaperMotion: 'static',
      }),
    );
    expect(screen.getByTestId('motion').textContent).toBe('static');
    fireEvent.click(screen.getByText('Animate'));
    fireEvent.click(screen.getByText('Reset'));
    expect(screen.getByTestId('motion').textContent).toBe('static');
    await waitFor(() =>
      expect(setPatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ wallpaperMotion: 'static', wallpaperId: 'none' }),
      ),
    );
  });
});
