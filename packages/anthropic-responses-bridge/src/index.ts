/**
 * @cindy/anthropic-responses-bridge
 *
 * 订阅直连协议翻译 handler:让 Claude Code SDK(只会说 Anthropic Messages API)通过用户的
 * ChatGPT 订阅 / xAI 订阅的 OAuth 凭证,以各自 native 的 OpenAI Responses wire 协议调用
 * gpt-5.5 等模型。请求侧 Anthropic Messages → Responses,响应侧按调用方模式把
 * Responses SSE / JSON → Anthropic Messages SSE / JSON。
 *
 * 与 @cindy/anthropic-compat-proxy 的分工(一层代理、引擎 + 插槽):
 *   - compat-proxy:代理引擎 —— 字节级透传 + 字段裁剪 + 路由,守 SSE 零延迟(响应不解析)。
 *   - 本包:插进引擎 `RoutingDecision.localHandler` 插槽的协议翻译 handler(请求重组 +
 *     响应逐事件翻译),**不是独立 server** —— 消息流不多跳,会话态(effort/Fast)由 host
 *     在路由决策点闭包传入,无伪 header。
 */

export { createResponsesHandler } from './handler.js';
export { translateRequest } from './translate-request.js';
export { SseTranslator } from './translate-sse.js';
export { mapUsage } from './usage.js';
export type {
  BridgeHandleArgs,
  BridgeSessionPrefs,
  ResponsesBridgeHandler,
  ResponsesHandlerOptions,
} from './handler.js';
export type { AnthropicSseEvent } from './translate-sse.js';
export type { AnthropicUsage } from './usage.js';
export type { TranslateRequestOptions } from './translate-request.js';
export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  AnthropicToolChoice,
  BridgeLogger,
  BridgeProviderConfig,
  BridgeUpstreamErrorInfo,
  BridgeWireProtocol,
  ResponsesFunctionTool,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesServerTool,
  ResponsesTool,
  UpstreamRateLimitInfo,
} from './types.js';
