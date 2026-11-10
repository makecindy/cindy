/* global window */
import assert from 'node:assert/strict';

export default {
  name: 'bing-wallpaper',
  entry: './fixture.tsx',
  viewport: { width: 880, height: 850 },
  real: 'WallpaperSection, real settings primitives, translations, keyboard radio group and Bing status/attribution',
  notCovered:
    'The wallpaper settings hook is synthetic. Main requests, media storage, canvas decoding and IPC are covered by unit tests.',
  stubs: {
    'src/renderer/hooks/useWallpaperSettings': {
      partial: 'export const useWallpaperSettings = () => window.bingWallpaperFixture;',
    },
  },
  cases: {
    loading: { about: 'First daily image loading without a cache', data: { status: 'loading' } },
    failed: { about: 'First fetch failed with a retry action', data: { status: 'failed' } },
    default: {
      about: 'Cached daily image with attribution and retained sliders',
      data: { status: 'ready', cached: true },
    },
    stale: {
      about: 'Failed refresh retains the cached image and exposes retry',
      data: { status: 'stale', cached: true },
    },
  },
  async check(page, ui) {
    const tile = page.getByRole('radio', {
      name: await ui.t('settings.appearance.wallpaper.options.bing-daily'),
      exact: true,
    });
    assert.equal(await tile.getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('slider').count(), 2);
    assert.equal(
      await page
        .getByRole('button', {
          name: await ui.t('settings.appearance.wallpaper.motionDynamic'),
          exact: true,
        })
        .count(),
      0,
    );
    if (ui.data.cached) {
      await page.getByText('© Example Photographer', { exact: true }).waitFor();
      await page.getByText('2026-11-09 · Example landscape', { exact: true }).waitFor();
    }
    if (ui.data.status === 'failed' || ui.data.status === 'stale') {
      await page
        .getByRole('button', {
          name: await ui.t('settings.appearance.wallpaper.retryDownload'),
          exact: true,
        })
        .click();
      assert.equal(await page.evaluate(() => window.bingWallpaperRetries), 1);
    }
  },
};
