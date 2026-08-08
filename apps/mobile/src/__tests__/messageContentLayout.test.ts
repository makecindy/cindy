import { describe, expect, it } from 'vitest';
import { buildMessageContentLayout } from '@/session/messageContentLayout';

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
