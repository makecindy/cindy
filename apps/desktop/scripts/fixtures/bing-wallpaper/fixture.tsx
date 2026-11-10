import { WallpaperSection } from '../../../src/renderer/components/settings/WallpaperSection';
import { mountPage, ctx, forbid } from '../../ui-page/harness';

// Real settings UI with synthetic state. No image network, credentials or userData.
window.bingWallpaperFixture = {
  wallpaperId: 'bing-daily',
  wallpaperOverlay: 0.2,
  wallpaperVisibility: 0.6,
  wallpaperBlur: 8,
  wallpaperMotion: 'static',
  visibility: 0.6,
  bingDecodeFailed: ctx.data.decodeFailed ?? false,
  downloadPending: false,
  downloadFailed: false,
  downloadProgress: 0,
  playbackFailed: false,
  bingWallpaper: {
    status: ctx.data.status,
    image: ctx.data.cached
      ? {
          url:
            'data:image/svg+xml,' +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#617280"/><path d="M0 1080L720 360L1440 1080M600 1080L1440 240L1920 1080" fill="#3c5057"/></svg>',
            ),
          title: 'Example landscape',
          date: '20261109',
          copyright: '© Example Photographer',
          sourceUrl: 'https://www.bing.com/search?q=example',
        }
      : null,
  },
  retryDownload: () => {
    window.bingWallpaperRetries++;
  },
  setWallpaper: forbid('settings selection'),
  setVisibility: forbid('visibility'),
  previewVisibility() {},
  setBlur: forbid('blur'),
  previewBlur() {},
  setMotion: forbid('motion'),
  resetWallpaper: forbid('reset'),
};
window.bingWallpaperRetries = 0;

void mountPage({
  host: { openExternal: async () => ({ success: true }) },
  render: () => (
    <main className="mx-auto max-w-3xl p-6">
      <WallpaperSection />
    </main>
  ),
});
