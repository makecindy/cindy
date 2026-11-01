import type { McpTransport } from './customMcp';

/** Public suggestions only; credential values stay in the existing Settings form. */
export interface McpSetupProposal {
  name?: string;
  url?: string;
  transport?: McpTransport;
}

export interface McpSetupRequest {
  kind: 'mcp_setup';
  requestId: string;
  proposal: McpSetupProposal;
}

export type McpSetupResult =
  | { status: 'saved'; serverId: string }
  | { status: 'cancelled' };
