import type { AgentKind } from '../types/common.js';

export interface McpProviderContext {
  agentKind: AgentKind;
  workingDir: string;
  vendorOptions?: Record<string, unknown>;
  /**
   * Business 层 session id (host 通过 createSession 的 opts.id 提供, 由 maker.ts
   * 透传给 agent.startSession 后落到这里)。MCP server 工厂可以闭包绑定本字段,
   * 让 tool handler 知道 "我在哪个 session 里被调用"。
   *
   * 注意: 与 SDK 内部 sdkSessionId 不同 (sdk id 是 SDK 自己生成的, 走 handle.id)。
   * 全局 ctx 场景 (如 codex HTTP MCP bridge, 见 desktop 的 codexEnvironment.ts)
   * 不会在 server factory 阶段注入本字段, 取到 undefined 表示 "当前调用来源
   * 无法绑定到单个 session"。
   */
  sessionId?: string;
  /**
   * 返回当前 tool-call 绑定的真实 session ctx。
   *
   * Claude in-process MCP 通常直接闭包绑定 per-session ctx；Codex HTTP bridge
   * 是长生命周期全局 server，server factory 阶段只能拿到空 ctx，因此需要在
   * tool-call 时从 host 的请求上下文恢复真实 session。控制类工具必须优先读
   * 这里的调用时 ctx，再回退到闭包 ctx；不要信任工具入参自报身份。
   */
  getSessionContext?: () => McpProviderContext | undefined;
}

/**
 * McpProvider — host 注入给 agent 的 MCP server 提供者。
 *
 * maker-core 只认识 provider 这个抽象，不知道具体 MCP 属于飞书、Google
 * 还是图片生成。每次启动 SDK Query 时 provider 都可以返回一个新的
 * Claude SDK mcpServers config，因此 in-process McpServer 实例不会跨 Query 复用。
 */
export interface CodexHttpMcpServerConfig {
  type: 'http';
  url: string;
  /** Name of an env var holding the RAW bearer token (no "Bearer " prefix — Codex prepends it). */
  bearerTokenEnvVar?: string;
  /**
   * Custom HTTP headers whose VALUES are sourced from env vars at runtime
   * (maps header name → env var name). Serialized into Codex's
   * `mcp_servers.<name>.env_http_headers` table; the actual values are supplied
   * via `getExtraEnv` so secrets never land in process args (unlike static
   * `http_headers`, which would be visible in the spawned command line).
   */
  envHttpHeaders?: Record<string, string>;
}

export interface McpProvider {
  /** MCP server 唯一名（host 自定义） */
  name: string;
  /** 按 session 上下文决定是否启用，例如飞书 bot MCP 只给 source='feishu' 会话。 */
  isEnabled?(context: McpProviderContext): boolean;
  /**
   * 返回 Claude SDK 的单个 mcpServers[name] 配置。
   * 这里故意保持 unknown，避免 mcp-provider 抽象层绑定具体 SDK 类型；
   * ClaudeCodeAgent 在使用点按 SDK 类型收窄。
   */
  toClaudeSdkConfig?(context: McpProviderContext): unknown | null;
  /** 返回 Codex app-server 可直接消费的远程 MCP 配置；in-process SDK server 仍走 host HTTP bridge。 */
  toCodexMcpConfig?(context: McpProviderContext): CodexHttpMcpServerConfig | null;
  /** Provider 需要额外注入给 agent 子进程的 env，例如远程 MCP bearer token。 */
  getExtraEnv?(context: McpProviderContext): Promise<Record<string, string> | null> | Record<string, string> | null;
}
