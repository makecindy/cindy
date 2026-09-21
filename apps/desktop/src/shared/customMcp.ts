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

/** 支持的 transport 类型。 */
export const MCP_TRANSPORTS = ['http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** 一条自定义 MCP 配置（不含 token）。 */
export interface CustomMcpConfig {
  /** MCP id slug（/^[a-z0-9_-]+$/，= agent 侧 mcpServers[name]）；同账号唯一。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** transport 类型：'http' | 'sse'。 */
  transport: McpTransport;
  /** 远程 MCP 端点 URL（http(s)）。 */
  url: string;
  /** 额外请求头（不含鉴权 token）。 */
  headers: Record<string, string>;
}

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
