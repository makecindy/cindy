import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry, XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload } from './_payload.js';

export type McpGatewayRequest =
  | { action: 'list'; server: string; cursor?: string }
  | { action: 'call'; server: string; tool: string; arguments: Record<string, unknown> };
export type McpGatewayCallback = (context: LiziMcpSessionContext, request: McpGatewayRequest,
  signal?: AbortSignal) => Promise<XdtHelperToolResult>;

/** Stable discovery/call entry: new connections do not require harness restart. */
export function registerMcpGatewayTools(registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext, invoke: McpGatewayCallback): void {
  const server = z.string().regex(/^custom_[a-z0-9_-]{1,33}$/);
  const run = (request: McpGatewayRequest, signal?: AbortSignal) => {
    const context = getContext();
    if (!context.sessionId || !context.sessionInstanceId || context.remoteHostId || context.mcpCallerKind !== 'root') {
      return Promise.resolve(errorPayload('CAPABILITY_NOT_AVAILABLE', 'Use the local parent Desktop task.'));
    }
    return invoke(context, request, signal);
  };
  registry.register({
    name: 'list_mcp_tools', category: 'auth',
    description: 'Discover tools for one saved custom MCP using the current task identity. Works immediately after request_mcp_setup in this same turn, even if native discovery says not-mounted. Use the exact saved serverId. Returns actual schemas and an optional nextCursor; never ask the owner to reinstall or send continue just to load tools.',
    inputShape: { server, cursor: z.string().optional() },
    handler: (args, signal) => run({ action: 'list', ...args } as McpGatewayRequest, signal),
  });
  registry.register({
    name: 'call_mcp_tool', category: 'auth',
    description: 'Call a tool discovered with list_mcp_tools through the same task, including immediately after installation. Supply the real serverId, tool name and arguments. This is an external MCP invocation and must use normal per-call approval; it does not inherit trusted helper approval. Continue the original question with the result. Do not pass credentials here.',
    inputShape: { server, tool: z.string().min(1).max(256), arguments: z.record(z.string(), z.unknown()) },
    handler: (args, signal) => run({ action: 'call', ...args } as McpGatewayRequest, signal),
  });
}
