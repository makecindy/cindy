import {
  isResponsesImageContentPartType,
  UnsupportedResponsesFeatureError,
  type ChatAssistantMessage,
  type ChatAudioInput,
  type ChatBridgeCapabilities,
  type ChatCompletionsRequest,
  type ChatDeveloperRole,
  type ChatFileInput,
  type ChatImageInput,
  type ChatMessage,
  type ChatPassthroughField,
  type ChatReasoningHistoryField,
  type ChatToolCallExtraContent,
  type ChatUserContentPart,
  type ResponsesInputItem,
  type ResponsesRequest,
} from './types.js';
import { ChatBridgeToolContext } from './tool-context.js';

const TOOL_CALL_REASONING_PLACEHOLDER = 'tool call';
const GOOGLE_THOUGHT_SIGNATURE_PLACEHOLDER = 'skip_thought_signature_validator';
const TOOL_RESULT_MEDIA_MOVED_MARKER = '[media moved to the following user message]';

interface ChatMediaCapabilities {
  imageInput?: ChatImageInput;
  fileInput?: ChatFileInput;
  audioInput?: ChatAudioInput;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneToolCallExtraContent(value: unknown): ChatToolCallExtraContent | undefined {
  if (!isPlainObject(value)) return undefined;
  const { google, ...rest } = value;
  return {
    ...rest,
    ...(isPlainObject(google) ? { google: { ...google } } : {}),
  };
}

function normalizeRole(role: string, developerRole: ChatDeveloperRole): 'system' | 'developer' | 'user' {
  if (role === 'system' || role === 'developer') return developerRole;
  return 'user';
}

function imagePart(part: Record<string, unknown>): ChatUserContentPart | undefined {
  if (part.file_id !== undefined) {
    throw new UnsupportedResponsesFeatureError('input_image.file_id');
  }
  const imageUrl = typeof part.image_url === 'string'
    ? part.image_url
    : isPlainObject(part.image_url) && typeof part.image_url.url === 'string'
      ? part.image_url.url
      : undefined;
  if (!imageUrl) return undefined;
  const detail = typeof part.detail === 'string' && part.detail
    ? part.detail
    : isPlainObject(part.image_url) && typeof part.image_url.detail === 'string'
      ? part.image_url.detail
      : undefined;
  return {
    type: 'image_url',
    image_url: { url: imageUrl, ...(detail ? { detail } : {}) },
  };
}

function filePart(part: Record<string, unknown>): ChatUserContentPart | undefined {
  const source = isPlainObject(part.file) ? part.file : part;
  if (source.file_id !== undefined) {
    throw new UnsupportedResponsesFeatureError('input_file.file_id');
  }
  const file = {
    ...(typeof source.file_data === 'string' ? { file_data: source.file_data } : {}),
    ...(typeof source.file_url === 'string' ? { file_url: source.file_url } : {}),
    ...(typeof source.filename === 'string' ? { filename: source.filename } : {}),
  };
  return Object.keys(file).length > 0 ? { type: 'file', file } : undefined;
}

function audioPart(part: Record<string, unknown>): ChatUserContentPart | undefined {
  const source = isPlainObject(part.input_audio) ? part.input_audio : part;
  if (typeof source.data !== 'string' || typeof source.format !== 'string') return undefined;
  return { type: 'input_audio', input_audio: { data: source.data, format: source.format } };
}

function hasImageSource(part: Record<string, unknown>): boolean {
  return part.file_id !== undefined
    || (typeof part.image_url === 'string' && part.image_url.length > 0)
    || (
      isPlainObject(part.image_url)
      && typeof part.image_url.url === 'string'
      && part.image_url.url.length > 0
    );
}

function isImagePartTranslatable(
  part: Record<string, unknown>,
  capabilities: ChatMediaCapabilities,
): boolean {
  return capabilities.imageInput === 'image_url' && part.file_id === undefined;
}

function hasFileSource(part: Record<string, unknown>): boolean {
  const source = isPlainObject(part.file) ? part.file : part;
  return source.file_id !== undefined
    || typeof source.file_data === 'string'
    || typeof source.file_url === 'string';
}

function hasAudioSource(part: Record<string, unknown>): boolean {
  const source = isPlainObject(part.input_audio) ? part.input_audio : part;
  return typeof source.data === 'string' && typeof source.format === 'string';
}

function mediaPart(
  part: Record<string, unknown>,
  capabilities: ChatMediaCapabilities,
  failClosed = false,
): ChatUserContentPart | undefined {
  if (isResponsesImageContentPartType(part.type)) {
    if (!hasImageSource(part)) return undefined;
    if (capabilities.imageInput !== 'image_url') {
      if (failClosed) throw new UnsupportedResponsesFeatureError(String(part.type));
      return undefined;
    }
    return imagePart(part);
  }
  if (part.type === 'input_file' || part.type === 'file') {
    if (!hasFileSource(part)) return undefined;
    if (capabilities.fileInput !== 'file') {
      if (failClosed) throw new UnsupportedResponsesFeatureError(String(part.type));
      return undefined;
    }
    return filePart(part);
  }
  if (part.type === 'input_audio') {
    if (!hasAudioSource(part)) return undefined;
    if (capabilities.audioInput !== 'input_audio') {
      if (failClosed) throw new UnsupportedResponsesFeatureError(String(part.type));
      return undefined;
    }
    return audioPart(part);
  }
  return undefined;
}

function messageContent(
  item: Extract<ResponsesInputItem, { role: string }>,
  itemIndex: number,
  developerRole: ChatDeveloperRole,
  mediaCapabilities: ChatMediaCapabilities,
  dropUnsupportedHistoricalImages = false,
): string | ChatUserContentPart[] {
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) {
    throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content`);
  }

  const normalizedRole = item.role === 'assistant'
    ? 'assistant'
    : normalizeRole(item.role, developerRole);
  let text = '';
  let hasMedia = false;
  const content: ChatUserContentPart[] = [];
  for (const rawPart of item.content) {
    if (!isPlainObject(rawPart) || typeof rawPart.type !== 'string') {
      throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content`);
    }
    if (rawPart.type === 'input_text' || rawPart.type === 'output_text' || rawPart.type === 'text') {
      if (typeof rawPart.text !== 'string') {
        throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content.${rawPart.type}`);
      }
      text += rawPart.text;
      content.push({ type: 'text', text: rawPart.text });
      continue;
    }
    if (rawPart.type === 'refusal' && typeof rawPart.refusal === 'string') {
      text += rawPart.refusal;
      content.push({ type: 'text', text: rawPart.refusal });
      continue;
    }
    if (
      dropUnsupportedHistoricalImages
      && normalizedRole === 'user'
      && isResponsesImageContentPartType(rawPart.type)
      && hasImageSource(rawPart)
      && !isImagePartTranslatable(rawPart, mediaCapabilities)
    ) {
      // Codex replays failed user input in later Responses requests. A Chat-only provider that
      // rejected that image once would otherwise reject every subsequent text turn as well.
      // Provider-scoped file IDs remain untranslatable even when the route accepts image URLs.
      // Only replayed images are removed: the newest user turn remains fail-closed below.
      continue;
    }
    const translatedMedia = mediaPart(rawPart, mediaCapabilities);
    if (normalizedRole !== 'user' || !translatedMedia) {
      throw new UnsupportedResponsesFeatureError(`input content part '${rawPart.type}'`);
    }
    hasMedia = true;
    content.push(translatedMedia);
  }
  return hasMedia ? content : text;
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
    const serialized = JSON.stringify(output);
    return typeof serialized === 'string' ? serialized : String(output ?? '');
  } catch {
    return String(output);
  }
}

function replaceToolMedia(
  value: unknown,
  media: ChatUserContentPart[],
  mediaCapabilities: ChatMediaCapabilities,
): unknown {
  if (Array.isArray(value)) {
    return value.map((part) => replaceToolMedia(part, media, mediaCapabilities));
  }
  if (!isPlainObject(value)) return value;
  const translated = mediaPart(value, mediaCapabilities, true);
  if (translated) {
    media.push(translated);
    return { type: 'text', text: TOOL_RESULT_MEDIA_MOVED_MARKER };
  }
  return Object.fromEntries(
    Object.entries(value).map(
      ([key, child]) => [key, replaceToolMedia(child, media, mediaCapabilities)],
    ),
  );
}

function splitToolOutput(
  output: unknown,
  mediaCapabilities: ChatMediaCapabilities,
): { content: string; media: ChatUserContentPart[] } {
  const media: ChatUserContentPart[] = [];
  const replaced = replaceToolMedia(output, media, mediaCapabilities);
  return {
    content: stringifyToolOutput(media.length > 0 ? replaced : output),
    media,
  };
}

function customToolArguments(input: unknown): string {
  let rawInput: string;
  if (typeof input === 'string') rawInput = input;
  else {
    try {
      rawInput = JSON.stringify(input ?? '');
    } catch {
      rawInput = String(input ?? '');
    }
  }
  return JSON.stringify({ input: rawInput });
}

function toolArguments(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ input: value });
    }
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function reasoningText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(reasoningText).filter(Boolean).join('');
  if (!isPlainObject(value)) return '';
  for (const key of ['reasoning_content', 'content', 'text', 'summary']) {
    const text = reasoningText(value[key]);
    if (text) return text;
  }
  return '';
}

function agentMessageText(item: Record<string, unknown>, itemIndex: number): string {
  const normalizedAuthor = typeof item.author === 'string'
    ? item.author.replace(/\s*[\r\n]+\s*/g, ' ').trim()
    : '';
  const author = normalizedAuthor || 'agent';
  let body = '';
  let omittedEncryptedContent = false;
  if (typeof item.content === 'string') {
    body = item.content;
  } else if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const part of item.content) {
      if (!isPlainObject(part) || typeof part.type !== 'string') {
        throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content`);
      }
      if (part.type === 'encrypted_content') {
        omittedEncryptedContent = true;
        continue;
      }
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        if (typeof part.text !== 'string') {
          throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content.${part.type}`);
        }
        parts.push(part.text);
        continue;
      }
      throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content.${part.type}`);
    }
    body = parts.join('\n');
  } else {
    throw new UnsupportedResponsesFeatureError(`input[${itemIndex}].content`);
  }
  return body.trim()
    ? `[collab ${author}]\n${body}`
    : omittedEncryptedContent
      ? `[collab message from ${author}; encrypted payload omitted]`
      : `[collab message from ${author}; empty content]`;
}

interface TranslateInputOptions {
  developerRole: ChatDeveloperRole;
  mediaCapabilities: ChatMediaCapabilities;
  reasoningHistoryField?: ChatReasoningHistoryField;
  toolCallReasoningPlaceholder: boolean;
  googleThoughtSignaturePlaceholder: boolean;
  toolContext: ChatBridgeToolContext;
}

interface PendingToolCall {
  id: string;
  name: string;
}

function ensureToolCallCompatibility(message: ChatAssistantMessage, opts: TranslateInputOptions): void {
  const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
  if (hasToolCalls && opts.toolCallReasoningPlaceholder && !message.reasoning_content?.trim()) {
    message.reasoning_content = TOOL_CALL_REASONING_PLACEHOLDER;
  }
  if (!hasToolCalls || !opts.googleThoughtSignaturePlaceholder) return;
  const firstCall = message.tool_calls?.[0];
  const signature = firstCall?.extra_content?.google?.thought_signature;
  if (!firstCall || (typeof signature === 'string' && signature.trim())) return;
  firstCall.extra_content = {
    ...firstCall.extra_content,
    google: {
      ...firstCall.extra_content?.google,
      thought_signature: GOOGLE_THOUGHT_SIGNATURE_PLACEHOLDER,
    },
  };
}

/**
 * Convert the Responses item timeline to strict Chat history. Besides format conversion this
 * repairs dangling/orphan tool rounds, because Kimi/Moonshot and several llama.cpp templates
 * reject any assistant tool call not followed immediately by its tool result.
 */
function translateInput(input: ResponsesRequest['input'], opts: TranslateInputOptions): ChatMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) throw new UnsupportedResponsesFeatureError('input');

  let newestNormalizedUserMessageIndex = -1;
  let newestUserMessageIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isPlainObject(item)) continue;
    const role = (item as Record<string, unknown>).role;
    if (typeof role !== 'string') continue;
    if (role === 'user') {
      newestUserMessageIndex = index;
      break;
    }
    if (
      newestNormalizedUserMessageIndex < 0
      && role !== 'assistant'
      && normalizeRole(role, opts.developerRole) === 'user'
    ) newestNormalizedUserMessageIndex = index;
  }
  // Codex can append user-like synthetic reminders after the real user item. Treat the latest
  // explicit user item as the current-turn boundary so a fresh image is never silently discarded.
  if (newestUserMessageIndex < 0) newestUserMessageIndex = newestNormalizedUserMessageIndex;

  const messages: ChatMessage[] = [];
  let assistant: ChatAssistantMessage | null = null;
  let pendingReasoning = '';
  let pendingToolCalls: PendingToolCall[] = [];
  const resolvedToolCallIds = new Set<string>();
  let deferredBarriers: ChatMessage[] = [];
  let pendingMedia: ChatUserContentPart[] = [];
  let mintedCallId = 0;

  const mintCallId = (prefix: string): string => `call_bridge_${prefix}_${++mintedCallId}`;

  const attachReasoningToLastAssistant = (): void => {
    const text = pendingReasoning;
    pendingReasoning = '';
    if (!text.trim()) return;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant') continue;
      message.reasoning_content = message.reasoning_content
        ? `${message.reasoning_content}${text}`
        : text;
      return;
    }
  };

  const flushPendingMedia = (): void => {
    if (pendingMedia.length === 0) return;
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Media returned by the preceding tool result:' },
        ...pendingMedia,
      ],
    });
    pendingMedia = [];
  };

  const releaseDeferredBarriers = (): void => {
    flushPendingMedia();
    if (deferredBarriers.length === 0) return;
    messages.push(...deferredBarriers);
    deferredBarriers = [];
  };

  const closeUnresolvedToolRound = (): void => {
    if (pendingToolCalls.length === 0) {
      releaseDeferredBarriers();
      return;
    }
    for (const call of pendingToolCalls) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content:
          `No tool result was recorded for "${call.name}"; execution status is unknown. `
          + 'Do not treat this as success, failure, or user-provided input.',
      });
      resolvedToolCallIds.add(call.id);
    }
    pendingToolCalls = [];
    releaseDeferredBarriers();
  };

  const flushAssistant = (): void => {
    if (!assistant) return;
    const reasoning = pendingReasoning;
    pendingReasoning = '';
    if (reasoning.trim()) {
      assistant.reasoning_content = assistant.reasoning_content
        ? `${assistant.reasoning_content}${reasoning}`
        : reasoning;
    }
    const hasToolCalls = (assistant.tool_calls?.length ?? 0) > 0;
    if (assistant.content == null && !hasToolCalls && !assistant.reasoning_content) {
      assistant = null;
      return;
    }
    if (assistant.content == null && !hasToolCalls && assistant.reasoning_content) assistant.content = '';
    ensureToolCallCompatibility(assistant, opts);
    messages.push(assistant);
    // Preserve completed IDs from older rounds so late duplicates remain detectable, but retire
    // an ID when the new assistant round explicitly reuses it.
    if (hasToolCalls) {
      for (const call of assistant.tool_calls ?? []) resolvedToolCallIds.delete(call.id);
    }
    pendingToolCalls = (assistant.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
    }));
    assistant = null;
  };

  const pushBarrier = (message: ChatMessage): void => {
    flushAssistant();
    if (pendingReasoning) attachReasoningToLastAssistant();
    if (pendingToolCalls.length > 0) deferredBarriers.push(message);
    else {
      releaseDeferredBarriers();
      messages.push(message);
    }
  };

  const pushToolOutput = (item: Record<string, unknown>, output: unknown): void => {
    let callId = typeof item.call_id === 'string' && item.call_id
      ? item.call_id
      : typeof item.id === 'string' && item.id
        ? item.id
        : '';
    const bufferedAssistantReusesCallId = callId
      ? assistant?.tool_calls?.some((call) => call.id === callId) === true
      : false;
    // A late duplicate from the completed round must not flush unrelated buffered calls. The
    // same ID in the buffered assistant instead starts a legitimate new round and takes priority.
    if (callId && resolvedToolCallIds.has(callId) && !bufferedAssistantReusesCallId) return;
    flushAssistant();
    if (callId && resolvedToolCallIds.has(callId)) return;
    let matchIndex = callId
      ? pendingToolCalls.findIndex((call) => call.id === callId)
      : -1;
    if (matchIndex < 0) {
      closeUnresolvedToolRound();
      if (!callId) callId = mintCallId('orphan');
      const fallbackName = typeof item.name === 'string' && item.name ? item.name : 'unknown_tool';
      const synthesizedAssistant: ChatAssistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: fallbackName, arguments: '{}' },
        }],
      };
      ensureToolCallCompatibility(synthesizedAssistant, opts);
      messages.push(synthesizedAssistant);
      pendingToolCalls = [{ id: callId, name: fallbackName }];
      matchIndex = 0;
    }
    const transformed = splitToolOutput(output, opts.mediaCapabilities);
    messages.push({ role: 'tool', tool_call_id: callId, content: transformed.content });
    pendingMedia.push(...transformed.media);
    pendingToolCalls.splice(matchIndex, 1);
    resolvedToolCallIds.add(callId);
    if (pendingToolCalls.length === 0) releaseDeferredBarriers();
  };

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isPlainObject(item)) throw new UnsupportedResponsesFeatureError(`input[${index}]`);
    const record = item as Record<string, unknown>;

    if ('role' in item && typeof item.role === 'string') {
      const content = messageContent(
        item as Extract<ResponsesInputItem, { role: string }>,
        index,
        opts.developerRole,
        opts.mediaCapabilities,
        index < newestUserMessageIndex,
      );
      if (item.role === 'assistant') {
        if (typeof content !== 'string') {
          throw new UnsupportedResponsesFeatureError(`input[${index}].content`);
        }
        if (!assistant && pendingToolCalls.length > 0) closeUnresolvedToolRound();
        assistant ??= { role: 'assistant', content: null };
        assistant.content = `${assistant.content ?? ''}${content}`;
        if (opts.reasoningHistoryField === 'reasoning_content') {
          const embeddedReasoning = reasoningText({
            reasoning_content: record.reasoning_content,
            reasoning: record.reasoning,
          });
          if (embeddedReasoning) {
            assistant.reasoning_content = `${assistant.reasoning_content ?? ''}${embeddedReasoning}`;
          }
        }
      } else {
        const role = normalizeRole(item.role, opts.developerRole);
        if (role === 'user') {
          // 空 user(纯空白文本且无图片)整条跳过 —— Codex auto-compact 会把
          // 无文字的纯图片消息折叠成空 input_text,部分上游(Moonshot/Kimi)
          // 会以 "message at position N with role 'user' must not be empty" 400。
          const isEmptyUser =
            (typeof content === 'string' && content.trim().length === 0)
            || (Array.isArray(content) && content.length === 0);
          if (!isEmptyUser) pushBarrier({ role, content });
        } else {
          if (typeof content !== 'string') {
            throw new UnsupportedResponsesFeatureError(`input[${index}].content`);
          }
          pushBarrier({ role, content });
        }
      }
      continue;
    }

    if (item.type === 'agent_message') {
      const content = agentMessageText(record, index);
      if ((assistant?.tool_calls?.length ?? 0) > 0 || pendingToolCalls.length > 0) {
        pushBarrier({ role: 'assistant', content });
      } else {
        assistant ??= { role: 'assistant', content: null };
        assistant.content = assistant.content ? `${assistant.content}\n${content}` : content;
        const nextItem = input[index + 1];
        if (!isPlainObject(nextItem) || nextItem.type !== 'agent_message') flushAssistant();
      }
      continue;
    }

    if (item.type === 'reasoning') {
      if (opts.reasoningHistoryField === 'reasoning_content') {
        pendingReasoning += reasoningText(item);
      }
      continue;
    }

    if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'tool_search_call') {
      if (!assistant && pendingToolCalls.length > 0) closeUnresolvedToolRound();
      const callId = typeof record.call_id === 'string' && record.call_id
        ? record.call_id
        : typeof record.id === 'string' && record.id
          ? record.id
          : mintCallId('missing');
      let name: string;
      let args: string;
      if (item.type === 'tool_search_call') {
        name = opts.toolContext.chatNameForResponse('tool_search', undefined, 'tool_search');
        args = toolArguments(record.arguments ?? {
          ...(typeof record.query === 'string' ? { query: record.query } : {}),
          ...(typeof record.limit === 'number' ? { limit: record.limit } : {}),
        });
      } else {
        if (typeof item.name !== 'string' || !item.name) {
          throw new UnsupportedResponsesFeatureError(`input[${index}].${item.type}`);
        }
        name = opts.toolContext.chatNameForResponse(
          String(record.name),
          typeof record.namespace === 'string' ? record.namespace : undefined,
          item.type === 'custom_tool_call' ? 'custom' : 'function',
        );
        args = item.type === 'custom_tool_call'
          ? customToolArguments(record.input)
          : toolArguments(record.arguments);
      }
      assistant ??= { role: 'assistant', content: null, tool_calls: [] };
      assistant.tool_calls ??= [];
      const extraContent = cloneToolCallExtraContent(item.extra_content);
      assistant.tool_calls.push({
        id: callId,
        type: 'function',
        function: { name, arguments: args },
        ...(extraContent ? { extra_content: extraContent } : {}),
      });
      continue;
    }

    if (
      item.type === 'function_call_output'
      || item.type === 'custom_tool_call_output'
      || item.type === 'tool_search_output'
      || item.type === 'tool_search_call_output'
    ) {
      const output = record.output !== undefined
        ? record.output
        : item.type === 'tool_search_output' || item.type === 'tool_search_call_output'
          ? record.tools
          : undefined;
      pushToolOutput(record, output);
      continue;
    }

    throw new UnsupportedResponsesFeatureError(`input item '${String(item.type)}'`);
  }

  flushAssistant();
  if (pendingReasoning) attachReasoningToLastAssistant();
  closeUnresolvedToolRound();
  return messages;
}

function reportDroppedTools(
  tools: ResponsesRequest['tools'],
  onDropped?: (type: string, index: number) => void,
): void {
  tools?.forEach((tool, index) => {
    if (typeof tool === 'string') return;
    if (
      isPlainObject(tool)
      && ['function', 'custom', 'namespace', 'tool_search'].includes(String(tool.type))
    ) return;
    onDropped?.(isPlainObject(tool) ? String(tool.type) : typeof tool, index);
  });
}

function translateToolChoice(
  choice: unknown,
  forceAuto: boolean,
  context: ChatBridgeToolContext,
): unknown {
  if (choice === undefined || choice === 'auto' || choice === 'none') return choice;
  if (choice === 'required') return forceAuto ? 'auto' : choice;
  if (!isPlainObject(choice)) throw new UnsupportedResponsesFeatureError('tool_choice');
  if (forceAuto) return 'auto';
  if (
    (choice.type === 'function' || choice.type === 'custom')
    && typeof choice.name === 'string'
  ) {
    return {
      type: 'function',
      function: {
        name: context.chatNameForResponse(
          choice.name,
          typeof choice.namespace === 'string' ? choice.namespace : undefined,
          choice.type,
        ),
      },
    };
  }
  if (choice.type === 'tool_search') {
    return {
      type: 'function',
      function: { name: context.chatNameForResponse('tool_search', undefined, 'tool_search') },
    };
  }
  throw new UnsupportedResponsesFeatureError('tool_choice');
}

function applyReasoning(
  out: ChatCompletionsRequest,
  input: ResponsesRequest,
  capabilities: ChatBridgeCapabilities,
): void {
  const effort = input.reasoning?.effort;
  const field = capabilities.reasoningField ?? 'none';
  if (typeof effort !== 'string' || field === 'none') return;
  const mapped = capabilities.reasoningEffortMap?.[effort] ?? effort;
  const mappedString = typeof mapped === 'string' ? mapped : effort;
  switch (field) {
    case 'reasoning_effort':
      out.reasoning_effort = mappedString;
      break;
    case 'reasoning.effort':
      out.reasoning = { effort: mappedString };
      break;
    case 'thinking.type':
      out.thinking = { type: mappedString };
      break;
    case 'enable_thinking':
      out.enable_thinking = typeof mapped === 'boolean'
        ? mapped
        : !['none', 'off', 'disabled', 'minimal'].includes(String(mapped).toLowerCase());
      break;
    case 'reasoning_split':
      out.reasoning_split = typeof mapped === 'boolean'
        ? mapped
        : !['none', 'off', 'disabled'].includes(String(mapped).toLowerCase());
      break;
  }
}

function chatResponseFormat(value: unknown): unknown {
  if (!isPlainObject(value) || value.type !== 'json_schema' || value.json_schema !== undefined) {
    return value;
  }
  const { type: _type, ...jsonSchema } = value;
  return { type: 'json_schema', json_schema: jsonSchema };
}

function applyPassthrough(
  out: ChatCompletionsRequest,
  input: ResponsesRequest,
  fields: readonly ChatPassthroughField[] | undefined,
): void {
  for (const field of fields ?? []) {
    const value = field === 'response_format'
      ? chatResponseFormat(input.response_format ?? input.text?.format)
      : input[field];
    if (value !== undefined) {
      (out as unknown as Record<string, unknown>)[field] = value;
    }
  }
}

export interface TranslateResponsesRequestOptions {
  model?: string;
  capabilities?: ChatBridgeCapabilities;
  onDroppedTool?: (type: string, index: number) => void;
  /** Retained for callers compiled against the previous bridge API; supported built-in history is no longer dropped. */
  onDroppedInputItem?: (type: string, index: number) => void;
}

export interface TranslatedResponsesChatRequest {
  request: ChatCompletionsRequest;
  toolContext: ChatBridgeToolContext;
}

/** Convert a Responses request and retain the request-scoped tool catalog for response restoration. */
export function translateResponsesRequestWithContext(
  input: ResponsesRequest,
  opts: TranslateResponsesRequestOptions = {},
): TranslatedResponsesChatRequest {
  if (!input || typeof input.model !== 'string' || input.model.length === 0) {
    throw new UnsupportedResponsesFeatureError('model');
  }
  const capabilities = opts.capabilities ?? {};
  const developerRole = capabilities.developerRole ?? 'system';
  const toolContext = ChatBridgeToolContext.fromRequest(input);
  reportDroppedTools(input.tools, opts.onDroppedTool);
  const messages = translateInput(input.input, {
    developerRole,
    mediaCapabilities: capabilities,
    reasoningHistoryField: capabilities.reasoningHistoryField,
    toolCallReasoningPlaceholder: capabilities.toolCallReasoningPlaceholder === true,
    googleThoughtSignaturePlaceholder: capabilities.googleThoughtSignaturePlaceholder === true,
    toolContext,
  });
  if (input.instructions) {
    const instructions = typeof input.instructions === 'string'
      ? input.instructions
      : input.instructions.map((part, index) => {
        if (!isPlainObject(part) || typeof part.type !== 'string') {
          throw new UnsupportedResponsesFeatureError(`instructions[${index}]`);
        }
        if (
          (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text')
          && typeof part.text === 'string'
        ) {
          return part.text;
        }
        if (part.type === 'refusal' && typeof part.refusal === 'string') {
          return part.refusal;
        }
        throw new UnsupportedResponsesFeatureError(`instructions[${index}].${part.type}`);
      }).join('');
    if (instructions) messages.unshift({ role: developerRole, content: instructions });
  }

  const request: ChatCompletionsRequest = {
    model: opts.model ?? input.model,
    messages,
    stream: input.stream !== false,
  };
  const tools = toolContext.chatTools;
  if (tools) {
    request.tools = tools;
    const toolChoice = translateToolChoice(
      input.tool_choice,
      capabilities.forceAutoToolChoice === true,
      toolContext,
    );
    if (toolChoice !== undefined) request.tool_choice = toolChoice;
    if (capabilities.parallelToolCalls !== false && typeof input.parallel_tool_calls === 'boolean') {
      request.parallel_tool_calls = input.parallel_tool_calls;
    }
  }
  if (typeof input.max_output_tokens === 'number') {
    switch (capabilities.maxTokensField ?? 'omit') {
      case 'max_tokens': request.max_tokens = input.max_output_tokens; break;
      case 'max_completion_tokens': request.max_completion_tokens = input.max_output_tokens; break;
      case 'omit': break;
    }
  }
  applyReasoning(request, input, capabilities);
  applyPassthrough(request, input, capabilities.passthroughFields);
  if (request.stream && capabilities.streamUsage === true) {
    request.stream_options = { include_usage: true };
  }
  return { request, toolContext };
}

/** Backward-compatible request-only entry point used by package consumers and unit tests. */
export function translateResponsesRequest(
  input: ResponsesRequest,
  opts: TranslateResponsesRequestOptions = {},
): ChatCompletionsRequest {
  return translateResponsesRequestWithContext(input, opts).request;
}
