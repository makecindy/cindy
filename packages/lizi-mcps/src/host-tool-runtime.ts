import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { XdtHelperToolResult } from './lizi_xdtHelperToolRegistry.js';

/** In-process callers use the very same validated dispatch as MCP call_tool. */
export interface HostToolRuntime {
  describe(name: string): { name: string; category: string } | undefined;
  call(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<XdtHelperToolResult>;
  close(): Promise<void>;
}

export type HostToolMcpServer = McpServer & { hostTools: HostToolRuntime };
