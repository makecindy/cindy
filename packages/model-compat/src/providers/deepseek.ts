/** Cindy provider policies, consolidated from codex-proxy-host. Route selection stays in the host. */
import { isPlainObject } from "../object";

export const DEEPSEEK_V4_MODELS = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
]);

export const DEEPSEEK_V4_SUPPORTED_CUSTOM_TOOL_NAMES = new Set(['apply_patch']);

/**
 * Any DeepSeek-family model id. Official gateway entries carry a vendor prefix
 * ("deepseek/deepseek-v4-pro"), but custom-provider entries often spell the bare
 * model name ("deepseek-flash", #8559) and variants add suffixes — they all
 * share the same custom-tool restriction, so matching cannot depend on the
 * exact catalog id. Case-insensitive: custom-provider projection keeps the
 * upstream's mixed-case ids verbatim ("DeepSeek-V4-Pro").
 */
const DEEPSEEK_MODEL_ID_PATTERN = /(?:^|\/)deepseek(?:[-_./]|$)/i;

export function isDeepSeekModelId(model: string): boolean {
  return DEEPSEEK_MODEL_ID_PATTERN.test(model);
}

export function deepSeekToolChoiceReferencesRemovedCustomTool(
  toolChoice: unknown,
  tools: readonly unknown[],
): boolean {
  if (!isPlainObject(toolChoice) || toolChoice.type !== 'custom' || typeof toolChoice.name !== 'string') {
    return false;
  }
  return !tools.some((tool) =>
    tool === toolChoice.name ||
    (isPlainObject(tool) && tool.type === 'custom' && tool.name === toolChoice.name),
  );
}

export function sanitizeDeepSeekV4CustomTools(body: unknown): Record<string, unknown> | null {
  if (!isPlainObject(body)) return null;
  if (typeof body.model !== 'string' || !isDeepSeekModelId(body.model)) return null;
  if (!Array.isArray(body.tools)) return null;

  let changed = false;
  const tools: unknown[] = [];
  for (const tool of body.tools) {
    const customToolName =
      typeof tool === 'string'
        ? tool
        : isPlainObject(tool) && tool.type === 'custom' && typeof tool.name === 'string'
          ? tool.name
          : null;
    if (customToolName !== null && !DEEPSEEK_V4_SUPPORTED_CUSTOM_TOOL_NAMES.has(customToolName)) {
      changed = true;
      continue;
    }
    tools.push(tool);
  }
  if (!changed) return null;

  const next: Record<string, unknown> = { ...body };
  if (tools.length > 0) {
    next.tools = tools;
    if (deepSeekToolChoiceReferencesRemovedCustomTool(next.tool_choice, tools)) next.tool_choice = 'auto';
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}
