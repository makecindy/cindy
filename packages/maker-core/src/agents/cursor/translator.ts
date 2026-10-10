import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import { record, type AcpRecord } from './models.js';

/** ACP tool_call_update is a partial patch, not a replacement tool call. */
export class CursorTranslator {
  private tools = new Map<string, AcpRecord>();
  private completedTools = new Set<string>();
  // Cursor todo patches are session state and survive individual prompt turns.
  private todos = new Map<string, AcpRecord>();
  readonly usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };

  constructor(private emit: (event: AgentEvent) => void) {}

  beginTurn(): void {
    this.tools.clear();
    this.completedTools.clear();
    this.usage.tokenUsage = 0;
  }

  updateTodos(raw: unknown, merge: boolean): void {
    if (!Array.isArray(raw)) return;
    if (!merge) this.todos.clear();
    for (const item of raw) {
      const todo = record(item);
      if (typeof todo.id !== 'string' || !todo.id) continue;
      this.todos.set(todo.id, { ...this.todos.get(todo.id), ...todo });
    }
    this.update({ sessionUpdate: 'plan', entries: [...this.todos.values()] });
  }

  update(raw: unknown): void {
    const update = record(raw);
    const event = (type: AgentEvent['type'], data: unknown) => this.emit({ type, data, source: 'cursor' });
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = record(update.content);
        if (content.type === 'text' && typeof content.text === 'string') {
          event(update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking', {
            text: content.text, isFinal: false,
          });
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (typeof update.toolCallId !== 'string' || !update.toolCallId) break;
        const id = update.toolCallId;
        const previous = this.tools.get(id);
        const tool = { ...previous, ...update };
        this.tools.set(id, tool);
        if (!previous || ('rawInput' in update && !('rawInput' in previous))) {
          event('tool_use', {
            toolUseId: id, toolName: cursorToolName(tool),
            input: cursorToolInput(tool),
          });
        }
        if ((tool.status === 'completed' || tool.status === 'failed') && !this.completedTools.has(id)) {
          this.completedTools.add(id);
          const fullText = toolText(tool);
          event('tool_result_full', { toolUseId: id, fullText, isError: tool.status === 'failed' });
          event('tool_result', { summary: tool.status === 'failed' ? 'failed' : 'done', toolUseIds: [id] });
        }
        break;
      }
      case 'plan': {
        if (!Array.isArray(update.entries)) break;
        event('tool_use', { toolUseId: 'cursor-plan', toolName: 'update_plan', input: {
          plan: update.entries.map(record).map(entry => ({
            step: String(entry.content ?? ''), status: entry.status,
          })),
        } });
        event('tool_result_full', { toolUseId: 'cursor-plan', fullText: '', isError: false });
        break;
      }
      case 'usage_update': {
        // ACP used/size describe context occupancy, never per-request billable usage.
        if (finite(update.used)) this.usage.contextTokens = update.used;
        if (finite(update.size)) this.usage.contextWindow = update.size;
        event('status', { ...this.usage, isRunning: true, status: 'Working' });
        break;
      }
    }
  }

  tool(id: unknown): AcpRecord { return typeof id === 'string' ? this.tools.get(id) ?? {} : {}; }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function cursorToolName(tool: AcpRecord): string {
  const names: Record<string, string> = { read: 'Read', edit: 'Edit', execute: 'Bash', search: 'Search' };
  return (typeof tool.kind === 'string' ? names[tool.kind] : undefined)
    ?? (typeof tool.title === 'string' ? tool.title : 'Cursor Tool');
}
export function cursorToolInput(tool: AcpRecord): AcpRecord {
  const raw = record(tool.rawInput);
  return Object.keys(raw).length ? raw : {
    ...(typeof tool.title === 'string' ? { description: tool.title } : {}),
    ...(Array.isArray(tool.locations) ? { locations: tool.locations } : {}),
    ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
  };
}
function toolText(tool: AcpRecord): string {
  if (typeof tool.rawOutput === 'string') return tool.rawOutput;
  const sections: string[] = [];
  if (Array.isArray(tool.content)) for (const raw of tool.content) {
    const item = record(raw);
    if (item.type === 'content') {
      const content = record(item.content);
      if (typeof content.text === 'string') sections.push(content.text);
    } else if (item.type === 'diff') {
      sections.push(JSON.stringify({ path: item.path, oldText: item.oldText, newText: item.newText }));
    }
  }
  if (!sections.length && tool.rawOutput !== undefined) sections.push(JSON.stringify(tool.rawOutput));
  return sections.join('\n');
}
