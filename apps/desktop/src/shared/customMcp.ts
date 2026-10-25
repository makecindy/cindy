/**
 * customMcp.ts (shared, 跨进程)
 * ---------------------------------------------------------------------------
 * 用户自定义 MCP 服务器配置的类型 SSoT —— main（store / provider）、preload、renderer 共用。
 *
 * 仅远程 transport（http/sse）。bearer token 不在本类型里，单独走 safeStorage
 * （`mcp_token_<id>`，见 providerSecrets 的 customMcpSecretStorageKey）。
 */

import type { AgentKind } from '@cindy/maker-core';
import type { BotModelRoute } from './botModelChain.js';

export { MCP_TRANSPORTS, type McpTransport, type CustomMcpConfig } from '@cindy/maker-core';
import type { CustomMcpConfig } from '@cindy/maker-core';

/** Optional runtime projection for capability pickers; omitted for configuration CRUD. */
export interface CustomMcpListContext {
  agentKind: AgentKind;
  /** Preview a canonical Bot's next turn, optionally including an unsaved model chain. */
  botSessionId?: string;
  modelChain?: BotModelRoute[];
}

export interface CustomMcpListEntry extends CustomMcpConfig {
  /** Present only when a runtime context was requested. */
  available?: boolean;
}

export interface CustomMcpListResult {
  servers: CustomMcpListEntry[];
  /** Authoritative route used for this catalog; absent for raw configuration queries. */
  agentKind?: AgentKind;
}
