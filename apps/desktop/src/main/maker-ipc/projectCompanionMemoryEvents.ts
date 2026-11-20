import type { AgentEvent, Session } from '@cindy/maker-core';

const calls = new WeakMap<Session, Set<string>>();
const tool = 'project_companion_memory';

function isMemoryCall(input: unknown, depth = 0): boolean {
  if (!input || depth > 4) return false;
  if (typeof input === 'string') {
    if (!input.includes(tool)) return false;
    try { return isMemoryCall(JSON.parse(input), depth + 1); } catch { return false; }
  }
  if (typeof input !== 'object') return false;
  const args = input as Record<string, unknown>;
  return args.name === tool || args.tool === tool || isMemoryCall(args.args, depth + 1)
    || isMemoryCall(args.arguments, depth + 1);
}

/** The harness already received the private result. Persist only the fact that notes were used. */
export function projectCompanionMemoryEvent(session: Session, event: AgentEvent): AgentEvent {
  if (!session.projectCompanion || !event.data) return event;
  const data = event.data as Record<string, unknown>;
  const direct = typeof data.toolName === 'string' && (data.toolName === tool
    || data.toolName.endsWith(':' + tool) || data.toolName.endsWith('__' + tool));
  if (event.type === 'tool_use' && (direct || isMemoryCall(data.input))) {
    if (typeof data.toolUseId === 'string') {
      const ids = calls.get(session) ?? new Set<string>();
      ids.add(data.toolUseId);
      calls.set(session, ids);
    }
    return { ...event, data: { toolUseId: data.toolUseId, toolName: data.toolName, input: { name: tool } } };
  }
  if (event.type !== 'tool_result' && event.type !== 'tool_result_full') return event;
  const ids = calls.get(session);
  if (!(typeof data.toolUseId === 'string' && ids?.has(data.toolUseId))
    && !(Array.isArray(data.toolUseIds) && data.toolUseIds.some(id => ids?.has(id)))) return event;
  return { ...event, data: event.type === 'tool_result'
    ? { toolUseIds: data.toolUseIds, summary: tool, isError: data.isError }
    : { toolUseId: data.toolUseId, fullText: tool, isError: data.isError } };
}
