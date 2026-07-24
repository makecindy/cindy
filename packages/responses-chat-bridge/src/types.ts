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
  image_url?: string;
  file_id?: string;
}

export type ResponsesContentPart = ResponsesInputTextPart | ResponsesInputImagePart | {
  type: string;
  [key: string]: unknown;
};

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

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: string | ResponsesInputItem[];
  tools?: Array<ResponsesFunctionTool | { type: string; [key: string]: unknown }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort?: string; [key: string]: unknown };
  stream?: boolean;
  store?: boolean;
  [key: string]: unknown;
}

export interface ChatTextMessage {
  role: 'system' | 'developer' | 'user';
  content: string;
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
  }>;
}

export interface ChatToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type ChatMessage = ChatTextMessage | ChatAssistantMessage | ChatToolMessage;

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
  stream: true;
  stream_options?: { include_usage: true };
}

export type ChatDeveloperRole = 'developer' | 'system';
export type ChatMaxTokensField = 'max_tokens' | 'max_completion_tokens' | 'omit';
export type ChatReasoningField = 'reasoning_effort' | 'none';

/** 同协议族内的上游差异，全部由数据表达（对齐 cc-switch / opencodex 的 per-provider 处理）。 */
export interface ChatBridgeCapabilities {
  developerRole?: ChatDeveloperRole;
  parallelToolCalls?: boolean;
  maxTokensField?: ChatMaxTokensField;
  reasoningField?: ChatReasoningField;
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

export class UnsupportedResponsesFeatureError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`Responses feature is not supported by the Chat Completions bridge: ${feature}`);
    this.name = 'UnsupportedResponsesFeatureError';
    this.feature = feature;
  }
}
