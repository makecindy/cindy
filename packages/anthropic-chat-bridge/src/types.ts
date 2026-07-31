/**
 * 公开类型 —— Anthropic Messages API(输入)与 OpenAI Chat Completions(输出)的最小
 * 子集(仅覆盖 Claude Code SDK 实际会发/收的形态),以及 bridge 的注入接口。
 *
 * 设计原则(与 @cindy/anthropic-responses-bridge 对齐):
 *   - 只声明本包实际读写的字段,不追求覆盖两套 API 的全量 schema;
 *   - 未知字段一律保留(request 翻译只搬我们认识的键,SSE 翻译按 `type`/字段名分发,
 *     不认识的事件直接丢弃)。
 */

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Messages API —— bridge 的**输入**(Claude Code 发来的请求)
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic 请求里的 content block(user / assistant 两侧的并集)。 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicImageSource }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: string; [k: string]: unknown };

export interface AnthropicImageSource {
  type: 'base64' | 'url';
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicMessage {
  // Claude Code 除 user/assistant 外,还会在 messages 里塞 role:"system" 的消息
  // (典型:ToolSearch 延迟工具提醒等 mid-conversation system-reminder)。
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'none' };

export interface AnthropicThinkingConfig {
  type: 'enabled' | 'disabled';
  budget_tokens?: number;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: AnthropicThinkingConfig;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  metadata?: { user_id?: string; [k: string]: unknown };
  [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions —— bridge 的**输出**(发往 Chat-Completions-only 上游)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatTextContentPart {
  type: 'text';
  text: string;
}

export interface ChatImageUrlContentPart {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}

export type ChatUserContentPart = ChatTextContentPart | ChatImageUrlContentPart;

export interface ChatTextMessage {
  role: 'system' | 'developer';
  content: string;
}

export interface ChatUserMessage {
  role: 'user';
  content: string | ChatUserContentPart[];
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatAssistantMessage {
  role: 'assistant';
  content?: string | null;
  /**
   * DeepSeek/Kimi/Moonshot 的思考模型要求带 tool_calls 的 assistant 消息携带非空
   * reasoning_content(否则上游报 `reasoning_content is missing in assistant tool call
   * message`);由 capabilities.reasoningHistoryField / toolCallReasoningPlaceholder 控制。
   */
  reasoning_content?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type ChatMessage = ChatTextMessage | ChatUserMessage | ChatAssistantMessage | ChatToolMessage;

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
      strict?: boolean;
    };
  }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  reasoning?: { effort: string };
  thinking?: { type: string };
  enable_thinking?: boolean;
  temperature?: number;
  stream: boolean;
  stream_options?: { include_usage: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge 注入接口
// ─────────────────────────────────────────────────────────────────────────────

export interface BridgeLogger {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

export type ChatDeveloperRole = 'system' | 'developer';
export type ChatMaxTokensField = 'max_tokens' | 'max_completion_tokens' | 'omit';
export type ChatImageInput = 'image_url' | 'none';
export type ChatReasoningField =
  | 'reasoning_effort'
  | 'reasoning.effort'
  | 'thinking.type'
  | 'enable_thinking'
  | 'none';
export type ChatReasoningHistoryField = 'reasoning_content' | 'none';

/**
 * 上游差异(同协议族内的厂商参数分歧),全部由数据表达 —— 对齐 responses-chat-bridge
 * 的 ChatBridgeCapabilities 设计哲学:默认值保守(fail-closed),只有确认支持的厂商才开。
 */
export interface AnthropicChatBridgeCapabilities {
  /** 顶层 system 落成的消息角色;默认 'system'(OpenAI 兼容端点普遍接受)。 */
  developerRole?: ChatDeveloperRole;
  /**
   * Anthropic `max_tokens` 的上游字段。默认 'max_tokens'(兼容端点最通用);
   * 仅 o 系列等强制 `max_completion_tokens` 的官方端点用 'max_completion_tokens';
   * 上游自行管理输出长度时可 'omit'。
   */
  maxTokensField?: ChatMaxTokensField;
  /**
   * Anthropic `thinking` 请求映射成的上游参数。默认 'none' = 不发送任何 reasoning
   * 参数(上游自行决定,兼容性最好)。
   */
  reasoningField?: ChatReasoningField;
  /**
   * 会话历史里的 Anthropic `thinking` 块 → assistant 消息 `reasoning_content`。
   * 默认 'none' = 丢弃 thinking(上游不认该扩展字段时回放会被 400)。
   */
  reasoningHistoryField?: ChatReasoningHistoryField;
  /**
   * 带 tool_calls 的 assistant 消息需要非空 reasoning_content 的厂商(DeepSeek/Kimi)。
   * 开启后为缺失的 tool_call assistant 消息注入占位文本。
   */
  toolCallReasoningPlaceholder?: boolean;
  /**
   * Anthropic 图片块的上游等价形态。缺省 = 'image_url'(Chat 兼容层最通用,默认开启);
   * 显式 'none' = 关闭图片输入,图片块替换成显式占位文本(不静默丢上下文)。
   */
  imageInput?: ChatImageInput;
  /** 请求 `stream_options.include_usage`。默认 true;不支持的旧端点可关。 */
  streamUsage?: boolean;
}

/**
 * 单个上游供应商的配置(= Chat-Completions 源 adapter 契约)。bridge 按 model 前缀匹配
 * provider(空前缀 = 匹配所有模型),用它的 upstream / headers / quirks 翻译转发。
 * 新增 Chat 系订阅源 = 加一份本配置,**不改翻译器 / server 代码**。
 */
export interface ChatBridgeProviderConfig {
  /** model id 前缀(如 'deepseek/');bridge 收到后 strip 掉再发上游。空串 = 匹配所有模型。 */
  prefix: string;
  /** 上游 wire 协议;省略 = 'openai-chat'(当前唯一实现)。 */
  wireProtocol?: BridgeWireProtocol;
  /** 上游 Chat Completions base(不含路径),如 https://api.deepseek.com。 */
  upstreamBase: string;
  /** 缺省 `/chat/completions`;少数厂商可显式覆盖。 */
  chatCompletionsPath?: string;
  /**
   * 构造发往上游的 provider 专属 headers(**含鉴权**,如 authorization Bearer)。
   * 每请求调用一次;抛错 → 该请求回 502(鉴权不可用),不影响其它并发请求 / 其它 provider。
   */
  buildHeaders: (ctx: { sessionId?: string }) => Promise<Record<string, string>>;
  capabilities?: AnthropicChatBridgeCapabilities;
  /** 上游返回非 2xx 后、错误响应写回调用方前触发;回调异常只记日志,不覆盖原始上游错误。 */
  onUpstreamError?: (info: ChatBridgeUpstreamErrorInfo) => void | Promise<void>;
  /** 上游响应头里的 `x-ratelimit-*` 限流信息(标准 OpenAI 风格);缺头 → 不回调。 */
  onRateLimit?: (info: UpstreamRateLimitInfo) => void;
}

/** Provider 在上游返回非 2xx 后收到的请求级错误上下文。 */
export interface ChatBridgeUpstreamErrorInfo {
  status: number;
  body: string;
  /** 本次实际发往上游的 provider headers;可能含凭证,只能用于内存态关联,禁止记录日志。 */
  requestHeaders: Readonly<Record<string, string>>;
}

/** 上游 `x-ratelimit-*` 响应头解析结果(仅数值可解析的字段;全 undefined 时不回调)。 */
export interface UpstreamRateLimitInfo {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
}

/**
 * bridge 侧的上游 wire 协议标识。当前唯一实现是 'openai-chat'(Anthropic Messages ↔
 * OpenAI Chat Completions 翻译器);预留 'openai-responses' 扩展位 —— 那一条已有
 * @cindy/anthropic-responses-bridge,不在此实现。
 * createAnthropicChatHandler 对未实现的协议 fail-fast 抛错,防止注册了却静默不可用。
 */
export type BridgeWireProtocol = 'openai-chat';
