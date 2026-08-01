import { describe, expect, it } from 'vitest';

import { isImagePath, isLightboxImagePath } from '../features/cc-agent/workdir-browse/lib/imageExt';

describe('workdir-browse image extensions', () => {
  it('recognizes ordinary bitmap image paths case-insensitively', () => {
    expect(isImagePath('assets/icon.png')).toBe(true);
    expect(isImagePath('assets/photo.JPG')).toBe(true);
    expect(isImagePath('assets/anim.GIF')).toBe(true);
    expect(isImagePath('assets/preview.webp')).toBe(true);
    expect(isImagePath('assets/win/icon.ICO')).toBe(true);
    expect(isImagePath('assets/bitmap.bmp')).toBe(true);
  });

  it('keeps svg and unsupported binaries out of the image preview path', () => {
    expect(isImagePath('assets/logo.svg')).toBe(false);
    expect(isImagePath('assets/archive.zip')).toBe(false);
    expect(isImagePath('README')).toBe(false);
  });

  it('includes svg in the full-screen lightbox path', () => {
    expect(isLightboxImagePath('assets/logo.SVG')).toBe(true);
    expect(isLightboxImagePath('assets/photo.png')).toBe(true);
    expect(isLightboxImagePath('assets/archive.zip')).toBe(false);
  });
});
