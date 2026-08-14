import {
  DEFAULT_VISION_FALLBACK_MODEL,
  normalizeSubagentModelId,
} from '../../shared/subagentModelSettings.js';

export { DEFAULT_VISION_FALLBACK_MODEL };

export const TEXT_ONLY_MODEL_IDS = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek-v4-flash',
  'z-ai/glm-5.1',
  'glm-5.1',
  'z-ai/glm-5.2',
  'glm-5.2',
  'moonshotai/kimi-k2.6',
  'kimi-k2.6',
  'qwen/qwen3.7-max',
  'qwen3.7-max',
]);

export function isTextOnlyModel(model: string): boolean {
  return TEXT_ONLY_MODEL_IDS.has(model.replace(/\[1m\]$/, ''));
}

export function configuredVisionFallbackModel(configured: unknown): string {
  return normalizeSubagentModelId(configured) ?? DEFAULT_VISION_FALLBACK_MODEL;
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
    return Array.isArray(content) && content.some((part) =>
      part && typeof part === 'object' && !Array.isArray(part)
      && (part as { type?: unknown }).type === 'image',
    );
  }
  return false;
}
