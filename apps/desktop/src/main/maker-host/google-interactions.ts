/**
 * Google Interactions API adapter for the Google AI Ultra per-user quota endpoint:
 * `POST <baseUrl>/interactions:createPerUserQuota`
 *
 * Stateless protocol (`store: false`, `stream: true`) carrying the full conversation
 * as typed steps (`user_input`, `thought`, `function_call`, `function_result`,
 * `model_output`) and decoding streaming SSE step events (`step.start`, `step.delta`,
 * `step.stop`, `interaction.completed`).
 *
 * Implements `@earendil-works/pi-ai`'s `ProviderStreams` interface so Cindy's
 * `pi-provider-transport` bridges it uniformly to Claude Code, Codex, and Pi.
 * Pure Node module: no Electron imports, and always uses the caller-injected `fetch`.
 */

import {
  calculateCost,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  parseStreamingJson,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type StopReason,
  type StreamOptions,
  type TextContent,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { classifyGoogleInteractionsError } from './google-interactions-errors.js';

export type GoogleInteractionsThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface GoogleInteractionsOptions extends StreamOptions {
  toolChoice?: 'auto' | 'none' | 'any';
  thinkingLevel?: GoogleInteractionsThinkingLevel;
}

/** Google-documented sentinel allowing function calls when no prior signed thought exists (e.g. model switch). */
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
/** Google Interactions API final output budget ceiling. */
const MAX_INTERACTIONS_OUTPUT_TOKENS = 65_536;

let appUserAgentVersion = '1.0.0';

/** Allows Desktop / Host startup to report the live Cindy version in User-Agent. */
export function setGoogleInteractionsAppVersion(version: string | undefined): void {
  const trimmed = version?.trim();
  if (trimmed && trimmed !== '0.0.0') appUserAgentVersion = trimmed;
}

export function defaultGoogleInteractionsUserAgent(): string {
  return `Cindy/${appUserAgentVersion}`;
}

type InteractionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime_type: string; data: string };

type InteractionStep =
  | { type: 'user_input'; content: InteractionContentPart[] }
  | { type: 'thought'; signature?: string; summary?: Array<{ type: 'text'; text: string }> }
  | { type: 'model_output'; content: Array<{ type: 'text'; text: string }> }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'function_result';
      call_id: string;
      name: string;
      result: string | InteractionContentPart[];
      is_error?: true;
    };

interface InteractionRequest {
  model: string;
  store: false;
  stream: true;
  input: InteractionStep[];
  system_instruction?: string;
  tools?: Array<{
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  generation_config?: {
    thinking_level?: GoogleInteractionsThinkingLevel;
    thinking_summaries?: 'auto';
    max_output_tokens?: number;
    tool_choice?: 'auto' | 'none' | 'any';
  };
}

interface InteractionUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
  total_tokens?: number;
}

type InteractionSseEvent =
  | {
      event_type: 'step.start';
      index: number;
      step:
        | { type: 'thought'; signature?: string }
        | { type: 'model_output' }
        | { type: 'function_call'; id: string; name: string }
        | { type: string };
    }
  | {
      event_type: 'step.delta';
      index: number;
      delta:
        | { type: 'text'; text: string }
        | { type: 'thought_summary'; content?: { type?: string; text?: string } }
        | { type: 'thought_signature'; signature?: string }
        | { type: 'arguments_delta'; arguments?: string }
        | { type: string };
    }
  | {
      event_type: 'step.stop';
      index: number;
    }
  | {
      event_type: 'interaction.completed';
      interaction: {
        id?: string;
        status: string;
        usage?: InteractionUsage;
      };
    }
  | {
      event_type: 'error';
      error?: { message?: string };
    };

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

function headerValue(headers: ProviderHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveBearerAuthorization(
  apiKey: string | undefined,
  headers: ProviderHeaders | undefined,
): string | undefined {
  const existing = headerValue(headers, 'authorization');
  if (existing) {
    return /^Bearer\s+/i.test(existing) ? existing : `Bearer ${existing}`;
  }
  const token = apiKey?.trim();
  if (!token) return undefined;
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

/**
 * Strip API-key, project-billing, and DPoP headers per Google Interactions per-user-quota rules,
 * while guaranteeing `Authorization: Bearer <token>` and `User-Agent: Cindy/<version>`.
 */
function buildOutboundHeaders(
  authorization: string,
  modelHeaders: Record<string, string> | undefined,
  optionHeaders: ProviderHeaders | undefined,
): Record<string, string> {
  const result: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'user-agent': defaultGoogleInteractionsUserAgent(),
  };
  const blocked = new Set([
    'x-goog-api-key',
    'x-goog-user-project',
    'dpop',
    'x-api-key',
    'authorization',
    'accept',
    'content-type',
  ]);
  const apply = (source: Record<string, string | null> | undefined) => {
    if (!source) return;
    for (const [key, value] of Object.entries(source)) {
      const lower = key.toLowerCase();
      if (blocked.has(lower)) continue;
      if (value === null) {
        for (const existing of Object.keys(result)) {
          if (existing.toLowerCase() === lower) delete result[existing];
        }
        continue;
      }
      if (lower === 'user-agent') {
        result['user-agent'] = value;
      } else {
        result[key] = value;
      }
    }
  };
  apply(modelHeaders);
  apply(optionHeaders);
  result.authorization = authorization;
  return result;
}

function convertContentPart(part: TextContent | ImageContent): InteractionContentPart {
  return part.type === 'text'
    ? { type: 'text', text: sanitizeSurrogates(part.text) }
    : { type: 'image', mime_type: part.mimeType, data: part.data };
}

function sameGoogleModel(
  message: Pick<AssistantMessage, 'api' | 'provider' | 'model'>,
  model: Model<string>,
): boolean {
  return (
    message.api === model.api &&
    message.provider === model.provider &&
    message.model === model.id
  );
}

function convertTools(tools: readonly Tool[] | undefined): InteractionRequest['tools'] {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: sanitizeSurrogates(tool.description ?? ''),
    parameters:
      tool.parameters && typeof tool.parameters === 'object'
        ? (tool.parameters as unknown as Record<string, unknown>)
        : { type: 'object', properties: {} },
  }));
}

export function buildGoogleInteractionsRequest(
  model: Model<string>,
  context: Context,
  options?: GoogleInteractionsOptions,
): InteractionRequest {
  const steps: InteractionStep[] = [];
  for (const message of context.messages) {
    if (message.role === 'user') {
      const content: InteractionContentPart[] =
        typeof message.content === 'string'
          ? message.content
            ? [{ type: 'text', text: sanitizeSurrogates(message.content) }]
            : []
          : message.content.map(convertContentPart);
      if (content.length > 0) steps.push({ type: 'user_input', content });
    } else if (message.role === 'assistant') {
      const keepSignatures = sameGoogleModel(message, model);
      let signed = false;
      for (const block of message.content) {
        if (block.type === 'thinking') {
          const signature = keepSignatures ? block.thinkingSignature : undefined;
          const summaryText = block.thinking.trim();
          if (signature) signed = true;
          if (signature || (keepSignatures && summaryText)) {
            steps.push({
              type: 'thought',
              ...(signature ? { signature } : {}),
              ...(summaryText ? { summary: [{ type: 'text', text: sanitizeSurrogates(summaryText) }] } : {}),
            });
          } else if (summaryText) {
            const textPart = { type: 'text' as const, text: sanitizeSurrogates(summaryText) };
            const previous = steps.at(-1);
            if (previous?.type === 'model_output') previous.content.push(textPart);
            else steps.push({ type: 'model_output', content: [textPart] });
          }
        } else if (block.type === 'text') {
          if (!block.text) continue;
          const textPart = { type: 'text' as const, text: sanitizeSurrogates(block.text) };
          const previous = steps.at(-1);
          if (previous?.type === 'model_output') previous.content.push(textPart);
          else steps.push({ type: 'model_output', content: [textPart] });
        } else if (block.type === 'toolCall') {
          if (!signed) {
            steps.push({ type: 'thought', signature: SKIP_THOUGHT_SIGNATURE });
            signed = true;
          }
          steps.push({
            type: 'function_call',
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          });
        }
      }
    } else if (message.role === 'toolResult') {
      const images = message.content.filter((part): part is ImageContent => part.type === 'image');
      const text = message.content
        .filter((part): part is TextContent => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      steps.push({
        type: 'function_result',
        call_id: message.toolCallId,
        name: message.toolName,
        result:
          images.length > 0
            ? [
                ...(text ? [{ type: 'text' as const, text: sanitizeSurrogates(text) }] : []),
                ...images.map(convertContentPart),
              ]
            : sanitizeSurrogates(text),
        ...(message.isError ? { is_error: true as const } : {}),
      });
    }
  }

  const tools = convertTools(context.tools);
  const generationConfig: NonNullable<InteractionRequest['generation_config']> = {};
  if (options?.thinkingLevel) {
    generationConfig.thinking_level = options.thinkingLevel;
    generationConfig.thinking_summaries = 'auto';
  }
  if (typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    generationConfig.max_output_tokens = Math.min(Math.floor(options.maxTokens), MAX_INTERACTIONS_OUTPUT_TOKENS);
  }
  if (tools?.length && options?.toolChoice) {
    generationConfig.tool_choice = options.toolChoice;
  }

  const systemInstruction = context.systemPrompt?.trim();
  return {
    model: model.id,
    store: false,
    stream: true,
    ...(systemInstruction ? { system_instruction: sanitizeSurrogates(systemInstruction) } : {}),
    ...(tools ? { tools } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
    input: steps,
  };
}

function resolveGoogleInteractionsThinkingLevel(
  model: Model<string>,
  level: ThinkingLevel,
): GoogleInteractionsThinkingLevel {
  const mapped = model.thinkingLevelMap?.[level];
  if (
    mapped === 'minimal' ||
    mapped === 'low' ||
    mapped === 'medium' ||
    mapped === 'high' ||
    mapped === 'xhigh'
  ) {
    return mapped;
  }
  if (level === 'max') return 'high';
  return level;
}

function mapInteractionStatus(status: string): Extract<StopReason, 'stop' | 'toolUse' | 'length' | 'error'> {
  switch (status) {
    case 'completed':
      return 'stop';
    case 'requires_action':
      return 'toolUse';
    case 'incomplete':
      return 'length';
    default:
      return 'error';
  }
}

function parseFinalToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return parseStreamingJson(raw);
  }
}

async function* readSseJsonEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<InteractionSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseFrame = (rawFrame: string): InteractionSseEvent | null => {
    const dataLines: string[] = [];
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') return null;
    return JSON.parse(data) as InteractionSseEvent;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) yield event;
      }
      if (done) {
        if (buffer.trim()) {
          const event = parseFrame(buffer);
          if (event) yield event;
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function stream(
  model: Model<string>,
  context: Context,
  options?: GoogleInteractionsOptions,
): AssistantMessageEventStream {
  const eventStream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    try {
      const authorization = resolveBearerAuthorization(options?.apiKey, options?.headers);
      if (!authorization) throw new Error(`No credentials for provider: ${model.provider}`);
      const fetchImpl = options?.fetch;
      if (!fetchImpl) throw new Error('Google Interactions transport requires an injected fetch implementation');

      const url = `${model.baseUrl.replace(/\/+$/u, '')}/interactions:createPerUserQuota`;
      let payload: unknown = buildGoogleInteractionsRequest(model, context, options);
      const replaced = await options?.onPayload?.(payload, model);
      if (replaced !== undefined) payload = replaced;

      const timeoutMs = options?.timeoutMs;
      const headerTimeout = new AbortController();
      const timer =
        timeoutMs !== undefined && timeoutMs > 0
          ? setTimeout(
              () => headerTimeout.abort(new Error(`Google response headers timed out after ${timeoutMs}ms`)),
              timeoutMs,
            )
          : undefined;
      const signal = options?.signal
        ? AbortSignal.any([options.signal, headerTimeout.signal])
        : headerTimeout.signal;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: buildOutboundHeaders(authorization, model.headers, options?.headers),
          body: JSON.stringify(payload),
          signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      await options?.onResponse?.({ status: response.status, headers: responseHeaders }, model);

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const classified = classifyGoogleInteractionsError({
          status: response.status,
          headers: response.headers,
          body: bodyText,
          modelId: model.id,
        });
        throw new Error(classified.message);
      }

      if (!response.body) throw new Error(`${model.provider} response has no body`);

      eventStream.push({ type: 'start', partial: output });

      const blocks = new Map<number, number>();
      const toolArgBuffers = new Map<number, string>();
      let finalStatus: string | undefined;

      for await (const event of readSseJsonEvents(response.body)) {
        if (event.event_type === 'step.start') {
          const step = event.step;
          if (step.type === 'thought') {
            const thoughtStep = step as { type: 'thought'; signature?: string };
            output.content.push({
              type: 'thinking',
              thinking: '',
              ...(thoughtStep.signature ? { thinkingSignature: thoughtStep.signature } : {}),
            });
            const contentIndex = output.content.length - 1;
            blocks.set(event.index, contentIndex);
            eventStream.push({ type: 'thinking_start', contentIndex, partial: output });
          } else if (step.type === 'model_output') {
            output.content.push({ type: 'text', text: '' });
            const contentIndex = output.content.length - 1;
            blocks.set(event.index, contentIndex);
            eventStream.push({ type: 'text_start', contentIndex, partial: output });
          } else if (step.type === 'function_call') {
            const callStep = step as { type: 'function_call'; id: string; name: string };
            output.content.push({
              type: 'toolCall',
              id: callStep.id,
              name: callStep.name,
              arguments: {},
            });
            const contentIndex = output.content.length - 1;
            blocks.set(event.index, contentIndex);
            toolArgBuffers.set(event.index, '');
            eventStream.push({ type: 'toolcall_start', contentIndex, partial: output });
          }
        } else if (event.event_type === 'step.delta') {
          const contentIndex = blocks.get(event.index);
          if (contentIndex === undefined) continue;
          const block = output.content[contentIndex];
          const delta = event.delta;
          if (delta.type === 'text' && block?.type === 'text') {
            const textDelta = (delta as { type: 'text'; text: string }).text;
            block.text += textDelta;
            eventStream.push({ type: 'text_delta', contentIndex, delta: textDelta, partial: output });
          } else if (delta.type === 'thought_summary' && block?.type === 'thinking') {
            const content = (delta as { type: 'thought_summary'; content?: { type?: string; text?: string } })
              .content;
            const textDelta = content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
            if (!textDelta) continue;
            block.thinking += textDelta;
            eventStream.push({ type: 'thinking_delta', contentIndex, delta: textDelta, partial: output });
          } else if (delta.type === 'thought_signature' && block?.type === 'thinking') {
            const sig = (delta as { type: 'thought_signature'; signature?: string }).signature ?? '';
            block.thinkingSignature = (block.thinkingSignature ?? '') + sig;
          } else if (delta.type === 'arguments_delta' && block?.type === 'toolCall') {
            const argDelta = (delta as { type: 'arguments_delta'; arguments?: string }).arguments;
            if (!argDelta) continue;
            const nextRaw = (toolArgBuffers.get(event.index) ?? '') + argDelta;
            toolArgBuffers.set(event.index, nextRaw);
            block.arguments = parseStreamingJson(nextRaw);
            eventStream.push({ type: 'toolcall_delta', contentIndex, delta: argDelta, partial: output });
          }
        } else if (event.event_type === 'step.stop') {
          const contentIndex = blocks.get(event.index);
          if (contentIndex === undefined) continue;
          blocks.delete(event.index);
          const block = output.content[contentIndex];
          if (block?.type === 'text') {
            eventStream.push({ type: 'text_end', contentIndex, content: block.text, partial: output });
          } else if (block?.type === 'thinking') {
            eventStream.push({ type: 'thinking_end', contentIndex, content: block.thinking, partial: output });
          } else if (block?.type === 'toolCall') {
            const rawArgs = toolArgBuffers.get(event.index);
            toolArgBuffers.delete(event.index);
            block.arguments = parseFinalToolArguments(rawArgs);
            eventStream.push({ type: 'toolcall_end', contentIndex, toolCall: block as ToolCall, partial: output });
          }
        } else if (event.event_type === 'interaction.completed') {
          const { status, usage, id } = event.interaction;
          if (id && !output.responseId) output.responseId = id;
          if (usage) {
            const cached = usage.total_cached_tokens ?? 0;
            const thought = usage.total_thought_tokens ?? 0;
            output.usage = {
              input: Math.max(0, (usage.total_input_tokens ?? 0) - cached),
              output: (usage.total_output_tokens ?? 0) + thought,
              cacheRead: cached,
              cacheWrite: 0,
              totalTokens: usage.total_tokens ?? 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
            calculateCost(model, output.usage);
          }
          finalStatus = status;
          break;
        } else if (event.event_type === 'error') {
          throw new Error(event.error?.message ?? 'Google stream error');
        }
      }

      if (options?.signal?.aborted) throw new Error('Request was aborted');
      if (finalStatus === undefined) throw new Error('Google stream ended before interaction.completed');
      const reason = mapInteractionStatus(finalStatus);
      if (reason === 'error') throw new Error(`Interaction ended with status ${finalStatus}`);
      output.stopReason = reason;

      eventStream.push({ type: 'done', reason, message: output });
      eventStream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      eventStream.push({ type: 'error', reason: output.stopReason, error: output });
      eventStream.end();
    }
  })();

  return eventStream;
}

export function streamSimple(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const { reasoning, thinkingBudgets: _thinkingBudgets, ...rest } = options ?? {};
  // Gemini 4 models on Interactions API cannot turn thinking off; clamping picks
  // the nearest supported thinking level from `model.thinkingLevelMap`.
  const clamped = clampThinkingLevel(model, reasoning ?? 'off');
  if (clamped === 'off') return stream(model, context, rest);
  return stream(model, context, {
    ...rest,
    thinkingLevel: resolveGoogleInteractionsThinkingLevel(model, clamped),
  });
}
