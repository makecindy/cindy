/**
 * @cindy/anthropic-chat-bridge
 *
 * 协议翻译 handler:让 Claude Code SDK(只会说 Anthropic Messages API)通过用户自配的
 * API key,以 Chat-Completions-only 上游(DeepSeek / GLM / Kimi / SiliconFlow 等)的
 * native wire 协议调用其模型。请求侧 Anthropic Messages → Chat Completions,响应侧
 * Chat SSE → Anthropic SSE。
 *
 * 与 @cindy/anthropic-compat-proxy 的分工(一层代理、引擎 + 插槽):
 *   - compat-proxy:代理引擎 —— 字节级透传 + 字段裁剪 + 路由,守 SSE 零延迟(响应不解析)。
 *   - 本包:插进引擎 `RoutingDecision.localHandler` 插槽的协议翻译 handler(请求重组 +
 *     响应逐事件翻译),**不是独立 server** —— 消息流不多跳。
 *
 * 方向性说明:与 @cindy/responses-chat-bridge(Codex:Responses ↔ Chat)不同,本包是
 * Claude Code 侧的对应物(Anthropic Messages ↔ Chat),两条链路独立、互不依赖。
 */

export { createAnthropicChatHandler } from './handler.js';
export { translateRequest } from './translate-request.js';
export { AnthropicSseTranslator } from './translate-sse.js';
export { mapUsage } from './usage.js';
export type {
  AnthropicChatBridgeHandler,
  AnthropicChatHandleArgs,
  AnthropicChatHandlerOptions,
} from './handler.js';
export type { AnthropicSseEvent } from './translate-sse.js';
export type { AnthropicUsage } from './usage.js';
export type { TranslateRequestOptions } from './translate-request.js';
export type {
  AnthropicChatBridgeCapabilities,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  AnthropicToolChoice,
  BridgeLogger,
  BridgeWireProtocol,
  ChatAssistantMessage,
  ChatBridgeProviderConfig,
  ChatBridgeUpstreamErrorInfo,
  ChatCompletionsRequest,
  ChatDeveloperRole,
  ChatImageInput,
  ChatMaxTokensField,
  ChatMessage,
  ChatReasoningField,
  ChatReasoningHistoryField,
  ChatToolCall,
  ChatUserContentPart,
  UpstreamRateLimitInfo,
} from './types.js';
