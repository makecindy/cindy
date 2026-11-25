// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperSection } from '../WallpaperSection';
import { DEFAULT_APPEARANCE_SETTINGS, type WallpaperId } from '@/../shared/appearanceSettings';

const state = vi.hoisted(() => ({
  id: 'cindy-window' as WallpaperId,
  shown: undefined as WallpaperId | undefined,
  pending: false,
  failed: false,
  progress: 0,
  retryReason: undefined as 'slow' | undefined,
  retry: vi.fn(),
  select: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useWallpaperSettings', () => ({
  useWallpaperSettings: () => ({
    ...DEFAULT_APPEARANCE_SETTINGS,
    wallpaperId: state.id,
    visibility: 1,
    downloadWallpaperId: state.shown ?? state.id,
    downloadPending: state.pending,
    downloadFailed: state.failed,
    downloadProgress: state.progress,
    downloadRetryReason: state.retryReason,
    retryDownload: state.retry,
    setWallpaper: state.select,
    setVisibility: vi.fn(),
    previewVisibility: vi.fn(),
    setBlur: vi.fn(),
    previewBlur: vi.fn(),
    setMotion: vi.fn(),
    resetWallpaper: vi.fn(),
  }),
}));
beforeEach(() => {
  state.id = 'cindy-window';
  state.shown = undefined;
  state.pending = false;
  state.failed = false;
  state.progress = 0;
  state.retryReason = undefined;
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
  // cindy-window; minimum additional input is night-launch (cindy-whisper gained motion on 2026-10-17); unit tier.
  it.each(['cindy-window', 'night-launch'] as const)(
    'shows progress for %s while keeping its tile visible',
    (id) => {
      state.id = id;
      state.pending = true;
      const { rerender } = render(<WallpaperSection />);
      const status = screen.getByRole('progressbar', {
        name: 'settings.appearance.wallpaper.downloading',
      });
      const tile = screen.getByRole('radio', {
        name: 'settings.appearance.wallpaper.options.' + id,
      });
      expect(tile.getAttribute('aria-checked')).toBe('true');
      expect(tile.getAttribute('aria-busy')).toBe('true');
      expect(screen.getAllByRole('progressbar')).toEqual([status]);
      if (id === 'night-launch')
        expect(screen.queryByText('settings.appearance.wallpaper.motionLabel')).toBeNull();
      expect(status.getAttribute('aria-valuenow')).toBe('0');
      for (const progress of [0.25, 0.75, 1]) {
        state.progress = progress;
        rerender(<WallpaperSection />);
        expect(status.getAttribute('aria-valuenow')).toBe(String(progress * 100));
        expect(within(tile).queryByText(String(progress * 100) + '%')).toBeNull();
      }
      // A transfer that restarted for a retry says why to assistive technology.
      state.retryReason = 'slow';
      rerender(<WallpaperSection />);
      expect(status.getAttribute('aria-valuetext')).toBe('downloadProgress.retry.slow');
      state.pending = false;
      rerender(<WallpaperSection />);
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(tile.getAttribute('aria-busy')).not.toBe('true');
    },
  );

  it.each(['cindy-window', 'night-launch'] as const)(
    'keeps manual retry reachable for %s and lets new tiles change selection',
    (id) => {
      state.id = id;
      state.failed = true;
      const { rerender } = render(<WallpaperSection />);
      expect(screen.getByRole('status').textContent).toContain('wallpaper.downloadFailed');
      fireEvent.click(
        screen.getByRole('radio', {
          name: 'settings.appearance.wallpaper.options.' + id,
        }),
      );
      expect(state.retry).toHaveBeenCalledOnce();
      expect(state.select).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole('radio', {
          name: 'settings.appearance.wallpaper.options.dune-dawn',
        }),
      );
      expect(state.select).toHaveBeenCalledWith('dune-dawn');
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

  it('retries a failed selected thumbnail with Enter and Space without adding a Tab stop', async () => {
    const user = userEvent.setup();
    state.id = 'night-launch';
    state.failed = true;
    render(<WallpaperSection />);
    const tile = screen.getByRole('radio', {
      name: 'settings.appearance.wallpaper.options.night-launch',
    });
    act(() => tile.focus());
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(state.retry).toHaveBeenCalledTimes(2);
    expect(state.select).not.toHaveBeenCalled();
    expect(screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toEqual([tile]);
  });

  // makecindy/cindy#12542: the provider reports the wallpaper on screen, which is a teammate's
  // own while its view is open. Not covered before; minimal input: saved cindy-window,
  // night-launch on screen and failing; unit tier.
  it('does not show another wallpaper’s download state on the saved selection', () => {
    state.shown = 'night-launch';
    state.failed = true;
    const { rerender } = render(<WallpaperSection />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'settings.appearance.wallpaper.options.cindy-window' }));
    expect(state.retry).not.toHaveBeenCalled();
    state.failed = false;
    state.pending = true;
    rerender(<WallpaperSection />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

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
