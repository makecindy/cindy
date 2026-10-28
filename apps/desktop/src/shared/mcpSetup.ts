import type { CustomMcpConfig, McpTransport } from './customMcp.js';

/** Host-owned metadata only. Never add credential values to these snapshots. */
export type McpSetupPhase =
  'awaiting_user' | 'verifying' | 'committing' | 'saved' | 'cancelled' | 'expired';
export type McpSetupError =
  | 'INVALID_CONFIG'
  | 'INSECURE_ENDPOINT'
  | 'AUTH_REJECTED'
  | 'CONNECT_TIMEOUT'
  | 'TLS_FAILED'
  | 'PROTOCOL_MISMATCH'
  | 'REDIRECT_REQUIRES_REVIEW'
  | 'RESPONSE_LIMIT'
  | 'SECRET_STORE_UNAVAILABLE'
  | 'SECRET_UNREADABLE'
  | 'CONFIG_CONFLICT'
  | 'SAVE_FAILED'
  | 'OWNER_CHANGED'
  | 'REQUEST_EXPIRED';
export interface McpSetupDraft {
  name: string;
  url: string;
  transport: McpTransport;
  headerNames: string[];
}
export interface McpSetupResult {
  operationId: string;
  status: McpSetupPhase;
  errorCode?: McpSetupError;
  serverId?: string;
  verification?: 'passed';
  activation?: 'next_session' | 'refreshing' | 'deferred' | 'pending';
}
export interface McpSetupSnapshot extends McpSetupResult {
  kind: 'mcp_setup';
  requestId: string;
  revision: number;
  expiresAt: number;
  draft: McpSetupDraft;
  deviceName?: string;
}
export interface McpSetupProposal {
  name?: string;
  url?: string;
  transport?: McpTransport;
}
export interface McpSetupDraftUpdate {
  requestId: string;
  expectedRevision: number;
  draft: McpSetupDraft;
}
/** Only the trusted local IPC accepts these values; never a model or remote tool. */
export interface McpSetupSubmission {
  requestId: string;
  expectedRevision: number;
  submissionId: string;
  token: string;
  headers: Record<string, string>;
}
export interface CustomMcpSummary extends CustomMcpConfig {
  revision: number;
  hasToken: boolean;
  credentialState: 'absent' | 'saved' | 'unavailable';
  urlRedacted?: boolean;
}
export interface CustomMcpMutation extends CustomMcpConfig {
  token?: string;
  tokenAction?: 'keep' | 'replace' | 'clear';
  keepHeaderNames?: string[];
  expectedRevision?: number;
  keepUrl?: boolean;
}
export const MCP_SETUP_INVOKE = {
  UPDATE: 'mcp:setup:update',
  SUBMIT: 'mcp:setup:submit',
  CANCEL: 'mcp:setup:cancel',
  ACTIVATE: 'mcp:setup:activate',
} as const;
