import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export const MOCK_RESOURCE: string;
export function mockAppHtml(): Promise<string>;
export function createMockAppServer(options?: { instructions?: string }): McpServer;
export function startMockAppServer(options?: { createServer?: () => McpServer }): Promise<{
  url: string;
  sseUrl: string;
  close(): Promise<void>;
}>;
