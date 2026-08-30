/**
 * 公开类型 —— Anthropic Messages API 与 OpenAI Responses API 的最小子集(仅覆盖
 * Claude Code SDK 实际会发/收的形态),以及 bridge 的注入接口。
 *
 * 设计原则:
 *   - 只声明本包实际读写的字段,不追求覆盖两套 API 的全量 schema;
 *   - 未知字段一律保留(request 翻译只搬我们认识的键,SSE 翻译按 `type` 分发,
 *     不认识的事件直接丢弃 —— 与 litellm 的宽松行为一致)。
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
// OpenAI Responses API —— bridge 的**输出**(发往 chatgpt.com/backend-api/codex)
// ─────────────────────────────────────────────────────────────────────────────

export type ResponsesInputItem =
  | {
      // codex /responses 端点**拒绝** role:"system"(返回 "System messages are not allowed"),
      // system 语义在 input 里用 "developer" 角色表达(实测 200);顶层系统提示走 instructions。
      type: 'message';
      role: 'user' | 'assistant' | 'developer';
      content: ResponsesContentPart[];
    }
  | { type: 'function_call'; name: string; arguments: string; call_id: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | {
      type: 'reasoning';
      id?: string;
      encrypted_content?: string;
      summary: Array<{ type: 'summary_text'; text: string }>;
      content?: unknown[];
    };

export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string };

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  strict?: boolean;
  parameters: Record<string, unknown>;
}

/**
 * 上游自带的**服务端工具**声明(不是本地 function tool):模型在上游侧自行执行,
 * 客户端既不收工具调用请求、也不回 tool_result。当前用于 xAI 的 `x_search`(原生
 * 搜 X)/ `web_search`。形状按各上游 schema 透传,只约束必须有 `type`。
 */
export interface ResponsesServerTool {
  type: string;
  [k: string]: unknown;
}

export type ResponsesTool = ResponsesFunctionTool | ResponsesServerTool;

export type ResponsesToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string };

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  parallel_tool_calls?: boolean;
  store: false;
  stream: boolean;
  include?: string[];
  prompt_cache_key?: string;
  max_output_tokens?: number;
  reasoning?: { effort?: 'low' | 'medium' | 'high' | 'xhigh'; summary?: 'auto' | 'concise' | 'detailed' | 'none' };
  /** Fast 模式:codex 后端的 'priority' tier(models_cache service_tiers 声明,UI 名 "Fast")。 */
  service_tier?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge 注入接口
// ─────────────────────────────────────────────────────────────────────────────

export interface BridgeLogger {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
  isDebugEnabled?: () => boolean;
}

/**
 * bridge 侧的上游 wire 协议标识。当前唯一实现是 'openai-responses'(Anthropic Messages ↔
 * OpenAI Responses 翻译器);预留的扩展位:
 *   - 'openai-chat':OpenAI Chat Completions 系上游(需要第二个翻译器,未实现);
 *   - Anthropic 兼容上游(GLM coding plan / DeepSeek anthropic 端点等)**不进 bridge**——
 *     它们不需要协议翻译,走 catalog provider + compat-proxy 既有路由。
 * createResponsesHandler 对未实现的协议 fail-fast 抛错,防止注册了却静默不可用。
 */
export type BridgeWireProtocol = 'openai-responses';

/** Provider 在上游返回非 2xx 后收到的请求级错误上下文。 */
export interface BridgeUpstreamErrorInfo {
  status: number;
  body: string;
  /** 本次实际发往上游的 provider headers；可能含凭证，只能用于内存态关联，禁止记录日志。 */
  requestHeaders: Readonly<Record<string, string>>;
}

/**
 * 单个上游供应商的配置(= 订阅源 adapter 契约)。bridge 按 model 前缀匹配到某个 provider,
 * 用它的 upstream / headers / quirks 翻译转发。一个 bridge 实例可持有多个(codex 订阅 /
 * xAI 订阅 …),共用同一套协议翻译器。新增 Responses 系订阅源 = 加一份本配置,
 * **不改翻译器 / server 代码**;新增源应以配置、provider membership 测试和 handler 测试覆盖。
 */
export interface BridgeProviderConfig {
  /** model id 前缀,如 'chatgpt/' | 'xai/';bridge 收到后 strip 掉再发上游(chatgpt/gpt-5.5 → gpt-5.5)。 */
  prefix: string;
  /** 上游 wire 协议;省略 = 'openai-responses'(当前唯一实现)。 */
  wireProtocol?: BridgeWireProtocol;
  /** 上游 Responses base(不含 /responses),如 codex 后端 / https://api.x.ai/v1。 */
  upstreamBase: string;
  /**
   * 构造发往上游的 provider 专属 headers(**含鉴权**,如 authorization Bearer + codex 的
   * chatgpt-account-id/originator/openai-beta)。每请求调用一次,内部负责取最新 token / 过期懒刷新。
   * 抛错 → 该请求回 502(鉴权不可用),不影响其它并发请求 / 其它 provider。
   * 返回的 headers 与 server 的公共头(content-type / accept)合并。
   */
  buildHeaders: (ctx: { sessionId?: string }) => Promise<Record<string, string>>;
  /**
   * 上游返回非 2xx 后、错误响应写回调用方前触发。provider 可据此收口自己的认证状态；
   * 回调异常只记日志，不覆盖原始上游错误。handler 会等待回调完成，保证错误到达 UI 时
   * provider 的权威状态已经同步。
   */
  onUpstreamError?: (info: BridgeUpstreamErrorInfo) => void | Promise<void>;
  /**
   * 上游是否支持 `max_output_tokens`。默认 false —— codex 后端会 400;标准 OpenAI Responses / api.x.ai 支持。
   */
  maxOutputTokensSupported?: boolean;
  /**
   * 该(去前缀后的)model 是否支持 `reasoning` 参数。默认全支持;返回 false 的模型(如 xAI grok-code-fast,
   * 对 reasoningEffort 报 400)bridge 将**完全不发** reasoning 字段。省略 = 全部支持。
   */
  supportsReasoning?: (model: string) => boolean;
  /**
   * 该(去前缀后的)model 是否启用 strict function-tool 约束解码。这是生产唯一控制面
   * (不走环境变量)。开启后 translate 层仍**逐工具**做 strict 子集兼容检查
   * (见 strict-schema.ts),不合规工具回落 strict:false,不改写 schema。
   * 返回值按 model 决定、**同一会话内必须恒定** —— strict 位进请求前缀,会话中途翻转
   * 会破坏 prompt 前缀稳定性(docs/dev-rules/maker-core-and-agent-behavior.md §3.1)。
   * 省略 = 全部 false(所有 provider 的默认)。
   */
  strictFunctionTools?: (model: string) => boolean;
  /**
   * 该(去前缀后的)model 恒定附加的上游**服务端工具**声明(如 xAI 的 `{ type: 'x_search' }`)。
   * 返回值按 model 决定、**同一会话内必须恒定**——服务端工具同样进请求前缀,会话中途增删会
   * 破坏 prompt 前缀稳定性(见 docs/dev-rules/maker-core-and-agent-behavior.md §3.1)。
   * 省略 / 返回空数组 = 不附加。附加位置恒为 function tools 之后,顺序稳定。
   */
  serverSideTools?: (model: string) => ResponsesServerTool[];
  /**
   * Fast 模式(host 经 prefs.fast 闭包传入)映射到的 Responses `service_tier` 值。codex 后端为
   * 'priority'(models_cache 的 service_tiers 声明,UI 名 "Fast")。省略 = 该 provider 不支持
   * Fast,handler 忽略 fast 偏好(如 api.x.ai 未声明 priority tier)。
   */
  fastServiceTier?: string;
  /**
   * 上游响应头里的 `x-ratelimit-*` 限流信息(标准 OpenAI 风格,api.x.ai 返回;codex 后端不返)。
   * 每个成功上游响应解析后回调一次;缺头 → 不回调。回调抛错被吞(不影响流转发)。
   */
  onRateLimit?: (info: UpstreamRateLimitInfo) => void;
}

/** 上游 `x-ratelimit-*` 响应头解析结果(仅数值可解析的字段;全 undefined 时不回调)。 */
export interface UpstreamRateLimitInfo {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
}
