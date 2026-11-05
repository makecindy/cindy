import { messageContentToPreview, parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { readMessageSourcePlugin } from '@cindy/maker-shared/message-source';
import type { PluginUiContext, PluginUiScope } from '@cindy/maker-shared';
import { isGhostCallToolName } from '../../shared/ghost.js';
import type { PluginUiRendererSource } from '../../shared/pluginUi.js';

interface SavedRecord { role: string; content: string; toolUseId?: string | null; agentMeta?: string | null }
interface RendererRecord {
  source: PluginUiRendererSource; legacy?: boolean;
  message?: PluginUiContext['message']; tool?: PluginUiContext['tool'];
}
interface Dependencies {
  readMessage(sessionId: string, clientId: string): Promise<SavedRecord | null>;
  readTool(sessionId: string, toolUseId: string): Promise<{ calls: SavedRecord[]; results: SavedRecord[] } | null>;
  resolvePlugin(id: string, namespace?: string | null): string | undefined;
}
function parseJson(value: string | null | undefined): unknown {
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value); } catch { return value; }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Private MCP Apps metadata belongs to its own view, never a renderer. */
function hasPrivateMetadata(value: unknown): boolean {
  const pending = [value]; let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (++visited > 4096) return true;
    if (Object.hasOwn(item, '_meta')) return true;
    const values = Object.values(item);
    if (values.length + pending.length > 4096) return true;
    pending.push(...values);
  }
  return false;
}

/** Storage lookups must themselves reject cleared, rewound and deleted records. */
export function createPluginUiRendererRecords(deps: Dependencies) {
  return {
    async read(scope: PluginUiScope): Promise<RendererRecord | null> {
      if (scope.kind === 'message') {
        const row = await deps.readMessage(scope.sessionId, scope.messageClientId);
        if (!row || (row.role !== 'user' && row.role !== 'assistant')) return null;
        const source = readMessageSourcePlugin(parseJson(row.agentMeta));
        const instanceId = source && deps.resolvePlugin(source.pluginId);
        if (!instanceId) return null;
        const content = parseJson(row.content), value = record(content);
        const text = typeof content === 'string' ? content : typeof value?.text === 'string' ? value.text : undefined;
        return { source: { kind: 'plugin', instanceId },
          ...(text !== undefined ? { message: { id: scope.messageClientId, role: row.role, text } } : {}) };
      }
      if (scope.kind !== 'tool') return null;
      const rows = await deps.readTool(scope.sessionId, scope.toolUseId);
      if (!rows || rows.calls.length !== 1 || rows.calls[0].role !== 'tool_use') return null;
      const call = rows.calls[0];
      const parsed = parseMessageToolUse({ ...call, content: parseJson(call.content) });
      if (parsed.toolUseId !== scope.toolUseId || !parsed.toolName) return null;
      let source: PluginUiRendererSource;
      if (isGhostCallToolName(parsed.toolName)) {
        const input = record(parsed.input), namespace = input?.namespace;
        if (typeof input?.ghost_id !== 'string' || typeof input.tool !== 'string' || !input.tool ||
            (namespace !== undefined && namespace !== null && typeof namespace !== 'string')) return null;
        const instanceId = deps.resolvePlugin(input.ghost_id, namespace as string | null | undefined);
        if (!instanceId) return null;
        source = { kind: 'plugin', instanceId, name: input.tool };
      } else source = { kind: 'tool', name: parsed.toolName };
      const results = rows.results.filter(row => row.role === 'tool_result' && row.toolUseId === scope.toolUseId);
      const result = results.length === 1 ? parseJson(results[0].content) : undefined;
      const decoded = typeof result === 'string' ? parseJson(result) : result;
      const legacy = typeof record(decoded)?.xdt_card_id === 'string';
      return { source, ...(legacy ? { legacy: true } : {}), tool: { id: scope.toolUseId, name: parsed.toolName,
        input: parsed.input, status: results.length === 1 ? 'settled' : 'unknown',
        ...(result !== undefined && !hasPrivateMetadata(decoded) ? { result: messageContentToPreview(result) } : {}) } };
    },
  };
}
