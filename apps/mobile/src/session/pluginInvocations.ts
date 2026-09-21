import { parseMessageToolUse, type MessageToolResultPairing } from '@cindy/maker-shared/message-normalize';
import type { RemoteMessage } from './types';

export interface PluginInvocation {
  id: string;
  name: string;
  tools: string[];
  hasPendingCalls: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === 'string' && value.length <= 256 ? value : undefined;

/** Read only the documented MCP text envelope, never arbitrary nested plugin data. */
function infoName(raw: string | undefined, id: string): string | undefined {
  if (!raw) return;
  try {
    let value: unknown = JSON.parse(raw);
    for (let depth = 0; depth < 3; depth++) {
      const obj = record(value);
      const ghost = record(obj?.ghost);
      if (obj?.ok === true && ghost?.id === id) return text(ghost.name);
      const content = obj?.content;
      if (!Array.isArray(content) || content.length !== 1) return;
      const block = record(content[0]);
      if (block?.type !== 'text' || typeof block.text !== 'string') return;
      value = JSON.parse(block.text);
    }
  } catch {
    // Old hosts truncate discovery after the identity prefix. Only accept that
    // exact envelope prefix, and decode each complete JSON string independently.
    const prefix = /^\s*\{\s*"ok"\s*:\s*true\s*,\s*"ghost"\s*:\s*\{\s*"id"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"name"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw);
    if (prefix) {
      try { if (JSON.parse(prefix[1]) === id) return text(JSON.parse(prefix[2])); } catch { /* malformed */ }
    }
  }
}

/** Derive annotations from actual calls, not words in user prose. Steers stay in their owner turn. */
export function collectPluginInvocations(
  messages: readonly RemoteMessage[], pairing: MessageToolResultPairing<RemoteMessage>,
): Map<string, PluginInvocation[]> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'tool_use') continue;
    const tool = parseMessageToolUse(message);
    const id = text(record(tool.input)?.ghost_id);
    if (!id || !/(?:^|:|__)ghost_info$/.test(tool.toolName)) continue;
    const raw = pairing.resultContentFor(message, tool);
    const name = infoName(raw, id);
    if (name) names.set(id, name);
  }
  const turns = new Map<string, PluginInvocation[]>();
  let owner: string | undefined;
  for (const message of messages) {
    if (message.role === 'user' && message.agentMeta?.delivery !== 'steer') {
      owner = message.clientId || message.id;
      continue;
    }
    if (!owner || message.role !== 'tool_use' || message.agentMeta?.parentUuid) continue;
    const tool = parseMessageToolUse(message);
    if (!/(?:^|:|__)ghost_call$/.test(tool.toolName)) continue;
    const input = record(tool.input);
    const id = text(input?.ghost_id);
    if (!id || input?.grant_only === true) continue;
    const calls = turns.get(owner) ?? [];
    let plugin = calls.find((call) => call.id === id);
    if (!plugin) { plugin = { id, name: names.get(id) ?? id, tools: [], hasPendingCalls: false }; calls.push(plugin); }
    // Known IDs must pair exactly: an adjacent result may belong to another
    // concurrent plugin. Legacy ID-less calls retain the existing pairing fallback.
    const settled = tool.toolUseId
      ? pairing.resultByToolUseId.has(tool.toolUseId)
      : pairing.hasResultFor(message, tool);
    plugin.hasPendingCalls ||= !settled;
    const name = text(input?.tool);
    if (name && !plugin.tools.includes(name)) plugin.tools.push(name);
    turns.set(owner, calls);
  }
  return turns;
}
