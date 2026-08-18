/**
 * dsh (DeepSeek harness) JSON-RPC wire 类型 —— 自包含最小集。
 *
 * 本文件不 import dsh SDK 包(骨架阶段 dsh 只作为外部可执行文件出现),只为
 * transport / rpc-client / translator 提供结构化类型。字段按
 * node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo 的实际 wire 形状收敛,
 * 未知字段一律不破坏性丢弃。
 */

// ---------------------------------------------------------------------------
// RPC 信封
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 请求。id 由 rpc-client 分配 (c${n})。 */
export interface DshRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 成功响应(仅 matching request 的 id 需要)。 */
export interface DshRpcSuccess {
  jsonrpc: '2.0';
  id: string;
  result: unknown;
}

/** JSON-RPC 2.0 错误响应。 */
export interface DshRpcError {
  jsonrpc: '2.0';
  id: string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** dsh 主动下发的通知(无 id),统一信封。 */
export interface DshRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type DshRpcInbound = DshRpcSuccess | DshRpcError | DshRpcNotification;

// ---------------------------------------------------------------------------
// 进程启动 / 会话管理方法
// ---------------------------------------------------------------------------

export interface DshInitializeParams {
  cwd: string;
  /** 必须是 deepseek-official(坑:dsh 只认这个 provider 名, 不是 deepseek)。 */
  provider: string;
  model: string;
  maxTokens?: number;
}

export interface DshServerInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface DshInitializeResult {
  serverInfo: DshServerInfo;
  [key: string]: unknown;
}

/** session/prompt 是 fire-and-forget:先回 messageId, 实际输出走后续事件。 */
export interface DshSessionPromptParams {
  sessionId: string;
  contentBlocks: Array<{ type: 'text'; text: string }>;
}

export interface DshSessionPromptResult {
  messageId: string;
}
export interface DshSessionResumeParams { sessionId: string; }
export interface DshSessionResumeResult { sessionId: string; }
export interface DshSessionCancelParams { sessionId: string; keepInbox?: boolean; }
export interface DshSessionCancelResult { accepted: boolean; wasRunning: boolean; }

// ---------------------------------------------------------------------------
// 会话级通知
// ---------------------------------------------------------------------------

export interface DshSessionEventNotificationParams {
  sessionId: string;
  event: DshSessionEvent;
}

export interface DshSessionStatusNotificationParams {
  sessionId: string;
  status: 'idle' | 'running';
}

// ---------------------------------------------------------------------------
// Session 事件
// ---------------------------------------------------------------------------

/** dsh session.event 的 data 字段。 */
export interface DshSessionEvent {
  type: DshSessionEventType;
  [key: string]: unknown;
}

export type DshSessionEventType =
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'assistant/chunk'
  | 'assistant/message'
  | 'tool/call'
  | 'tool/result'
  | 'user/message'
  | 'session/end-seed';

/** turn/end 的 reason。 */
export type DshTurnEndReason =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted';

/** 流式 chunk(assistant/chunk 的 chunk 字段)。 */
export interface DshStreamChunk {
  type: DshStreamChunkType;
  [key: string]: unknown;
}

export type DshStreamChunkType =
  | 'block-start'
  | 'text-delta'
  | 'reasoning-delta'
  | 'tool-call-delta'
  | 'block-end'
  | 'usage'
  | 'finish';

export interface DshTextDeltaChunk {
  type: 'text-delta';
  index: number;
  text: string;
}

export interface DshReasoningDeltaChunk {
  type: 'reasoning-delta';
  index: number;
  text: string;
}

export interface DshToolCallDeltaChunk {
  type: 'tool-call-delta';
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface DshToolCallBlock {
  id?: string;
  name?: string;
  arguments?: string;
  [key: string]: unknown;
}

export interface DshBlockEndChunk {
  type: 'block-end';
  index: number;
  block: DshStreamBlock;
}

export type DshStreamBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: 'reasoning'; text?: string; [key: string]: unknown }
  | { type: 'tool-call'; id?: string; name?: string; arguments?: string; [key: string]: unknown };

export interface DshUsageChunk {
  type: 'usage';
  usage: DshTokenUsage;
}

export interface DshFinishChunk {
  type: 'finish';
  reason: DshTurnEndReason | string;
}

export interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** assistant/message 的 message 字段。 */
export interface DshAssistantMessage {
  role: 'assistant';
  content?: DshStreamBlock[];
  usage?: DshTokenUsage;
  model?: string;
  stopReason?: string | null;
  errorMessage?: string | null;
  duration?: number;
  [key: string]: unknown;
}

/** tool/call。 */
export interface DshToolCallEventData {
  callId: string;
  name: string;
  arguments?: string;
  [key: string]: unknown;
}

/** tool/result。 */
export interface DshToolResultEventData {
  message?: string;
  error?: string;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// cordis.yml 生成(composition)
// ---------------------------------------------------------------------------

export interface DshCompositionOptions {
  /** provider 名,固定 deepseek-official。 */
  provider: string;
  model: string;
  /** 子进程 env 里承载 DEEPSEEK_API_KEY 的变量名(凭证本体不落盘)。 */
  apiKeyEnv: string;
  cwd: string;
  /** 会话持久化根目录(内部按 cwd 编码分目录)。 */
  sessionRoot: string;
  /** 是否裁剪 bash-local 插件(纯只读 / 无子进程场景)。 */
  bashLocal?: boolean;
  /** DSH DeepSeek adapter 的 base URL；省略时使用 adapter 默认值。 */
  baseUrl?: string;
  /** 每个模型的 DSH 目录元数据；上下文窗口直接影响 DSH 的会话管理。 */
  models?: readonly DshVendorModel[];
  /** DSH 的会话级默认推理强度；`off` 同时关闭思考过程。 */
  reasoningEffort?: DshReasoningEffort;
}

export type DshReasoningEffort = 'off' | 'low' | 'high' | 'max';

/** DSH adapter consumes a deliberately small, text-only model descriptor. */
export interface DshVendorModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** cordis.yml 的 AST 形态 —— 生成器内部使用,避免拼 YAML 字符串。 */
export interface DshCordisConfig {
  [key: string]: unknown;
}
