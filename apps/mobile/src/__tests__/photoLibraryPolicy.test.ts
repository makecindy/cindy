import { describe, expect, it } from 'vitest';
import { canBrowsePhotoLibraryDirectly } from '@/session/photoLibraryPolicy';

describe('photo library policy', () => {
  it('keeps direct photo-library browsing on iOS', () => {
    expect(canBrowsePhotoLibraryDirectly('ios')).toBe(true);
  });

  it('requires Android and web to use system pickers instead', () => {
    expect(canBrowsePhotoLibraryDirectly('android')).toBe(false);
    expect(canBrowsePhotoLibraryDirectly('web')).toBe(false);
  });
});
