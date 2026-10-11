import { describe, expect, it } from 'vitest';
import pixels from './pixels.cjs';

describe('render probe pixel evidence', () => {
  it('rejects black, backing-only and empty frames', () => {
    expect(pixels.inspectPixels(Buffer.alloc(640 * 480 * 4)).pixelsMatch).toBe(false);
    expect(pixels.inspectPixels(Buffer.alloc(640 * 480 * 4, 80)).pixelsMatch).toBe(false);
    expect(pixels.inspectPixels(Buffer.alloc(0)).pixelsMatch).toBe(false);
  });
  it.each([
    [
      [224, 33, 64],
      [33, 208, 96],
      [48, 96, 224],
    ],
    [
      [206, 56, 70],
      [99, 205, 109],
      [60, 95, 216],
    ],
  ])(
    'accepts distinct fixture swatches across sRGB and display color spaces',
    (red, green, blue) => {
      const bitmap = Buffer.alloc(640 * 480 * 4);
      for (const [x, rgb] of [
        [60, red],
        [160, green],
        [260, blue],
      ]) {
        const offset = (60 * 640 + x) * 4;
        bitmap.set([rgb[2], rgb[1], rgb[0], 255], offset);
      }
      expect(pixels.inspectPixels(bitmap).pixelsMatch).toBe(true);
      bitmap.fill(0, (60 * 640 + 160) * 4, (60 * 640 + 160) * 4 + 4);
      expect(pixels.inspectPixels(bitmap).pixelsMatch).toBe(false);
    },
  );
  it('rejects an unexpected scale factor instead of reading the wrong pixel offsets', () => {
    expect(pixels.inspectPixels(Buffer.alloc(1280 * 960 * 4))).toEqual({
      pixelsMatch: false,
      bitmapBytes: 1280 * 960 * 4,
    });
  });
});
