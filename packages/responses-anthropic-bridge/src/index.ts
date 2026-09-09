/**
 * @cindy/responses-anthropic-bridge
 *
 * Local-handler protocol adapter for Codex: OpenAI Responses requests are translated
 * to Anthropic Messages, then Anthropic SSE/JSON is translated back to Responses SSE.
 *
 * This is the inverse direction of @cindy/anthropic-responses-bridge. Keeping each
 * direction in its own package prevents provider auth/routing concerns from leaking
 * into either wire translator.
 */
export {
  createResponsesAnthropicHandler,
  joinAnthropicMessagesUrl,
} from './handler.js';
export {
  translateResponsesRequest,
  encodeThinkingBlock,
  decodeThinkingBlock,
  type TranslateResponsesRequestOptions,
} from './translate-request.js';
export { AnthropicSseTranslator } from './responses-sse-translator.js';
export { InvalidResponsesRequestError } from './types.js';
export {
  enforceAnthropicImageLimits,
  normalizeAnthropicImages,
  requestHasInlineImage,
  sniffImageDimensions,
} from './anthropic-images.js';
export type {
  AnthropicImageCodec,
  AnthropicImageCodecInput,
  AnthropicImageCodecOutput,
  AnthropicRequest,
  CacheControl,
  ResponsesAnthropicAuthRetryInfo,
  ResponsesAnthropicErrorInfo,
  ResponsesAnthropicHandleArgs,
  ResponsesAnthropicHandler,
  ResponsesAnthropicLogger,
  ResponsesAnthropicProviderConfig,
  ResponsesAnthropicResponseInfo,
  ResponsesRequest,
  ToolCallKind,
  ToolCallMapping,
  ToolContext,
} from './types.js';
