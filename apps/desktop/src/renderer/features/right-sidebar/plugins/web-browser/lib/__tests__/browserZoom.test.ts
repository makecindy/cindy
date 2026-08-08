import { describe, expect, it } from 'vitest';

import {
  formatBrowserZoomFactor,
  nextBrowserZoomFactor,
  normalizeBrowserZoomFactor,
  previousBrowserZoomFactor,
} from '../browserZoom';

describe('browserZoom', () => {
  it('normalizes persisted values to the nearest supported step', () => {
    expect(normalizeBrowserZoomFactor(undefined)).toBe(1);
    expect(normalizeBrowserZoomFactor(Number.NaN)).toBe(1);
    expect(normalizeBrowserZoomFactor(1.24)).toBe(1.25);
  });

  it('steps through the supported range and stops at the bounds', () => {
    expect(previousBrowserZoomFactor(1)).toBe(0.9);
    expect(nextBrowserZoomFactor(1)).toBe(1.1);
    expect(previousBrowserZoomFactor(0.25)).toBeNull();
    expect(nextBrowserZoomFactor(5)).toBeNull();
  });

  it('formats the normalized percentage', () => {
    expect(formatBrowserZoomFactor(1.25)).toBe('125%');
  });
});
