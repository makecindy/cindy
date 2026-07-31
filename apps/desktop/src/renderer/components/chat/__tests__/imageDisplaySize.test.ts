import { describe, expect, it } from 'vitest';

import { containImageSize } from '../imageDisplaySize';

describe('containImageSize', () => {
  it('fits a viewBox-only SVG ratio inside both bounds', () => {
    const result = containImageSize({ width: 225, height: 150 }, 224, 168);

    expect(result?.width).toBeCloseTo(224);
    expect(result?.height).toBeCloseTo(149.33);
  });

  it('does not upscale a smaller image', () => {
    expect(containImageSize({ width: 120, height: 80 }, 224, 168)).toEqual({
      width: 120,
      height: 80,
    });
  });

  it('rejects empty dimensions or bounds instead of producing NaN styles', () => {
    expect(containImageSize({ width: 0, height: 150 }, 224, 168)).toBeNull();
    expect(containImageSize({ width: 225, height: 150 }, 224, 0)).toBeNull();
  });
});
