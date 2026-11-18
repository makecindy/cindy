import type { McpTransport } from './customMcp';

/** Public suggestions only; credential values stay in the existing Settings form. */
export interface McpSetupProposal {
  name?: string;
  url?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Names only. The user supplies all values in the native form. */
  envKeys?: string[];
}

export interface McpSetupRequest {
  kind: 'mcp_setup';
  requestId: string;
  proposal: McpSetupProposal;
}

export type McpSetupResult =
  | { status: 'saved'; serverId: string }
  | { status: 'cancelled' };
