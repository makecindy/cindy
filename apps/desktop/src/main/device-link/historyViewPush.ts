import { isHistoryDetailTool, hasVisibleHistoryResult } from '@cindy/maker-shared/message-window';
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Conservative classification: interactions, errors and reference-bearing results stay live. */
export function isDeferredHistoryPush(channel: string, payload: unknown, toolName: (id: string) => string): boolean {
  const push = record(payload);
  if (!push) return false;
  if (channel === 'local-db:messages:created') {
    const row = record(push.message);
    if (!row) return false;
    if (row.role === 'thinking') return true;
    const content = record(row.content);
    if (row.role === 'tool_use') return isHistoryDetailTool(String(content?.toolName ?? ''));
    if (row.role !== 'tool_result' || hasVisibleHistoryResult(row.content)) return false;
    return typeof row.toolUseId === 'string' && isHistoryDetailTool(toolName(row.toolUseId));
  }
  if (channel !== 'maker:event') return false;
  const event = record(push.event);
  const data = record(event?.data);
  if (!event || !data || data.isError === true) return false;
  if (event.type === 'thinking') return true;
  if (event.type === 'tool_use') return isHistoryDetailTool(String(data.toolName ?? ''));
  if (event.type !== 'tool_result' && event.type !== 'tool_result_full') return false;
  if ([push.resolvedContent, data.summary, data.fullText].some(hasVisibleHistoryResult)) return false;
  const ids = typeof data.toolUseId === 'string' ? [data.toolUseId] : data.toolUseIds;
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string' && isHistoryDetailTool(toolName(id)));
}

/** Retain tool-start boundaries so a controller can finish the preceding assistant text. */
export function deferredToolBoundary(payload: unknown): unknown | null {
  const push = record(payload);
  const event = record(push?.event);
  const data = record(event?.data);
  return push && event?.type === 'tool_use' && data
    ? { ...push, event: { ...event, data: { toolUseId: data.toolUseId, toolName: data.toolName, input: null } } }
    : null;
}
