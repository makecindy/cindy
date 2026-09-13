/** Cindy provider policies, consolidated from codex-proxy-host. Route selection stays in the host. */
import { isPlainObject } from "../object";

export function seedToolChoiceReferencesRemovedTool(
  toolChoice: unknown,
  tools: Record<string, unknown>[],
): boolean {
  if (!isPlainObject(toolChoice) || typeof toolChoice.type !== 'string') return false;

  return !tools.some((tool) => {
    if (tool.type !== toolChoice.type) return false;
    if (toolChoice.type !== 'function') return true;
    return typeof toolChoice.name === 'string' && tool.name === toolChoice.name;
  });
}

export function sanitizeByteDanceSeedTools(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.tools)) return null;

  let changed = false;
  const tools: Record<string, unknown>[] = [];
  for (const tool of body.tools) {
    if (!isPlainObject(tool)) {
      changed = true;
      continue;
    }
    if (tool.type === 'function') {
      tools.push(tool);
      continue;
    }
    if (tool.type === 'web_search') {
      // Seed cannot represent Codex's cache-only search policy. Dropping the
      // tool preserves the caller's explicit prohibition on live web access.
      if (tool.external_web_access === false) {
        changed = true;
        continue;
      }
      tools.push({ type: 'web_search' });
      if (Object.keys(tool).length !== 1) changed = true;
      continue;
    }
    changed = true;
  }
  changed ||= tools.length === 0 && (body.tool_choice !== undefined || body.parallel_tool_calls !== undefined);
  if (!changed) return null;

  const next: Record<string, unknown> = { ...body };
  if (tools.length > 0) {
    next.tools = tools;
    if (seedToolChoiceReferencesRemovedTool(next.tool_choice, tools)) next.tool_choice = 'auto';
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

export function stripEmptyResponseMessage(item: unknown): { item: unknown; changed: boolean } | null {
  if (!isPlainObject(item) || item.type !== 'message') return { item, changed: false };
  if (item.content === '') return null;
  if (!Array.isArray(item.content)) return { item, changed: false };

  const content = item.content.filter((part) => !(
    isPlainObject(part) &&
    (part.type === 'input_text' || part.type === 'output_text') &&
    part.text === ''
  ));
  if (content.length === 0) return null;
  return content.length === item.content.length
    ? { item, changed: false }
    : { item: { ...item, content }, changed: true };
}

export function normalizeByteDanceSeedInput(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.input)) return null;

  let changed = false;
  const input: unknown[] = [];
  for (const item of body.input) {
    const normalized = stripEmptyResponseMessage(item);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (normalized.changed) changed = true;

    const nextItem = normalized.item;
    if (
      isPlainObject(nextItem) &&
      nextItem.type === 'message' &&
      nextItem.role === 'assistant' &&
      typeof nextItem.status !== 'string'
    ) {
      changed = true;
      input.push({ ...nextItem, status: 'completed' });
      continue;
    }
    input.push(nextItem);
  }
  return changed ? { ...body, input } : null;
}

export function sanitizeByteDanceSeedReasoning(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!isPlainObject(body.reasoning) || !('summary' in body.reasoning)) {
    return null;
  }

  const reasoning = { ...body.reasoning };
  delete reasoning.summary;

  const next: Record<string, unknown> = { ...body };
  if (Object.keys(reasoning).length > 0) next.reasoning = reasoning;
  else delete next.reasoning;
  return next;
}
