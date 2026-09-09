import { describe, expect, it } from 'vitest';
import { buildMessageContentLayout, nextSettledContentWidth } from '@/session/messageContentLayout';

describe('messageContentLayout', () => {
  it('compacts attachment and markdown content for iPhone SE width', () => {
    expect(buildMessageContentLayout({ screenWidth: 320 })).toEqual({
      attachmentGap: 6,
      attachmentImageMaxHeight: 180,
      attachmentImageMaxWidth: 280,
      codePaddingHorizontal: 10,
      codePaddingVertical: 8,
      compact: true,
      diffCardGap: 4,
      diffCardPadding: 8,
      fileChipIconWidth: 24,
      fileChipMaxWidth: 228,
      fileChipMinHeight: 32,
      imagePreviewHeight: 89,
      imagePreviewWidth: 137,
      markdownBodyGap: 12,
      markdownListGap: 6,
      markdownListMarkerWidth: 20,
      markdownTableAvailableWidth: 280,
      markdownTableCellMinWidth: 96,
      mediaGap: 6,
      mediaPlaceholderMinHeight: 84,
      mediaPreviewWidth: 145,
      toolResultMaxLines: 6,
    });
  });

  it('keeps regular media cards on modern iPhone width', () => {
    expect(buildMessageContentLayout({ screenWidth: 393 })).toMatchObject({
      attachmentImageMaxHeight: 180,
      attachmentImageMaxWidth: 280,
      compact: false,
      fileChipMaxWidth: 228,
      imagePreviewHeight: 96,
      imagePreviewWidth: 148,
      markdownTableAvailableWidth: 329,
      markdownTableCellMinWidth: 112,
      mediaPreviewWidth: 160,
      toolResultMaxLines: 8,
    });
  });

  it('falls back to standard phone width before dimensions are ready', () => {
    expect(buildMessageContentLayout({ screenWidth: 0 })).toMatchObject({
      compact: false,
      imagePreviewWidth: 148,
      mediaPreviewWidth: 160,
    });
  });
});

describe('nextSettledContentWidth', () => {
  it('pins the first positive measured width and ignores sub-pixel jitter', () => {
    expect(nextSettledContentWidth(0, 0)).toBe(0);
    expect(nextSettledContentWidth(0, 360)).toBe(360);
    expect(nextSettledContentWidth(360, 361)).toBe(360);
    expect(nextSettledContentWidth(360, 359)).toBe(360);
  });

  it('updates when the container really changes width', () => {
    expect(nextSettledContentWidth(360, 328)).toBe(328);
    expect(nextSettledContentWidth(328, 390)).toBe(390);
  });
});
