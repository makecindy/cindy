/**
 * customMcp.ts (shared, 跨进程)
 * ---------------------------------------------------------------------------
 * 用户自定义 MCP 服务器配置的类型 SSoT —— main（store / provider）、preload、renderer 共用。
 *
 * 支持 http/sse/stdio。bearer token 不在本类型里，单独走 safeStorage
 * （`mcp_token_<id>`，见 providerSecrets 的 customMcpSecretStorageKey）。
 */

import type { AgentKind } from '@cindy/maker-core';
import type { BotModelRoute } from './botModelChain.js';

/** 支持的 transport 类型。 */
export const MCP_TRANSPORTS = ['http', 'sse', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** Runs on the Desktop owning this configuration, never in the task's project. */
export interface StdioMcpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function isStdioMcpConfig(value: unknown): value is StdioMcpConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const string = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
  return Object.keys(c).every(key => ['command', 'args', 'env'].includes(key)) &&
    string(c.command) && c.command.trim().length > 0 &&
    Array.isArray(c.args) && c.args.every(string) &&
    !!c.env && typeof c.env === 'object' && !Array.isArray(c.env) &&
    Object.entries(c.env).every(([key, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && string(val));
}

/** 一条自定义 MCP 配置（不含 token）。 */
export interface CustomMcpConfig {
  /** MCP id slug（/^[a-z0-9_-]+$/，= agent 侧 mcpServers[name]）；同账号唯一。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** transport 类型。 */
  transport: McpTransport;
  /** 远程 MCP 端点 URL；stdio 为留空字符串。 */
  url: string;
  /** 额外请求头（不含鉴权 token）。 */
  headers: Record<string, string>;
  /** Required for stdio; encrypted as a unit at rest (arguments can contain secrets). */
  stdio?: StdioMcpConfig;
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

export type McpDuplicateChoice = 'cindy' | 'claude' | 'both';
/** Diagnostic projection: never includes native headers, tokens, or URL query strings. */
export interface McpDuplicateConnection {
  id: string;
  cindyId: string;
  cindyName: string;
  claudeName: string;
  origin: string;
  reason: 'endpoint' | 'similar';
  choice?: McpDuplicateChoice;
}
export interface McpDuplicateReport {
  connections: McpDuplicateConnection[];
  complete: boolean;
}

/** Display exactly the connected group affected by one saved choice. */
export function groupMcpDuplicateConnections(connections: McpDuplicateConnection[]): McpDuplicateConnection[][] {
  const remaining = [...connections];
  const groups: McpDuplicateConnection[][] = [];
  while (remaining.length) {
    const group = [remaining.shift()!];
    const hosts = new Set([group[0]!.cindyId]);
    const natives = new Set([group[0]!.claudeName]);
    for (let changed = true; changed;) {
      changed = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const pair = remaining[i]!;
        if (!hosts.has(pair.cindyId) && !natives.has(pair.claudeName)) continue;
        hosts.add(pair.cindyId); natives.add(pair.claudeName); group.push(pair);
        remaining.splice(i, 1); changed = true;
      }
    }
    groups.push(group);
  }
  return groups;
}
