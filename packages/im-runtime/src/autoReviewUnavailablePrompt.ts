import {
  AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT,
  autoReviewReasonFromMetadata,
  isAutoReviewUnavailableMetadata,
  type InteractionRequest,
} from "@cindy/maker-core";
import { describePermissionAction } from "@cindy/maker-shared/interaction";

/**
 * 文本通道确认提示里的故障说明。硬编码中文，与 Desktop zh-CN 确认卡同句，
 * 不进 renderer locale（见 engineering-conventions.md §5）。
 */
export const IM_AUTO_REVIEW_UNAVAILABLE_PROMPT =
  "自动审批没完成，请确认要不要允许这次操作。";

export function autoReviewUnavailablePromptLine(
  request: InteractionRequest,
): string | null {
  if (request.kind !== "permission") return null;
  if (isAutoReviewUnavailableMetadata(request.metadata)) return IM_AUTO_REVIEW_UNAVAILABLE_PROMPT;
  const reason = autoReviewReasonFromMetadata(request.metadata);
  return reason ? `自动审批需要你决定：${reason}` : null;
}

/** Remove the English fallback sentence when the text channel already provides its Chinese copy. */
export function permissionPromptDescription(request: InteractionRequest): string | undefined {
  if (request.kind !== 'permission' || !request.description) return undefined;
  if (!request.description.endsWith(AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT)) return request.description;
  return request.description.slice(0, -AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT.length).trim() || undefined;
}

const TEXT_PERMISSION_PREVIEW_MAX = 800;

/** Describe the concrete operation shown in text-channel approval prompts. */
export function permissionOperationPreview(request: InteractionRequest): string {
  if (request.kind !== 'permission') return '';
  if (!request.input || Object.keys(request.input).length === 0) return '';
  let text: string;
  try {
    const action = describePermissionAction(request.toolName, request.input ?? {});
    text = action.kind === 'tool' ? JSON.stringify(request.input ?? {}, null, 2) : action.preview;
  } catch {
    return '<无法序列化>';
  }
  if (!text) return '';
  const clipped = text.length > TEXT_PERMISSION_PREVIEW_MAX
    ? `${text.slice(0, TEXT_PERMISSION_PREVIEW_MAX)}\n…（已截断）` : text;
  return clipped.replaceAll('`', '\\u0060');
}
