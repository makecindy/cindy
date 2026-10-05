import { describe, expect, it } from 'vitest';
import { normalizeAppearanceSettings } from '../appearanceSettings';

describe('wallpaper catalog compatibility', () => {
  it('accepts only canonical host-owned custom artwork and never legacy paths or CSS', () => {
    const url = `cindy-media://client-wallpaper/${'a'.repeat(64)}.webp`;
    expect(
      normalizeAppearanceSettings({ wallpaperId: 'custom', customWallpaperUrl: url }),
    ).toMatchObject({ wallpaperId: 'custom', customWallpaperUrl: url });
    for (const value of [
      'file:///private.png',
      'https://example.com/image.webp',
      'data:image/png;base64,abc',
      `${url}"),url(https://example.com)`,
      1,
    ]) {
      expect(normalizeAppearanceSettings({ customWallpaperUrl: value }).customWallpaperUrl).toBe(
        '',
      );
    }
  });
  it.each(['cindy', 'cindy-portrait', 'aurora', 'sunset', 'paper'])(
    'disables retired %s without resetting other appearance preferences',
    (wallpaperId) => {
      const settings = normalizeAppearanceSettings({
        wallpaperId,
        wallpaperPath: '/previous/image.png',
        wallpaperFit: 'contain',
        wallpaperMotion: 'dynamic',
        wallpaperOverlay: 0.35,
        uiFamily: 'Example Sans',
        codeFamily: 'Example Mono',
        uiSize: 18,
        codeSize: 16,
        windowZoom: 1.2,
      });
      expect(settings).toEqual({
        wallpaperId: 'none',
        customWallpaperUrl: '',
        wallpaperMotion: 'dynamic',
        wallpaperOverlay: 0.35,
        uiFamily: 'Example Sans',
        codeFamily: 'Example Mono',
        uiSize: 18,
        codeSize: 16,
        windowZoom: 1.2,
      });
    },
  );
  it.each(['cindy-window', 'cindy-studio', 'cindy-dream'])(
    'preserves both display modes for %s',
    (wallpaperId) => {
      for (const wallpaperMotion of ['static', 'dynamic']) {
        expect(normalizeAppearanceSettings({ wallpaperId, wallpaperMotion })).toMatchObject({
          wallpaperId,
          wallpaperMotion,
        });
      }
    },
  );
});
