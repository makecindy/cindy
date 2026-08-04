/**
 * Chat Completions 请求 → OpenAI Responses 请求(translate-request.ts 的**反向**)。
 *
 * 用途:对外「通用 OpenAI Chat Completions 端点」把外部客户端的标准 Chat 请求译成 Responses
 * 请求,再打到 Cindy 自己的 `/responses`(那里按供应商 wire 分派:直连 Responses / 经
 * responses-chat 或 responses-anthropic bridge)。这样一条 chat 客户端就能复用全部供应商。
 *
 * 与 Codex 特有的 namespace / tool_search / custom_tool 无关 —— 通用 chat 客户端只发标准
 * `function` 工具与标准 content part,这里只做「标准 Chat ⇒ 标准 Responses」的忠实映射。
 * 无法在 Responses 语义里表达的字段(如 assistant.reasoning_content 历史、n>1)记降级后丢弃。
 */

import type {
  ChatCompletionsRequest,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesRequest,
} from './types.js';

export interface TranslateChatToResponsesOptions {
  /** 覆盖上游真实 model(缺省用请求里的 model)。 */
  model?: string;
  /** 记录无法在 Responses 里表达、被丢弃的特性(用于观测降级,不抛错)。 */
  onDowngrade?: (feature: string) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Chat user content parts → Responses input content parts(text/image/file/audio 忠实映射)。 */
function convertUserContent(
  content: unknown,
): string | ResponsesContentPart[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: ResponsesContentPart[] = [];
  for (const raw of content) {
    if (!isPlainObject(raw) || typeof raw.type !== 'string') continue;
    if (raw.type === 'text' && typeof raw.text === 'string') {
      parts.push({ type: 'input_text', text: raw.text });
    } else if (raw.type === 'image_url' && isPlainObject(raw.image_url) && typeof raw.image_url.url === 'string') {
      const detail = typeof raw.image_url.detail === 'string' ? raw.image_url.detail : undefined;
      parts.push({
        type: 'input_image',
        image_url: { url: raw.image_url.url, ...(detail ? { detail } : {}) },
      });
    } else if (raw.type === 'file' && isPlainObject(raw.file)) {
      const file = raw.file;
      parts.push({
        type: 'input_file',
        ...(typeof file.file_id === 'string' ? { file_id: file.file_id } : {}),
        ...(typeof file.file_data === 'string' ? { file_data: file.file_data } : {}),
        ...(typeof file.file_url === 'string' ? { file_url: file.file_url } : {}),
        ...(typeof file.filename === 'string' ? { filename: file.filename } : {}),
      });
    } else if (raw.type === 'input_audio' && isPlainObject(raw.input_audio)
      && typeof raw.input_audio.data === 'string' && typeof raw.input_audio.format === 'string') {
      parts.push({
        type: 'input_audio',
        input_audio: { data: raw.input_audio.data, format: raw.input_audio.format },
      });
    }
  }
  return parts;
}

/** Chat tool_choice → Responses tool_choice(具名工具从 `{type,function:{name}}` 压平成 `{type,name}`)。 */
function convertToolChoice(choice: unknown): unknown {
  if (choice === undefined || choice === 'auto' || choice === 'none' || choice === 'required') {
    return choice;
  }
  if (
    isPlainObject(choice)
    && choice.type === 'function'
    && isPlainObject(choice.function)
    && typeof choice.function.name === 'string'
  ) {
    return { type: 'function', name: choice.function.name };
  }
  return choice;
}

const SAMPLING_PASSTHROUGH_FIELDS = [
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'seed',
  'user',
  'metadata',
  'service_tier',
  'logit_bias',
  'logprobs',
  'top_logprobs',
] as const;

/**
 * 把一个标准 Chat Completions 请求译成 Responses 请求。
 *
 * - 前导 system/developer 合并进 `instructions`;之后出现的 system/developer 保留为 message item。
 * - user → message item(content 转 input_* part);assistant.content → assistant message item;
 *   assistant.tool_calls → function_call item;role:tool → function_call_output item。
 * - tools(function)→ Responses function tools;max_tokens/max_completion_tokens → max_output_tokens;
 *   reasoning_effort / reasoning.effort → reasoning.effort;常规采样参数透传。
 */
export function translateChatToResponsesRequest(
  input: ChatCompletionsRequest,
  opts: TranslateChatToResponsesOptions = {},
): ResponsesRequest {
  const inputItems: ResponsesInputItem[] = [];
  let instructions = '';
  let seenNonSystem = false;

  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (!isPlainObject(message) || typeof message.role !== 'string') continue;
    const role = message.role;

    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : '';
      if (!seenNonSystem) {
        instructions = instructions ? `${instructions}\n${text}` : text;
      } else {
        inputItems.push({ type: 'message', role, content: text });
      }
      continue;
    }

    seenNonSystem = true;

    if (role === 'user') {
      inputItems.push({ role: 'user', content: convertUserContent(message.content) });
      continue;
    }

    if (role === 'assistant') {
      const content = message.content;
      if (typeof content === 'string' && content.length > 0) {
        inputItems.push({ role: 'assistant', content });
      }
      // reasoning_content 历史无法在 Responses input 里忠实承载,记降级后丢弃。
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
        opts.onDowngrade?.('assistant.reasoning_content');
      }
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls) {
        if (!isPlainObject(call) || !isPlainObject(call.function)) continue;
        inputItems.push({
          type: 'function_call',
          call_id: typeof call.id === 'string' ? call.id : '',
          name: typeof call.function.name === 'string' ? call.function.name : '',
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '',
          ...(isPlainObject(call.extra_content) ? { extra_content: call.extra_content } : {}),
        });
      }
      continue;
    }

    if (role === 'tool') {
      inputItems.push({
        type: 'function_call_output',
        call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        output: typeof message.content === 'string' ? message.content : (message.content ?? ''),
      });
      continue;
    }
  }

  const request: ResponsesRequest = {
    model: opts.model ?? input.model,
    input: inputItems,
  };
  if (instructions) request.instructions = instructions;

  const tools: NonNullable<ResponsesRequest['tools']> = [];
  for (const tool of Array.isArray(input.tools) ? input.tools : []) {
    if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) continue;
    const fn = tool.function;
    if (typeof fn.name !== 'string') continue;
    tools.push({
      type: 'function',
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(isPlainObject(fn.parameters) ? { parameters: fn.parameters } : {}),
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
    });
  }
  if (tools.length > 0) {
    request.tools = tools;
    const toolChoice = convertToolChoice(input.tool_choice);
    if (toolChoice !== undefined) request.tool_choice = toolChoice;
    if (typeof input.parallel_tool_calls === 'boolean') {
      request.parallel_tool_calls = input.parallel_tool_calls;
    }
  }

  const maxTokens = typeof input.max_completion_tokens === 'number'
    ? input.max_completion_tokens
    : typeof input.max_tokens === 'number'
      ? input.max_tokens
      : undefined;
  if (typeof maxTokens === 'number') request.max_output_tokens = maxTokens;

  const effort = typeof input.reasoning?.effort === 'string'
    ? input.reasoning.effort
    : typeof input.reasoning_effort === 'string'
      ? input.reasoning_effort
      : undefined;
  if (effort) request.reasoning = { effort };

  const record = input as unknown as Record<string, unknown>;
  const target = request as Record<string, unknown>;
  for (const field of SAMPLING_PASSTHROUGH_FIELDS) {
    if (record[field] !== undefined) target[field] = record[field];
  }
  if (input.response_format !== undefined) request.response_format = input.response_format;

  if (typeof record.n === 'number' && record.n > 1) opts.onDowngrade?.('n>1');

  request.stream = input.stream !== false;
  return request;
}
