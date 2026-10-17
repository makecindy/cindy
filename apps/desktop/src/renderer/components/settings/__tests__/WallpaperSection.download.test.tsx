// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperSection } from '../WallpaperSection';
import { DEFAULT_APPEARANCE_SETTINGS, type WallpaperId } from '@/../shared/appearanceSettings';

const state = vi.hoisted(() => ({
  id: 'cindy-window' as WallpaperId,
  pending: false,
  failed: false,
  progress: 0,
  retry: vi.fn(),
  select: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useWallpaperSettings', () => ({
  useWallpaperSettings: () => ({
    ...DEFAULT_APPEARANCE_SETTINGS,
    wallpaperId: state.id,
    visibility: 1,
    downloadPending: state.pending,
    downloadFailed: state.failed,
    downloadProgress: state.progress,
    retryDownload: state.retry,
    setWallpaper: state.select,
    setVisibility: vi.fn(),
    setBlur: vi.fn(),
    previewBlur: vi.fn(),
    setMotion: vi.fn(),
    resetWallpaper: vi.fn(),
  }),
}));
beforeEach(() => {
  state.id = 'cindy-window';
  state.pending = false;
  state.failed = false;
  state.progress = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  state.retry.mockReset();
  state.select.mockReset();
  vi.unstubAllGlobals();
});

describe('wallpaper download feedback', () => {
  // User request 2026-10-17: still-only originals share download progress/retry
  // with scenes, but have no motion switch. Existing cases only exercised
  // cindy-window; minimum additional input is cindy-whisper; unit tier.
  it.each(['cindy-window', 'cindy-whisper'] as const)(
    'shows progress for %s while keeping its tile visible',
    (id) => {
      state.id = id;
      state.pending = true;
      const { rerender } = render(<WallpaperSection />);
      const status = screen.getByRole('progressbar', {
        name: 'settings.appearance.wallpaper.downloading',
      });
      expect(
        screen
          .getByRole('radio', {
            name: 'settings.appearance.wallpaper.options.' + id,
          })
          .getAttribute('aria-checked'),
      ).toBe('true');
      expect(screen.getAllByRole('progressbar')).toEqual([status]);
      if (id === 'cindy-whisper')
        expect(screen.queryByText('settings.appearance.wallpaper.motionLabel')).toBeNull();
      expect(status.getAttribute('aria-valuenow')).toBe('0');
      for (const progress of [0.25, 0.75, 1]) {
        state.progress = progress;
        rerender(<WallpaperSection />);
        expect(status.getAttribute('aria-valuenow')).toBe(String(progress * 100));
        expect(
          within(screen.getByRole('status')).getByText(String(progress * 100) + '%'),
        ).toBeTruthy();
      }
      state.pending = false;
      rerender(<WallpaperSection />);
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('progressbar')).toBeNull();
    },
  );

  it.each(['cindy-window', 'cindy-whisper'] as const)(
    'keeps manual retry reachable for %s and lets new tiles change selection',
    (id) => {
      state.id = id;
      state.failed = true;
      const { rerender } = render(<WallpaperSection />);
      expect(screen.getByRole('status').textContent).toContain('wallpaper.downloadFailed');
      fireEvent.click(
        screen.getByRole('button', {
          name: 'settings.appearance.wallpaper.retryDownload',
        }),
      );
      expect(state.retry).toHaveBeenCalledOnce();
      expect(state.select).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole('radio', {
          name: 'settings.appearance.wallpaper.options.cindy-whisper',
        }),
      );
      expect(state.select).toHaveBeenCalledWith('cindy-whisper');
      expect(state.retry).toHaveBeenCalledOnce();

      state.pending = true;
      rerender(<WallpaperSection />);
      expect(
        screen.queryByRole('button', {
          name: 'settings.appearance.wallpaper.retryDownload',
        }),
      ).toBeNull();
      expect(screen.getByRole('progressbar')).toBeTruthy();
      state.pending = false;
      state.failed = false;
      rerender(<WallpaperSection />);
      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  it('does not show stale CDN feedback when no wallpaper is selected', () => {
    state.id = 'none';
    state.pending = true;
    state.failed = true;
    render(<WallpaperSection />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'settings.appearance.wallpaper.retryDownload',
      }),
    ).toBeNull();
    expect(
      screen
        .getByRole('radio', {
          name: 'settings.appearance.wallpaper.options.none',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});
