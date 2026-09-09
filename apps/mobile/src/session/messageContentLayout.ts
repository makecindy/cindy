export interface MessageContentLayoutInput {
  screenWidth?: number;
}

export interface MessageContentLayout {
  attachmentGap: number;
  /** 用户消息图片附件的 contain 框(对齐桌面版 user-attached 的 280×180)。 */
  attachmentImageMaxHeight: number;
  attachmentImageMaxWidth: number;
  codePaddingHorizontal: number;
  codePaddingVertical: number;
  compact: boolean;
  diffCardGap: number;
  diffCardPadding: number;
  fileChipIconWidth: number;
  fileChipMaxWidth: number;
  fileChipMinHeight: number;
  imagePreviewHeight: number;
  imagePreviewWidth: number;
  markdownBodyGap: number;
  markdownListGap: number;
  markdownListMarkerWidth: number;
  markdownTableAvailableWidth: number;
  markdownTableCellMinWidth: number;
  mediaGap: number;
  mediaPlaceholderMinHeight: number;
  mediaPreviewWidth: number;
  toolResultMaxLines: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const COMPACT_WIDTH = 360;
const MIN_CONTENT_WIDTH = 280;
const MAX_FILE_CHIP_WIDTH = 228;
const MAX_IMAGE_PREVIEW_WIDTH = 148;
const MAX_MEDIA_PREVIEW_WIDTH = 160;

export function buildMessageContentLayout(input: MessageContentLayoutInput): MessageContentLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const compact = screenWidth <= COMPACT_WIDTH;
  const contentWidth = Math.max(MIN_CONTENT_WIDTH, screenWidth - (compact ? 48 : 64));
  const halfWidth = Math.floor((contentWidth - (compact ? 6 : 8)) / 2);
  const imagePreviewWidth = Math.max(124, Math.min(MAX_IMAGE_PREVIEW_WIDTH, halfWidth));
  const mediaPreviewWidth = Math.max(132, Math.min(MAX_MEDIA_PREVIEW_WIDTH, halfWidth + 8));

  return {
    attachmentGap: compact ? 6 : 8,
    attachmentImageMaxHeight: 180,
    attachmentImageMaxWidth: Math.min(280, contentWidth),
    codePaddingHorizontal: compact ? 10 : 12,
    codePaddingVertical: compact ? 8 : 10,
    compact,
    diffCardGap: compact ? 4 : 8,
    diffCardPadding: compact ? 8 : 10,
    fileChipIconWidth: compact ? 24 : 28,
    fileChipMaxWidth: Math.min(MAX_FILE_CHIP_WIDTH, contentWidth),
    fileChipMinHeight: 32,
    imagePreviewHeight: Math.round(imagePreviewWidth * 0.65),
    imagePreviewWidth,
    markdownBodyGap: compact ? 12 : 14,
    markdownListGap: compact ? 6 : 8,
    markdownListMarkerWidth: compact ? 20 : 24,
    markdownTableAvailableWidth: contentWidth,
    markdownTableCellMinWidth: compact ? 96 : 112,
    mediaGap: compact ? 6 : 8,
    mediaPlaceholderMinHeight: compact ? 84 : 90,
    mediaPreviewWidth,
    toolResultMaxLines: compact ? 6 : 8,
  };
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && typeof value === 'number' && value > 0 ? value : fallback;
}

/**
 * Agent 回复正文的二次测宽:外层 stretch 量到像素宽后钉在内层,避免 iOS UITextView
 * 在不确定宽度下只报出部分高度,LegendList 按偏矮值裁切消息。1px 内抖动忽略,
 * 防止分享勾选栏出现时来回改宽把公式 WebView 打进重挂循环;真实变宽(旋转/分屏)
 * 由外层 stretch 容器继续上报,这里照常更新。
 */
export function nextSettledContentWidth(current: number, next: number): number {
  if (!(next > 0) || Math.abs(current - next) <= 1) return current;
  return next;
}
