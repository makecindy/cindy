import type { AgentMcpServerToolsReport, AgentMcpServerToolsState } from '../base-agent.js';

/** Subset of the SDK's `McpServerStatus` this report reads. */
export interface ClaudeMcpServerStatusEntry {
  name: string;
  status: string;
  tools?: Array<{ name: string; description?: string }>;
}

const ENGINE_STATES = new Set<string>(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);

/** Map `query.mcpServerStatus()` to one server's report; failure text is not forwarded. */
export function claudeMcpServerToolsReport(
  statuses: readonly ClaudeMcpServerStatusEntry[],
  serverName: string,
): AgentMcpServerToolsReport {
  const server = statuses.find((entry) => entry.name === serverName);
  if (!server) return { state: 'not-mounted', tools: [] };
  const tools = (server.tools ?? [])
    .filter((tool) => typeof tool?.name === 'string' && tool.name)
    .map((tool) => typeof tool.description === 'string' && tool.description
      ? { name: tool.name, description: tool.description }
      : { name: tool.name });
  const state: AgentMcpServerToolsState = ENGINE_STATES.has(server.status)
    ? server.status as AgentMcpServerToolsState
    : tools.length > 0 ? 'connected' : 'no-tools';
  return { state, tools: state === 'connected' ? tools : [] };
}
