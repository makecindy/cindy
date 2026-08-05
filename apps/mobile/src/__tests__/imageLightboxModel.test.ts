import { describe, expect, it } from 'vitest';
import {
  LIGHTBOX_DOUBLE_TAP_SCALE,
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  canShareLightboxImage,
  clampLightboxScale,
  clampLightboxTranslation,
  lightboxBackgroundOpacity,
  lightboxInitialIndex,
  lightboxPageIndex,
  lightboxPageLabel,
  nextDoubleTapScale,
  shouldDismissLightbox,
} from '@/session/imageLightboxModel';

describe('imageLightboxModel', () => {
  it('clamps scale into [min, max]', () => {
    expect(clampLightboxScale(0.3)).toBe(LIGHTBOX_MIN_SCALE);
    expect(clampLightboxScale(2)).toBe(2);
    expect(clampLightboxScale(99)).toBe(LIGHTBOX_MAX_SCALE);
  });

  it('clamps translation to the zoomed overflow and locks it at 1x', () => {
    // 1x:无溢出,任何平移都归零
    expect(clampLightboxTranslation(50, 400, 1)).toBe(0);
    // 2x:溢出 = (800-400)/2 = 200
    expect(clampLightboxTranslation(150, 400, 2)).toBe(150);
    expect(clampLightboxTranslation(250, 400, 2)).toBe(200);
    expect(clampLightboxTranslation(-250, 400, 2)).toBe(-200);
  });

  it('dismisses on distance or fling velocity', () => {
    expect(shouldDismissLightbox(121, 0)).toBe(true);
    expect(shouldDismissLightbox(-121, 0)).toBe(true);
    expect(shouldDismissLightbox(20, 900)).toBe(true);
    expect(shouldDismissLightbox(20, 100)).toBe(false);
  });

  it('fades the backdrop with drag progress', () => {
    expect(lightboxBackgroundOpacity(0, 800)).toBe(1);
    expect(lightboxBackgroundOpacity(200, 800)).toBeCloseTo(1 - 0.5 * 0.7);
    expect(lightboxBackgroundOpacity(4000, 800)).toBeCloseTo(0.3);
    expect(lightboxBackgroundOpacity(100, 0)).toBe(1);
  });

  it('double tap toggles between 1x and the zoom-in scale', () => {
    expect(nextDoubleTapScale(1)).toBe(LIGHTBOX_DOUBLE_TAP_SCALE);
    expect(nextDoubleTapScale(LIGHTBOX_DOUBLE_TAP_SCALE)).toBe(LIGHTBOX_MIN_SCALE);
    expect(nextDoubleTapScale(3.7)).toBe(LIGHTBOX_MIN_SCALE);
  });

  it('maps paging offset to a bounded index', () => {
    expect(lightboxPageIndex(0, 400, 3)).toBe(0);
    expect(lightboxPageIndex(410, 400, 3)).toBe(1);
    expect(lightboxPageIndex(9999, 400, 3)).toBe(2);
    expect(lightboxPageIndex(100, 0, 3)).toBe(0);
  });

  it('locates the initial page by url with a safe fallback', () => {
    expect(lightboxInitialIndex(['a', 'b', 'c'], 'b')).toBe(1);
    expect(lightboxInitialIndex(['a'], 'missing')).toBe(0);
    // gallery 键是 trimmed url,initialUrl 来自未 trim 的 payload.media.url:两侧 trim 后匹配
    expect(lightboxInitialIndex(['a', 'b', 'c'], ' b ')).toBe(1);
    expect(lightboxInitialIndex(['a', ' b ', 'c'], 'b')).toBe(1);
  });

  it('hides the page label for single images', () => {
    expect(lightboxPageLabel(0, 1)).toBeNull();
    expect(lightboxPageLabel(1, 5)).toBe('2 / 5');
  });

  it('allows sharing only for file and http(s) uris', () => {
    expect(canShareLightboxImage('file:///cache/a.png')).toBe(true);
    expect(canShareLightboxImage('https://oss.example/a.png')).toBe(true);
    expect(canShareLightboxImage('data:image/png;base64,xxx')).toBe(false);
    expect(canShareLightboxImage(null)).toBe(false);
  });
});
