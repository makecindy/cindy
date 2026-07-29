/**
 * customMcp.ts (shared, 跨进程)
 * ---------------------------------------------------------------------------
 * 用户自定义 MCP 服务器配置的类型 SSoT —— main（store / provider）、preload、renderer 共用。
 *
 * bearer token 和 stdio 环境变量不在本类型里，单独走 safeStorage（避免把可能的
 * 凭证写进 localDb）。
 */

/** 支持的 transport 类型。 */
export const MCP_TRANSPORTS = ['http', 'sse', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** 一条自定义 MCP 配置（不含 token）。 */
interface CustomMcpConfigBase {
  /** MCP id slug（/^[a-z0-9_-]+$/，= agent 侧 mcpServers[name]）；同账号唯一。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** transport 类型。 */
  transport: McpTransport;
}

/** HTTP/SSE MCP 配置。 */
export interface RemoteCustomMcpConfig extends CustomMcpConfigBase {
  transport: 'http' | 'sse';
  /** 远程 MCP 端点 URL（http(s)）。 */
  url: string;
  /** 额外请求头（不含鉴权 token）。 */
  headers: Record<string, string>;
}

/** stdio MCP 配置。环境变量另存 safeStorage，不经过 localDb。 */
export interface StdioCustomMcpConfig extends CustomMcpConfigBase {
  transport: 'stdio';
  command: string;
  args: string[];
  /** 空字符串表示继承启动 agent 的工作目录。 */
  cwd: string;
}

export type CustomMcpConfig = RemoteCustomMcpConfig | StdioCustomMcpConfig;
