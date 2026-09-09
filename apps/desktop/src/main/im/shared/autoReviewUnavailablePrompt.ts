import {
  isAutoReviewUnavailableMetadata,
  type InteractionRequest,
} from '@cindy/maker-core';

/**
 * 文本通道确认提示里的故障说明。硬编码中文，与 Desktop zh-CN 确认卡同句，
 * 不进 renderer locale（见 engineering-conventions.md §5）。
 */
export const IM_AUTO_REVIEW_UNAVAILABLE_PROMPT =
  '自动审批没完成，请确认要不要允许这次操作。';

export function autoReviewUnavailablePromptLine(
  request: InteractionRequest,
): string | null {
  if (request.kind !== 'permission') return null;
  if (!isAutoReviewUnavailableMetadata(request.metadata)) return null;
  return IM_AUTO_REVIEW_UNAVAILABLE_PROMPT;
}
