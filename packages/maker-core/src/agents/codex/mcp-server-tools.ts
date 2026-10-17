import type { AgentMcpServerToolsReport } from '../base-agent.js';
import {
  Method,
  type CodexMcpServerStatus,
  type CodexMcpServerStatusListResponse,
} from './app-server/protocol.js';

const MAX_STATUS_PAGES = 5;

type StatusRequest = <T>(
  method: string,
  params: Record<string, unknown>,
  opts: { timeoutMs: number },
) => Promise<T>;

/**
 * Read one MCP server's tools from this thread's own MCP status. The shared
 * app-server's process-level list is not evidence for a thread, so `threadId`
 * is always sent. Read-only: never starts a server or calls its tools.
 */
export async function readCodexThreadMcpServerTools(
  request: StatusRequest,
  threadId: string,
  serverName: string,
  timeoutMs = 5_000,
): Promise<AgentMcpServerToolsReport> {
  const deadline = Date.now() + timeoutMs;
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_STATUS_PAGES; page++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Codex MCP status timed out');
    const status: CodexMcpServerStatusListResponse = await request<CodexMcpServerStatusListResponse>(
      Method.McpServerStatusList,
      { cursor, limit: 100, detail: 'toolsAndAuthOnly', threadId },
      { timeoutMs: remainingMs },
    );
    const server = status.data.find((entry) => entry.name === serverName);
    if (server) return reportFromCodexStatus(server);
    cursor = status.nextCursor;
    if (cursor === null) return { state: 'not-mounted', tools: [] };
    if (seenCursors.has(cursor)) throw new Error('Codex MCP status pagination repeated a cursor');
    seenCursors.add(cursor);
  }
  throw new Error(`Codex MCP status pagination exceeded ${MAX_STATUS_PAGES} pages`);
}

function reportFromCodexStatus(server: CodexMcpServerStatus): AgentMcpServerToolsReport {
  const tools = Object.entries(server.tools ?? {}).map(([name, tool]) => {
    const description = tool && typeof tool === 'object'
      ? (tool as { description?: unknown }).description
      : undefined;
    return typeof description === 'string' && description ? { name, description } : { name };
  });
  if (tools.length > 0) return { state: 'connected', tools };
  // Codex lists configured servers even when their startup failed and reports
  // no per-server startup state, so an empty tool map stays ambiguous.
  return { state: server.authStatus === 'notLoggedIn' ? 'needs-auth' : 'no-tools', tools: [] };
}
