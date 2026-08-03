/**
 * OpenAI Responses / Chat Completions 的 bridge 最小公开类型。
 *
 * 这里只声明转换器实际读写的字段。Responses 请求来自 Codex，遇到未知 input item
 * 必须 fail-closed，不能静默删除上下文；其它顶层未知字段由转换器明确忽略。
 */

import type { ServerResponse } from 'node:http';

export interface ResponsesInputTextPart {
  type: 'input_text' | 'output_text' | 'text';
  text: string;
}

export interface ResponsesInputImagePart {
  type: 'input_image';
  image_url?: string | {
    url: string;
    detail?: string;
  };
  file_id?: string;
  detail?: string;
}

export interface ResponsesInputFilePart {
  type: 'input_file';
  file_id?: string;
  file_data?: string;
  file_url?: string;
  filename?: string;
}

export interface ResponsesInputAudioPart {
  type: 'input_audio';
  input_audio?: {
    data: string;
    format: string;
  };
  data?: string;
  format?: string;
}

export type ResponsesContentPart =
  | ResponsesInputTextPart
  | ResponsesInputImagePart
  | ResponsesInputFilePart
  | ResponsesInputAudioPart
  | {
  type: string;
  [key: string]: unknown;
};

export interface ChatToolCallExtraContent {
  [key: string]: unknown;
  google?: {
    [key: string]: unknown;
    thought_signature?: string;
  };
}

export type ResponsesInputItem =
  | {
      type?: 'message';
      role: 'user' | 'assistant' | 'system' | 'developer';
      content: string | ResponsesContentPart[];
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
      extra_content?: ChatToolCallExtraContent;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: unknown;
    }
  | {
      type: 'reasoning';
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesCustomTool {
  type: 'custom';
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface ResponsesNamespaceTool {
  type: 'namespace';
  name: string;
  tools?: Array<ResponsesFunctionTool | ResponsesCustomTool | { type: string; [key: string]: unknown }>;
  children?: Array<ResponsesFunctionTool | ResponsesCustomTool | { type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ResponsesRequest {
  model: string;
  instructions?: string | ResponsesContentPart[];
  input: string | ResponsesInputItem[];
  tools?: Array<
    | string
    | ResponsesFunctionTool
    | ResponsesCustomTool
    | ResponsesNamespaceTool
    | { type: string; [key: string]: unknown }
  >;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort?: string; [key: string]: unknown };
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  metadata?: Record<string, unknown>;
  service_tier?: string;
  response_format?: unknown;
  text?: { format?: unknown; [key: string]: unknown };
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
  stream?: boolean;
  store?: boolean;
  [key: string]: unknown;
}

export interface ChatTextContentPart {
  type: 'text';
  text: string;
}

export interface ChatImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: string;
  };
}

export interface ChatFileContentPart {
  type: 'file';
  file: {
    file_id?: string;
    file_data?: string;
    file_url?: string;
    filename?: string;
  };
}

export interface ChatInputAudioContentPart {
  type: 'input_audio';
  input_audio: {
    data: string;
    format: string;
  };
}

export type ChatUserContentPart =
  | ChatTextContentPart
  | ChatImageUrlContentPart
  | ChatFileContentPart
  | ChatInputAudioContentPart;

export interface ChatTextMessage {
  role: 'system' | 'developer';
  content: string;
}

export interface ChatUserMessage {
  role: 'user';
  content: string | ChatUserContentPart[];
}

export interface ChatAssistantMessage {
  role: 'assistant';
  content?: string | null;
  /** DeepSeek/Kimi/Moonshot 的思考模型要求带 tool_calls 的 assistant 消息携带非空 reasoning_content。 */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    /** OpenAI 兼容层的厂商扩展；当前仅用于 Google Gemini thought signature。 */
    extra_content?: ChatToolCallExtraContent;
  }>;
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
  reasoning_split?: boolean;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  metadata?: Record<string, unknown>;
  service_tier?: string;
  response_format?: unknown;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  stream: boolean;
  stream_options?: { include_usage: true };
}

export type ChatDeveloperRole = 'developer' | 'system';
export type ChatMaxTokensField = 'max_tokens' | 'max_completion_tokens' | 'omit';
export type ChatImageInput = 'image_url';
export type ChatFileInput = 'file';
export type ChatAudioInput = 'input_audio';
export type ChatReasoningField =
  | 'reasoning_effort'
  | 'reasoning.effort'
  | 'thinking.type'
  | 'enable_thinking'
  | 'reasoning_split'
  | 'none';
export type ChatReasoningHistoryField = 'reasoning_content';
export type ChatPassthroughField =
  | 'temperature'
  | 'top_p'
  | 'frequency_penalty'
  | 'presence_penalty'
  | 'stop'
  | 'seed'
  | 'user'
  | 'metadata'
  | 'service_tier'
  | 'response_format'
  | 'logit_bias'
  | 'logprobs'
  | 'top_logprobs';

/** 同协议族内的上游差异，全部由数据表达（对齐 cc-switch / opencodex 的 per-provider 处理）。 */
export interface ChatBridgeCapabilities {
  developerRole?: ChatDeveloperRole;
  parallelToolCalls?: boolean;
  maxTokensField?: ChatMaxTokensField;
  reasoningField?: ChatReasoningField;
  /**
   * Responses reasoning history 的 Chat 消息字段。默认未声明 = 省略历史 reasoning；
   * 只有明确接受厂商扩展 `reasoning_content` 的上游才应开启。
   */
  reasoningHistoryField?: ChatReasoningHistoryField;
  /**
   * Responses `input_image` 的上游等价形态。默认未声明 = fail closed；只由
   * 已确认支持视觉输入的运行时（当前为 upstream 白名单）开启。
   */
  imageInput?: ChatImageInput;
  /** Responses `input_file` 的上游等价形态；默认未声明 = fail closed。 */
  fileInput?: ChatFileInput;
  /** Responses `input_audio` 的上游等价形态；默认未声明 = fail closed。 */
  audioInput?: ChatAudioInput;
  /** 仅对明确采用 `<think>...</think>` 内联推理方言的上游启用标签解析。 */
  inlineReasoning?: boolean;
  /** 将 Responses reasoning.effort 映射成供应商接受的枚举值。未声明时原样使用。 */
  reasoningEffortMap?: Readonly<Record<string, string | boolean>>;
  /** 只有显式列入的 Chat 可选字段才会转发，避免严格兼容端点因未知字段返回 400。 */
  passthroughFields?: readonly ChatPassthroughField[];
  streamUsage?: boolean;
  /**
   * thinking 模型(DeepSeek/Kimi/Moonshot)要求每个带 tool_calls 的 assistant 消息携带非空
   * reasoning_content,否则上游报 `reasoning_content is missing in assistant tool call message`。
   * 开启后为缺失的 tool_call assistant 消息注入占位文本。
   */
  toolCallReasoningPlaceholder?: boolean;
  /**
   * reasoning 模型拒绝强制 tool_choice(如 DeepSeek `Thinking mode does not support this tool_choice`)。
   * 开启后把具名 / required 的 tool_choice 降级为 'auto'。
   */
  forceAutoToolChoice?: boolean;
  /**
   * Gemini 3 在工具结果下一轮强制校验 thought signature。Responses 历史不承载 Google 的
   * `tool_calls[].extra_content`，开启后按 Google 官方兼容说明给每步首个 call 写入
   * `skip_thought_signature_validator`，避免桥接历史在首个工具调用后稳定 400。
   */
  googleThoughtSignaturePlaceholder?: boolean;
  /** 缺少上游 usage 时仍生成 Responses 要求的完整零值 usage 结构。默认开启。 */
  zeroUsageOnMissing?: boolean;
}

export interface ChatBridgeLogger {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface ChatBridgeUpstreamErrorInfo {
  status: number;
  body: string;
  /** 可能含凭证，只能用于内存态关联，禁止写日志。 */
  requestHeaders: Readonly<Record<string, string>>;
}

export interface ChatBridgeProviderConfig {
  upstreamBase: string;
  /** 缺省 `/chat/completions`；少数厂商可显式覆盖。 */
  chatCompletionsPath?: string;
  buildHeaders: () => Promise<Record<string, string>>;
  /** 把 wire model 改成上游真实 model；缺省原样。 */
  rewriteModel?: (model: string) => string;
  capabilities?: ChatBridgeCapabilities;
  onUpstreamError?: (info: ChatBridgeUpstreamErrorInfo) => void | Promise<void>;
}

export interface ChatBridgeHandleArgs {
  parsedBody: unknown;
  res: ServerResponse;
}

export interface ResponsesChatBridgeHandler {
  handle(args: ChatBridgeHandleArgs): Promise<void>;
}

const UNSUPPORTED_RESPONSES_FEATURE_MESSAGE_PREFIX =
  'Responses feature is not supported by the Chat Completions bridge: ';
const RESPONSES_IMAGE_CONTENT_PART_TYPES = new Set(['input_image', 'image_url', 'image']);
const CODEX_UNEXPECTED_BAD_REQUEST_PREFIX = /^unexpected status 400(?: Bad Request)?: /;
const CODEX_ERROR_METADATA_MARKERS = [
  ', url: ',
  ', cf-ray: ',
  ', request id: ',
  ', auth error: ',
  ', auth error code: ',
] as const;

export function isResponsesImageContentPartType(
  value: unknown,
): value is 'input_image' | 'image_url' | 'image' {
  return typeof value === 'string' && RESPONSES_IMAGE_CONTENT_PART_TYPES.has(value);
}

function unsupportedResponsesFeatureFromMessage(message: string): string | null {
  return message.startsWith(UNSUPPORTED_RESPONSES_FEATURE_MESSAGE_PREFIX)
    ? message.slice(UNSUPPORTED_RESPONSES_FEATURE_MESSAGE_PREFIX.length)
    : null;
}

function isUnsupportedResponsesImageFeature(feature: string): boolean {
  const contentPartMatch = /^input content part '([^']+)'$/.exec(feature);
  const contentPartType = contentPartMatch?.[1] ?? feature;
  return isResponsesImageContentPartType(contentPartType)
    || contentPartType.startsWith('input_image.');
}

function isUnsupportedResponsesImageErrorObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false;
  const { code, message } = error as Record<string, unknown>;
  if (code !== 'unsupported_feature' || typeof message !== 'string') return false;
  const feature = unsupportedResponsesFeatureFromMessage(message);
  return feature !== null && isUnsupportedResponsesImageFeature(feature);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseCodexWrappedJson(value: string): unknown {
  const jsonStart = value.indexOf('{');
  if (jsonStart < 0) return null;

  // Codex may append transport metadata after the serialized response body. Walk closing braces
  // from right to left so braces in that metadata cannot prevent recovery of the response object.
  let jsonEnd = value.lastIndexOf('}');
  while (jsonEnd > jsonStart) {
    const parsed = parseJson(value.slice(jsonStart, jsonEnd + 1));
    if (parsed !== null) return parsed;
    jsonEnd = value.lastIndexOf('}', jsonEnd - 1);
  }
  return null;
}

function stripCodexErrorMetadata(value: string): string {
  let end = value.length;
  for (const marker of CODEX_ERROR_METADATA_MARKERS) {
    const index = value.indexOf(marker);
    if (index >= 0 && index < end) end = index;
  }
  return value.slice(0, end);
}

/**
 * Classifies an unsupported-image error emitted by this bridge. Direct OpenAI-style response
 * bodies and Codex's `unexpected status 400 ...` rendering are both accepted; current Codex
 * extracts `error.message`, while older/future runtimes may retain the serialized body. Both the
 * current content-part feature and the legacy direct `input_image` feature remain recoverable.
 */
export function isUnsupportedResponsesImageErrorPayload(payload: string | null): boolean {
  if (!payload) return false;
  if (isUnsupportedResponsesImageErrorObject(parseJson(payload))) return true;

  const codexPrefix = CODEX_UNEXPECTED_BAD_REQUEST_PREFIX.exec(payload);
  if (!codexPrefix) return false;
  const renderedBody = payload.slice(codexPrefix[0].length);
  if (isUnsupportedResponsesImageErrorObject(parseCodexWrappedJson(renderedBody))) return true;

  const message = stripCodexErrorMetadata(renderedBody);
  const feature = unsupportedResponsesFeatureFromMessage(message);
  return feature !== null && isUnsupportedResponsesImageFeature(feature);
}

export class UnsupportedResponsesFeatureError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`${UNSUPPORTED_RESPONSES_FEATURE_MESSAGE_PREFIX}${feature}`);
    this.name = 'UnsupportedResponsesFeatureError';
    this.feature = feature;
  }
}
