import {
  isKnownTextOnlyModel,
  KNOWN_TEXT_ONLY_MODEL_IDS,
  normalizeSubagentModelId,
} from '../../shared/subagentModelSettings.js';

export { KNOWN_TEXT_ONLY_MODEL_IDS as TEXT_ONLY_MODEL_IDS };

export const VISION_FALLBACK_SETUP_REMINDER =
  '当前模型不支持图片。请前往设置 → 工具 → 图片请求视觉兜底模型，选择支持图片的模型后重试。';

export function isTextOnlyModel(model: string): boolean {
  return isKnownTextOnlyModel(model);
}

export function configuredVisionFallbackModel(configured: unknown): string | null {
  return normalizeSubagentModelId(configured);
}

export function anthropicRequestBodyContainsImage(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== 'user') continue;
    if (
      Array.isArray(content)
      && content.length > 0
      && content.every((part) =>
        part && typeof part === 'object' && !Array.isArray(part)
        && (part as { type?: unknown }).type === 'tool_result',
      )
    ) continue;
    return Array.isArray(content) && content.some((part) =>
      part && typeof part === 'object' && !Array.isArray(part)
      && (part as { type?: unknown }).type === 'image',
    );
  }
  return false;
}
