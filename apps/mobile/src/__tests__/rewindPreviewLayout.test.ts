import { describe, expect, it } from 'vitest';
import { buildRewindPreviewLayout, rewindPreviewMaxHeight } from '@/session/rewindPreviewLayout';

describe('rewindPreviewLayout', () => {
  it('compacts file rows on iPhone SE width', () => {
    expect(buildRewindPreviewLayout({
      fileCount: 8,
      screenWidth: 320,
    })).toEqual({
      compact: true,
      containerMarginHorizontal: 12,
      containerPadding: 12,
      fileRowMinHeight: 30,
      visibleFileCount: 4,
    });
  });

  it('keeps more context visible on modern iPhones', () => {
    expect(buildRewindPreviewLayout({
      fileCount: 8,
      screenWidth: 393,
    })).toEqual({
      compact: false,
      containerMarginHorizontal: 16,
      containerPadding: 16,
      fileRowMinHeight: 32,
      visibleFileCount: 6,
    });
  });

  it('does not invent file rows for history-only previews', () => {
    expect(buildRewindPreviewLayout({
      fileCount: 0,
      screenWidth: 393,
    }).visibleFileCount).toBe(0);
  });

  it('falls back to standard phone width before dimensions are ready', () => {
    expect(buildRewindPreviewLayout({
      fileCount: 3,
      screenWidth: 0,
    })).toMatchObject({
      compact: false,
      containerPadding: 16,
      visibleFileCount: 3,
    });
  });

  it('reserves space for fixed overlays on a short viewport', () => {
    expect(rewindPreviewMaxHeight({
      bottomOverlayHeight: 92,
      screenHeight: 320,
      topOverlayHeight: 58,
    })).toBe(154);
  });

  it('does not produce a negative panel height when overlays consume the viewport', () => {
    expect(rewindPreviewMaxHeight({
      bottomOverlayHeight: 220,
      screenHeight: 320,
      topOverlayHeight: 120,
    })).toBe(0);
  });
});
