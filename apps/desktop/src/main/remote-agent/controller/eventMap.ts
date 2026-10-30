/**
 * 来自对方电脑的 Agent 事件在本机的改写。
 *
 * Claude Code 的自带文件与命令工具在对方电脑上由 Cindy 工具(`mcp__cindy_exec__Bash` 等)顶替，
 * 本机界面、记录与统计看到的仍是自带工具名(Bash / Read / Edit …)，和本机任务一样渲染。
 * 供应商分享的受邀者任务里 WebFetch 也由本机提供，同样改回自带工具名。
 */
import type { AgentEvent, AgentKind } from '@cindy/maker-core';

const EXEC_PREFIX = 'mcp__cindy_exec__';
const EXEC_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'WebFetch']);

export function builtinToolName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(EXEC_PREFIX)) return null;
  const builtin = name.slice(EXEC_PREFIX.length);
  return EXEC_TOOLS.has(builtin) ? builtin : null;
}

function renameField(data: unknown, field: string): unknown {
  if (!data || typeof data !== 'object') return data;
  const record = data as Record<string, unknown>;
  const builtin = builtinToolName(record[field]);
  return builtin ? { ...record, [field]: builtin } : data;
}

export function mapClaudeHostedEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'tool_use':
      return { ...event, data: renameField(event.data, 'toolName') };
    case 'agent_task_update':
      return { ...event, data: renameField(event.data, 'lastToolName') };
    case 'interaction_request':
      return { ...event, data: renameField(event.data, 'toolName') };
    default:
      return event;
  }
}

export function remoteAgentEventMapper(kind: AgentKind): ((event: AgentEvent) => AgentEvent) | undefined {
  return kind === 'claude-code' ? mapClaudeHostedEvent : undefined;
}
