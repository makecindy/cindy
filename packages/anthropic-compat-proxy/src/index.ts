/**
 * @cindy/anthropic-compat-proxy
 *
 * Loopback HTTP 反向代理: 让 Claude Code SDK 能通过 Anthropic-compatible gateway
 * (litellm / 自建 LLM proxy 等) 调用第三方模型 (gpt-5.4 / kimi-k2 / glm-5.1 ...) 时,
 * 自动剥掉 Anthropic-only 的请求字段 (output_config / thinking / cache_control / betas),
 * 避免后端 Azure/OpenAI 因不认识这些字段返回 400。
 *
 * 关键设计:
 *   - 仅监听 127.0.0.1,不开放任何外部接口
 *   - 响应字节级 pipe,SSE 流式延迟 ≈ 0
 *   - 默认只对 model 不以 "claude-" 开头的请求做 strip,Claude 模型字节透传
 *   - transform 链可注入自定义改写;什么都不传走默认 [stripNonAnthropicFields]
 */

export { createAnthropicCompatProxy } from './server.js';
export {
  createEnvOutboundProxyResolver,
  hasProxyEnvConfig,
  isLoopbackHostname,
  parseOutboundProxyUrl,
  redactProxyUrlForLog,
  stripIpv6Brackets,
  TunnelingHttpsAgent,
} from './outbound-proxy.js';
export type {
  OutboundProxyAgent,
  OutboundProxyResolver,
  OutboundProxyTarget,
} from './outbound-proxy.js';
export { socks5Connect, Socks5HttpAgent, Socks5HttpsAgent } from './socks5.js';
export {
  createInstructionsInjectionTransform,
  createInstructionsRegistry,
} from './instructions-injection.js';
export {
  createActiveStripTransform,
  createDuplicateToolUseIdRecoveryRule,
  createEmptyAssistantMessageRecoveryRule,
  createEmptyTextRecoveryRule,
  createEmptyThinkingRecoveryRule,
  createEncryptedContentRecoveryRule,
  createImageGenerationIdRecoveryRule,
  createToolExchangeAdjacencyRecoveryRule,
  compactOversizedImageHistory,
  createToolUseProviderSpecificFieldsRecoveryRule,
  dedupeDuplicateToolUseIds,
  dedupeDuplicateToolUseIdsFromBody,
  repairToolExchangeAdjacency,
  repairToolExchangeAdjacencyFromBody,
  repairToolExchangeStructureFromBody,
  replaceToolResultImagesWithNotice,
  stripEmptyAssistantMessagesFromBody,
  stripEmptyTextFromBody,
  stripEmptyThinkingFromBody,
  stripEncryptedContentFromBody,
  stripImageGenerationItemsWithoutIdFromBody,
  stripNonAnthropicFields,
  stripToolUseProviderSpecificFields,
  stripToolUseProviderSpecificFieldsFromBody,
} from './transform.js';
export {
  createXaiModelInputRecoveryRule,
  createXaiModelInputSanitizeTransform,
  looksLikeXaiResponsesModel,
  sanitizeXaiModelInputBody,
  sanitizeXaiModelInputFromBody,
  supportsXaiReasoningModel,
  xaiBareModelId,
} from './xai-model-input.js';
export { createVisionBridgeTransform } from './vision-bridge-transform.js';
export { createThreadStripController } from './thread-strip-controller.js';
export type { ThreadStripController } from './thread-strip-controller.js';
export {
  collectToolUseIdsForResponseRewrite,
  ToolUseIdDedupeRewriter,
  ToolUseIdRewriteTransform,
} from './tool-use-id-stream-rewrite.js';
export type {
  InstructionsInjectionTransformOptions,
  InstructionsRegistry,
} from './instructions-injection.js';
export type {
  LocalRequestHandler,
  OversizedRequestCompactor,
  ProxyHandle,
  ProxyLogger,
  ProxyOptions,
  RecoveryRule,
  ResponseObserver,
  ResponseObserverCtx,
  ResponseObserverSink,
  ResponseTransform,
  RequestTransform,
  RequestTransformCtx,
  RoutingDecision,
  RoutingTransform,
} from './types.js';
