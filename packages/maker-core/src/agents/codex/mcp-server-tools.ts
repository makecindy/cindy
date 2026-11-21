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
    const inputSchema = tool && typeof tool === 'object' ? (tool as { inputSchema?: unknown }).inputSchema : undefined;
    return { name, ...(typeof description === 'string' && description ? { description } : {}),
      ...(inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema) ? { inputSchema: inputSchema as Record<string, unknown> } : {}) };
  });
  // A catalog probe may successfully discover tools even though this thread's
  // exact client failed startup. Only the native thread state proves readiness.
  switch (server.runtimeStatus) {
    case 'failed': return { state: 'failed', tools: [] };
    // Explicit null means the current configuration has no runtime yet;
    // only an absent field may use the older-runtime catalog fallback.
    case null:
    case 'notStarted':
    case 'starting': return { state: 'pending', tools: [] };
    case 'authenticationRequired': return { state: 'needs-auth', tools: [] };
    case 'cancelled':
    case 'disabled': return { state: 'disabled', tools: [] };
  }
  if (Object.hasOwn(server, 'runtimeStatus') && server.runtimeStatus !== 'connected') return { state: 'pending', tools: [] };
  if (tools.length > 0) return { state: 'connected', tools };
  // Old runtimes have no thread state; an empty map stays ambiguous.
  return { state: server.authStatus === 'notLoggedIn' ? 'needs-auth' : 'no-tools', tools: [] };
}
