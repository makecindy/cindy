import { describe, expect, it } from 'vitest';
import {
  normalizeAppearanceSettings,
  getWallpaperVeil,
  clampAppearanceWallpaperOverlay,
  getWallpaperVisibility,
} from '../appearanceSettings';

describe('wallpaper catalog compatibility', () => {
  it.each([false, true])(
    'preserves legacy visuals but gives explicit visibility the full range (dark=%s)',
    (dark) => {
      for (const wallpaperOverlay of [0, 0.2, 0.6, 0.85, 1]) {
        const legacy = normalizeAppearanceSettings({ wallpaperOverlay });
        expect(legacy).not.toHaveProperty('wallpaperVisibility');
        expect(getWallpaperVisibility(legacy, dark) * 100).toBeCloseTo(
          100 - getWallpaperVeil(wallpaperOverlay, dark),
        );
        for (const visibility of [0, 0.37, 1]) {
          const explicit = normalizeAppearanceSettings({
            ...legacy,
            wallpaperVisibility: visibility,
          });
          expect(getWallpaperVisibility(explicit, dark)).toBe(visibility);
        }
      }
      expect(getWallpaperVisibility(normalizeAppearanceSettings({}), dark)).toBe(
        dark ? 0.27 : 0.37,
      );
      expect(normalizeAppearanceSettings({ wallpaperVisibility: null })).not.toHaveProperty(
        'wallpaperVisibility',
      );
    },
  );
  it('accepts a managed custom MP4 and rejects video URLs outside the wallpaper scope', () => {
    const url = `cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`;
    expect(normalizeAppearanceSettings({ customWallpaperUrl: url }).customWallpaperUrl).toBe(url);
    for (const invalid of [
      url + '?x=1',
      url.replace('client-wallpaper', 'blobs'),
      'file:///a.mp4',
    ]) {
      expect(normalizeAppearanceSettings({ customWallpaperUrl: invalid }).customWallpaperUrl).toBe(
        '',
      );
    }
  });
  it.each([false, true])(
    'preserves old veil strengths and extends monotonically to opaque (dark=%s)',
    (dark) => {
      const base = dark ? 65 : 55;
      for (let i = 0; i <= 12; i++)
        expect(getWallpaperVeil(i * 0.05, dark)).toBeCloseTo(base + i * 2);
      expect(getWallpaperVeil(1, dark)).toBe(100);
      expect(getWallpaperVeil(0.8, dark)).toBeGreaterThan(getWallpaperVeil(0.6, dark));
      expect(clampAppearanceWallpaperOverlay(2)).toBe(1);
      expect(clampAppearanceWallpaperOverlay(-1)).toBe(0);
      expect(clampAppearanceWallpaperOverlay(NaN)).toBe(0.2);
      expect(normalizeAppearanceSettings({ wallpaperOverlay: 1 }).wallpaperOverlay).toBe(1);
    },
  );
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
