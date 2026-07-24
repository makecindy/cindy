import {
  UnsupportedResponsesFeatureError,
  type ChatAssistantMessage,
  type ChatBridgeCapabilities,
  type ChatDeveloperRole,
  type ChatCompletionsRequest,
  type ChatMessage,
  type ResponsesContentPart,
  type ResponsesFunctionTool,
  type ResponsesInputItem,
  type ResponsesRequest,
} from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const textParts = output.map((part) => {
      if (typeof part === 'string') return part;
      if (!isPlainObject(part)) return null;
      if (typeof part.text === 'string') return part.text;
      if (typeof part.input_text === 'string') return part.input_text;
      if (typeof part.output_text === 'string') return part.output_text;
      return null;
    });
    if (textParts.every((part): part is string => part !== null)) return textParts.join('\n');
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function customToolArguments(input: unknown): string {
  if (input == null) return '{}';
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return JSON.stringify(isPlainObject(parsed) ? parsed : { input: parsed });
    } catch {
      return JSON.stringify({ input });
    }
  }
  try {
    return JSON.stringify(isPlainObject(input) ? input : { input });
  } catch {
    return JSON.stringify({ input: String(input) });
  }
}

function textFromParts(parts: ResponsesContentPart[], itemIndex: number): string {
  let text = '';
  for (const part of parts) {
    if (!isPlainObject(part) || typeof part.type !== 'string') {
      throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content`);
    }
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text !== 'string') {
        throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content.${part.type}`);
      }
      text += part.text;
      continue;
    }
    throw new UnsupportedResponsesFeatureError(`input content part '${part.type}'`);
  }
  return text;
}

function messageContent(item: Extract<ResponsesInputItem, { role: string }>, itemIndex: number): string {
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) {
    throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content`);
  }
  return textFromParts(item.content, itemIndex);
}

interface TranslateInputOptions {
  developerRole: ChatDeveloperRole;
  /** thinking 模型:为带 tool_calls 但缺 reasoning_content 的 assistant 消息注入占位。 */
  toolCallReasoningPlaceholder: boolean;
}

/** cc-switch 的占位口径:kimi/DeepSeek 要求 tool_call assistant 消息带非空 reasoning_content。 */
const TOOL_CALL_REASONING_PLACEHOLDER = 'tool call';

function flushAssistant(
  messages: ChatMessage[],
  pending: ChatAssistantMessage | null,
  opts: TranslateInputOptions,
): null {
  if (!pending) return null;
  const hasToolCalls = (pending.tool_calls?.length ?? 0) > 0;
  // 空 assistant(无 content / tool_calls)整条跳过 —— 部分后端(DeepSeek/xAI)拒收空 assistant。
  if (pending.content == null && !hasToolCalls) return null;
  if (hasToolCalls && opts.toolCallReasoningPlaceholder && !pending.reasoning_content) {
    pending.reasoning_content = TOOL_CALL_REASONING_PLACEHOLDER;
  }
  messages.push(pending);
  return null;
}

/** Responses 角色 → Chat 角色。system/developer 归一到 capability 指定角色;
 *  user / latest_reminder / 未知一律归 user(不能透传,上游只认 system/user/assistant/tool)。 */
function normalizeRole(role: string, developerRole: ChatDeveloperRole): 'system' | 'developer' | 'user' {
  if (role === 'system' || role === 'developer') return developerRole;
  return 'user';
}

/**
 * Responses input 是按时间排序的 item 列表，Chat 则把 assistant 文本和紧随其后的
 * function_call 合并进同一条 assistant message。其它角色/工具结果会结束该合并段。
 */
function translateInput(input: ResponsesRequest['input'], opts: TranslateInputOptions): ChatMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) throw new UnsupportedResponsesFeatureError('input');

  const messages: ChatMessage[] = [];
  let assistant: ChatAssistantMessage | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isPlainObject(item)) throw new UnsupportedResponsesFeatureError(`input[${index}]`);

    if ('role' in item && typeof item.role === 'string') {
      const content = messageContent(item as Extract<ResponsesInputItem, { role: string }>, index);
      if (item.role === 'assistant') {
        if (!assistant) assistant = { role: 'assistant', content };
        else if (assistant.content == null) assistant.content = content;
        else if (content) assistant.content += content;
      } else {
        assistant = flushAssistant(messages, assistant, opts);
        messages.push({ role: normalizeRole(item.role, opts.developerRole), content });
      }
      continue;
    }

    if (item.type === 'custom_tool_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string') {
        throw new UnsupportedResponsesFeatureError(`input[${index}].custom_tool_call`);
      }
      assistant ??= { role: 'assistant', content: null, tool_calls: [] };
      assistant.tool_calls ??= [];
      assistant.tool_calls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: customToolArguments(item.input) },
      });
      continue;
    }

    if (item.type === 'custom_tool_call_output') {
      assistant = flushAssistant(messages, assistant, opts);
      if (typeof item.call_id !== 'string') {
        throw new UnsupportedResponsesFeatureError(`input[${index}].custom_tool_call_output`);
      }
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: stringifyToolOutput(item.output),
      });
      continue;
    }

    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') {
        throw new UnsupportedResponsesFeatureError(`input[${index}].function_call`);
      }
      assistant ??= { role: 'assistant', content: null, tool_calls: [] };
      assistant.tool_calls ??= [];
      assistant.tool_calls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }

    assistant = flushAssistant(messages, assistant, opts);
    if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string') {
        throw new UnsupportedResponsesFeatureError(`input[${index}].function_call_output`);
      }
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: stringifyToolOutput(item.output),
      });
      continue;
    }
    if (item.type === 'reasoning') {
      // Responses 会把上一轮 reasoning item 回放进 input。Chat 没有安全的等价输入形态；
      // reasoning 本身不承载用户/工具上下文，明确丢弃而不是伪造 assistant 文本。
      continue;
    }
    throw new UnsupportedResponsesFeatureError(`input item '${String(item.type)}'`);
  }
  flushAssistant(messages, assistant, opts);
  return messages;
}

/**
 * 工具是**能力声明**,不是上下文:Chat Completions 只认标准 `function` 工具,而 Codex 每次
 * 请求都会注入自己的内建工具(`namespace` 多智能体分组、`local_shell`、`web_search`、
 * `image_generation` 等)。这些对第三方 Chat 上游无意义,必须**剥掉降级**(与 codex proxy
 * 的 xAI 兼容层同口径),不能 fail-closed —— 否则 Codex 首轮就带 namespace,整条桥接 100% 不可用。
 * 被剥掉的类型经 onDropped 回调交给 handler 记 log(no silent caps)。
 */
function translateTools(
  tools: ResponsesRequest['tools'],
  onDropped?: (type: string, index: number) => void,
): ChatCompletionsRequest['tools'] {
  if (!tools?.length) return undefined;
  const out: NonNullable<ChatCompletionsRequest['tools']> = [];
  tools.forEach((tool, index) => {
    if (!isPlainObject(tool) || tool.type !== 'function' || typeof tool.name !== 'string') {
      onDropped?.(isPlainObject(tool) ? String(tool.type) : typeof tool, index);
      return;
    }
    const functionTool = tool as unknown as ResponsesFunctionTool;
    out.push({
      type: 'function' as const,
      function: {
        name: functionTool.name,
        ...(functionTool.description ? { description: functionTool.description } : {}),
        // Kimi 等要求 root parameters.type 恰为 "object";Codex 偶尔发 null/缺失 → 归一。
        parameters: normalizeFunctionParameters(functionTool.parameters),
        ...(typeof functionTool.strict === 'boolean' ? { strict: functionTool.strict } : {}),
      },
    });
  });
  return out.length > 0 ? out : undefined;
}

function normalizeFunctionParameters(parameters: unknown): Record<string, unknown> {
  if (!isPlainObject(parameters)) return { type: 'object', properties: {} };
  if (parameters.type == null) return { ...parameters, type: 'object' };
  return parameters;
}

/**
 * tool_choice 归一。forceAutoToolChoice(思考模型)时,具名 / required 一律降级为 'auto' ——
 * DeepSeek reasoner 明确拒绝强制工具(`Thinking mode does not support this tool_choice`)。
 */
function translateToolChoice(choice: unknown, forceAuto: boolean): unknown {
  if (choice === undefined || choice === 'auto' || choice === 'none') return choice;
  if (choice === 'required') return forceAuto ? 'auto' : choice;
  if (isPlainObject(choice) && choice.type === 'function' && typeof choice.name === 'string') {
    return forceAuto ? 'auto' : { type: 'function', function: { name: choice.name } };
  }
  throw new UnsupportedResponsesFeatureError('tool_choice');
}

export interface TranslateResponsesRequestOptions {
  model?: string;
  capabilities?: ChatBridgeCapabilities;
  /** 被剥掉的非 function 工具(Codex 内建 namespace / local_shell 等)回调,供 handler 记 log。 */
  onDroppedTool?: (type: string, index: number) => void;
}

/** Convert a Codex Responses request to a streaming Chat Completions request. */
export function translateResponsesRequest(
  input: ResponsesRequest,
  opts: TranslateResponsesRequestOptions = {},
): ChatCompletionsRequest {
  if (!input || typeof input.model !== 'string' || input.model.length === 0) {
    throw new UnsupportedResponsesFeatureError('model');
  }
  const capabilities = opts.capabilities ?? {};
  const developerRole = capabilities.developerRole ?? 'system';
  const messages = translateInput(input.input, {
    developerRole,
    toolCallReasoningPlaceholder: capabilities.toolCallReasoningPlaceholder === true,
  });
  if (input.instructions) {
    messages.unshift({ role: developerRole, content: input.instructions });
  }

  const out: ChatCompletionsRequest = {
    model: opts.model ?? input.model,
    messages,
    stream: true,
  };
  const tools = translateTools(input.tools, opts.onDroppedTool);
  // 空 tools 时**必须**连 tool_choice / parallel_tool_calls 一起省略:剥掉 Codex 内建工具后
  // tools 可能变空,而 vLLM / 企业网关在没有 tools 却带 tool_choice 时会 400/503(cc-switch 同款守卫)。
  if (tools) {
    out.tools = tools;
    const toolChoice = translateToolChoice(input.tool_choice, capabilities.forceAutoToolChoice === true);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
    if (capabilities.parallelToolCalls !== false && typeof input.parallel_tool_calls === 'boolean') {
      out.parallel_tool_calls = input.parallel_tool_calls;
    }
  }
  if (typeof input.max_output_tokens === 'number') {
    switch (capabilities.maxTokensField ?? 'omit') {
      case 'max_tokens': out.max_tokens = input.max_output_tokens; break;
      case 'max_completion_tokens': out.max_completion_tokens = input.max_output_tokens; break;
      case 'omit': break;
    }
  }
  if (
    (capabilities.reasoningField ?? 'none') === 'reasoning_effort' &&
    typeof input.reasoning?.effort === 'string'
  ) {
    out.reasoning_effort = input.reasoning.effort;
  }
  if (capabilities.streamUsage === true) out.stream_options = { include_usage: true };
  return out;
}
