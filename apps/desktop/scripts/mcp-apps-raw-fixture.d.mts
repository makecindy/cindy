import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export const RAW_RESOURCE: string;
export const RAW_APP_HTML: string;
export interface RawAppOptions {
  encoding?: 'text' | 'blob';
  metadata?: 'list' | 'read';
  legacyUri?: boolean;
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
}
export function createRawAppServer(options?: RawAppOptions): McpServer;
