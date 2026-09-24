import { randomUUID, createHash } from 'node:crypto';
import { reconcileOutboundReasoningEffort } from './outbound-reasoning-effort.js';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { ChatSseTranslator, translateResponsesRequestWithContext, type ResponsesRequest } from '@cindy/responses-chat-bridge';
import type { Api, Model, Context, AssistantMessage, TextContent, ImageContent, ThinkingLevel, ProviderStreams } from '@earendil-works/pi-ai';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions';
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses';
import * as anthropicMessages from '@earendil-works/pi-ai/api/anthropic-messages';
import * as googleGenerativeAi from '@earendil-works/pi-ai/api/google-generative-ai';
import * as googleVertex from '@earendil-works/pi-ai/api/google-vertex';
import * as azureOpenaiResponses from '@earendil-works/pi-ai/api/azure-openai-responses';
import * as bedrockConverseStream from '@earendil-works/pi-ai/api/bedrock-converse-stream';
import * as mistralConversations from '@earendil-works/pi-ai/api/mistral-conversations';
import { PI_REASONING_EFFORTS, PROVIDER_MODEL_CATALOG, providerEndpointBindings, providerModelRecord, providerModelGenerationRecord, providerModelAdapterId, providerPresetModelRecord, type CatalogModel, type ProviderModelRecord, type PiModelApi } from '@cindy/model-providers';

export function invocationModelRecord(model: CatalogModel, upstream: string, api?: PiModelApi): ProviderModelRecord | undefined {
  const selected = model.api ?? api;
  const known = providerModelRecord(model.id, upstream, selected)
    ?? (selected ? providerPresetModelRecord(model.catalogPresetId, model.id, selected) : undefined)
    ?? providerModelGenerationRecord(model.id, upstream, selected, model.catalogPresetId);
  if (!selected && !known) return undefined;
  return {
    ...(known ?? {}), id: model.id, name: model.name, upstream,
    contextWindow: model.contextWindowMax ?? model.contextWindow,
    maxOutput: model.maxOutput ?? known?.maxOutput,
    modalities: model.modalities ?? known?.modalities ?? { input: ['text'], output: ['text'] },
    supportsImageInput: model.supportsImageInput ?? known?.supportsImageInput ?? false,
    supportsFastMode: model.supportsFastMode,
    reasoning: model.efforts.length > 0, efforts: model.efforts, defaultEffort: model.defaultEffort,
    execution: { pi: { ...known?.execution.pi, api: selected ?? known!.execution.pi.api,
      thinkingLevelMap: { ...known?.execution.pi.thinkingLevelMap, ...(model.reasoningRequired ? { off: null } : {}) },
    } },
  };
}

export const NATIVE_ADAPTER_ERROR_BODY_LIMIT = 16 * 1024;

/** Diagnostic prefix only. Cancel the remaining body so a huge error cannot hang the clone. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes = NATIVE_ADAPTER_ERROR_BODY_LIMIT,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (!value?.byteLength) continue;
      const take = value.byteLength > maxBytes - size ? value.subarray(0, maxBytes - size) : value;
      chunks.push(take);
      size += take.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

const adapters: Record<string, ProviderStreams> = {
  'openai-completions': openaiCompletions,
  'openai-responses': openaiResponses,
  'anthropic-messages': anthropicMessages,
  'google-generative-ai': googleGenerativeAi,
  'google-vertex': googleVertex,
  'azure-openai-responses': azureOpenaiResponses,
  'bedrock-converse-stream': bedrockConverseStream,
  'mistral-conversations': mistralConversations,
};
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

const HISTORY_PREFIX = 'cindy-pi-history-v1:';
function visibleHistoryKey(content: AssistantMessage['content']): string {
  return JSON.stringify({ text: content.filter(block => block.type === 'text').map(block => block.text).join(''),
    calls: content.filter(block => block.type === 'toolCall').map(block => [block.id, block.name, block.arguments]) });
}
function validHistoryContent(value: unknown): value is AssistantMessage['content'] {
  return Array.isArray(value) && value.every(block => block && typeof block === 'object' && (
    (block.type === 'text' && typeof block.text === 'string' && (block.textSignature === undefined || typeof block.textSignature === 'string')) ||
    (block.type === 'thinking' && typeof block.thinking === 'string' && (block.thinkingSignature === undefined || typeof block.thinkingSignature === 'string')) ||
    (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string' && block.arguments && typeof block.arguments === 'object'
      && !Array.isArray(block.arguments) && (block.thoughtSignature === undefined || typeof block.thoughtSignature === 'string'))));
}
function nativeHistory(request: ResponsesRequest, identity: string): Map<string, AssistantMessage['content'][]> {
  const saved = new Map<string, AssistantMessage['content'][]>();
  for (const item of Array.isArray(request.input) ? request.input : []) {
    const encrypted = (item as Record<string, unknown>).encrypted_content;
    if (typeof encrypted !== 'string' || !encrypted.startsWith(HISTORY_PREFIX) || encrypted.length > 4 * 1024 * 1024) continue;
    try {
      const value = JSON.parse(Buffer.from(encrypted.slice(HISTORY_PREFIX.length), 'base64').toString());
      if (value.identity !== identity || !validHistoryContent(value.content)) continue;
      const key = visibleHistoryKey(value.content);
      saved.set(key, [...(saved.get(key) ?? []), value.content]);
    } catch { /* Foreign or incomplete opaque history never becomes native content. */ }
  }
  return saved;
}

/** Pi owns native payloads, thinking dialects and response parsing. Cindy translates harness envelopes. */
export interface PiProviderTransportOptions {
  row: ProviderModelRecord;
  providerId: string;
  /** Account-specific destination; the catalog row still identifies its adapter. */
  upstream?: string;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  fetchImpl: typeof fetch;
}

/** Provider-specific authentication must not be bypassed by a matching harness wire. */
export function requiresNativeProviderAuth(row: ProviderModelRecord | undefined): boolean {
  const identity = row && providerModelAdapterId(row);
  return identity === 'github-copilot' || identity === 'cloudflare-ai-gateway';
}

const HOST_CREDENTIAL_APIS = new Set<string>(['google-vertex', 'bedrock-converse-stream']);

/** Vertex ADC / Bedrock IAM may only target Main-approved cloud endpoints. */
export function hostCredentialEndpointAllowed(api: string, destination: string): boolean {
  if (!HOST_CREDENTIAL_APIS.has(api)) return true;
  return Object.values(PROVIDER_MODEL_CATALOG.providers).some((rows) =>
    rows.some((row) => row.execution.pi.api === api && providerEndpointBindings(row.upstream, destination) !== null));
}

function assertHostCredentialEndpoint(api: string, destination: string, apiKey?: string): void {
  if (!HOST_CREDENTIAL_APIS.has(api)) return;
  if (api === 'google-vertex' && apiKey?.trim()) return;
  if (hostCredentialEndpointAllowed(api, destination)) return;
  throw new Error('Native provider request requires an approved cloud endpoint');
}

export function nativeBridgeApiKey(headers: Readonly<Record<string, string>>): string {
  const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  if (authorization) return authorization.replace(/^Bearer\s+/i, '');
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-api-key')?.[1] ?? '';
}

function isNativePlaceholderKey(apiKey: string | undefined): boolean {
  const token = apiKey?.trim();
  return !token
    || token === 'pi-native-keyless'
    || token === 'cindy-pi-provider-auth-placeholder'
    || token === 'cindy-local-provider';
}

function cloudflareGatewayHeaders(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string | null> {
  const token = isNativePlaceholderKey(apiKey) ? undefined : apiKey?.trim();
  return {
    ...headers,
    ...(token ? { 'cf-aig-authorization': `Bearer ${token}` } : {}),
    Authorization: null,
    'x-api-key': null,
  };
}

function nativeInvocationModel(options: PiProviderTransportOptions, modelId: string): Model<Api> {
  const row = options.row;
  const destination = options.upstream ?? row.upstream;
  assertHostCredentialEndpoint(row.execution.pi.api, destination, options.apiKey);
  const model: Model<Api> = { id: modelId, name: row.name, provider: providerModelAdapterId(row) ?? options.providerId,
    api: row.execution.pi.api, baseUrl: destination, contextWindow: row.contextWindow,
    maxTokens: row.maxOutput ?? Math.min(4096, row.contextWindow), reasoning: row.reasoning,
    input: row.supportsImageInput ? ['text', 'image'] : ['text'],
    cost: { input: row.cost?.input ?? 0, output: row.cost?.output ?? 0,
      cacheRead: row.cost?.cacheRead ?? 0, cacheWrite: row.cost?.cacheWrite ?? 0 },
    thinkingLevelMap: { ...row.execution.pi.thinkingLevelMap, ...Object.fromEntries(PI_REASONING_EFFORTS.map(level =>
      [level, row.efforts.includes(level) ? row.execution.pi.thinkingLevelMap?.[level] ?? level : null])) },
    compat: row.execution.pi.compat,
    samplingParams: row.execution.pi.samplingParams,
    headers: row.execution.pi.headers,
  };
  return model;
}

/** Use the same SDK, model identity and destination as chat, with a bounded probe. */
export async function probePiProvider(options: PiProviderTransportOptions, signal: AbortSignal): Promise<AssistantMessage> {
  const model = nativeInvocationModel(options, options.row.id);
  const adapter = adapters[model.api];
  if (!adapter) throw new Error('Native API is not supported by the bundled Pi adapter');
  const cloudflare = model.provider === 'cloudflare-ai-gateway';
  return adapter.streamSimple(model, { messages: [{ role: 'user', content: 'ping', timestamp: 0 }] }, {
    apiKey: cloudflare ? undefined : options.apiKey,
    env: options.env,
    headers: cloudflare ? cloudflareGatewayHeaders(options.apiKey, options.headers) : options.headers,
    ...(!['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(model.api)
      ? { fetch: options.fetchImpl } : {}),
    signal, maxRetries: 0, maxTokens: Math.min(16, model.maxTokens),
  }).result();
}

export function createPiProviderFetch(options: PiProviderTransportOptions): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as ResponsesRequest;
    const converted = translateResponsesRequestWithContext(request, { capabilities: {
      imageInput: 'image_url', reasoningHistoryField: 'reasoning_content',
    } });
    const model = nativeInvocationModel(options, request.model);
    const identity = createHash('sha256').update(JSON.stringify([options.providerId, model.api, model.baseUrl, model.id])).digest('hex');
    const savedHistory = nativeHistory(request, identity);
    const context: Context = { messages: [] };
    const toolNames = new Map<string, string>();
    for (const message of converted.request.messages) {
      if (message.role === 'system' || message.role === 'developer') {
        context.systemPrompt = [context.systemPrompt, message.content].filter(Boolean).join('\n\n');
      } else if (message.role === 'user') {
        const content: Array<TextContent | ImageContent> = typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }] : message.content.map(part => {
            if (part.type === 'text') return { type: 'text', text: part.text };
            if (part.type === 'image_url') {
              const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(part.image_url.url);
              if (match) return { type: 'image', mimeType: match[1], data: match[2] };
            }
            throw new Error('This native API requires inline text or image content');
          });
        context.messages.push({ role: 'user', content, timestamp: 0 });
      } else if (message.role === 'assistant') {
        const content: AssistantMessage['content'] = [];
        if (message.reasoning_content) content.push({ type: 'thinking', thinking: message.reasoning_content });
        if (message.content) content.push({ type: 'text', text: message.content });
        for (const tool of message.tool_calls ?? []) {
          toolNames.set(tool.id, tool.function.name);
          content.push({ type: 'toolCall', id: tool.id, name: tool.function.name, arguments: JSON.parse(tool.function.arguments) });
        }
        context.messages.push({ role: 'assistant', api: model.api, provider: model.provider,
          model: model.id, content: savedHistory.get(visibleHistoryKey(content))?.shift() ?? content, usage: zeroUsage(), stopReason: message.tool_calls?.length ? 'toolUse' : 'stop', timestamp: 0 });
      } else if (message.role === 'tool') {
        context.messages.push({ role: 'toolResult', toolCallId: message.tool_call_id,
          toolName: toolNames.get(message.tool_call_id) ?? '', content: [{ type: 'text', text: message.content }], isError: false, timestamp: 0 });
      }
    }
    context.tools = converted.request.tools?.map(tool => ({ name: tool.function.name,
      description: tool.function.description ?? '', parameters: tool.function.parameters as never }));
    const adapter = adapters[model.api];
    if (!adapter) throw new Error('Native API is not supported by the bundled Pi adapter');
    const abort = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal;
    // Keep diagnostics local to this invocation. Adapter error messages may contain
    // response bodies, credentials or user content, so never forward those strings.
    let httpStatus: number | undefined;
    const diagnosticFetch: typeof fetch = async (input, init) => {
      httpStatus = undefined;
      const response = await options.fetchImpl(input, init);
      httpStatus = response.status;
      return response;
    };
    const failureMessage = (phase: 'adapter-event' | 'stream-read') => {
      const category = httpStatus === 401 ? 'authentication'
        : httpStatus === 403 ? 'permission'
        : httpStatus === 429 ? 'rate_limit'
        : httpStatus !== undefined && httpStatus >= 500 ? 'provider_unavailable'
        : httpStatus !== undefined && httpStatus >= 400 ? 'request_rejected'
        : 'unknown';
      const status = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 600
        ? `; HTTP ${httpStatus}` : '';
      return `Native provider request failed [phase=${phase}${status}; category=${category}; request=${responseId}]`;
    };
    const cloudflareGateway = model.provider === 'cloudflare-ai-gateway';
    const events = adapter.streamSimple(model, context, {
      apiKey: cloudflareGateway ? undefined : options.apiKey, env: options.env,
      headers: cloudflareGateway ? cloudflareGatewayHeaders(options.apiKey, options.headers) : options.headers,
      // Pi's Google SDK rejects injected fetch. Its native transport must be used; all other
      // adapters that support injection use Cindy's existing outbound route.
      ...(!['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(model.api)
        ? { fetch: diagnosticFetch } : {}),
      signal, maxRetries: 0,
      ...(options.row.supportsFastMode === true && request.service_tier === 'priority' &&
        ['openai-responses', 'azure-openai-responses', 'openai-completions'].includes(model.api)
        ? { onPayload: (payload: unknown) => payload && typeof payload === 'object' && !Array.isArray(payload)
          ? { ...payload, service_tier: 'priority' } : payload } : {}),
      reasoning: reconcileOutboundReasoningEffort(request.reasoning?.effort, options.row.efforts) as ThinkingLevel | undefined,
      maxTokens: typeof request.max_output_tokens === 'number' ? Math.min(request.max_output_tokens, model.maxTokens) : model.maxTokens,
    });
    const iterator = events[Symbol.asyncIterator]();
    const translator = new ChatSseTranslator(model.id, { toolContext: converted.toolContext });
    const encoder = new TextEncoder();
    const pending: Uint8Array[] = [];
    const responseId = randomUUID();
    let sequence = 0;
    let ended = false;
    let historyItem: Record<string, unknown> | undefined;
    let lastOutputIndex = -1;
    const emit = (values: unknown[]) => values.forEach(value => {
      const event = value as Record<string, unknown>;
      if (typeof event.output_index === 'number') lastOutputIndex = Math.max(lastOutputIndex, event.output_index);
      if (historyItem && event.response && typeof event.response === 'object' && ['response.completed', 'response.incomplete'].includes(String(event.type))) {
        const response = event.response as Record<string, unknown>;
        response.output = [...(Array.isArray(response.output) ? response.output : []), historyItem];
      }
      pending.push(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`));
    });
    const chunk = (delta: object, finish_reason: string | null = null, usage?: object) => emit(translator.push({
      id: responseId, model: model.id, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    }));
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (!pending.length && !ended) {
            const next = await iterator.next();
            if (next.done) { emit(translator.finish(true)); ended = true; break; }
            const event = next.value;
            if (event.type === 'text_delta') chunk({ content: event.delta });
            else if (event.type === 'thinking_delta') chunk({ reasoning_content: event.delta });
            else if (event.type === 'toolcall_end') chunk({ tool_calls: [{ index: event.contentIndex,
              id: event.toolCall.id, type: 'function', function: { name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) } }] });
            else if (event.type === 'done') {
              const usage = event.message.usage;
              chunk({}, event.reason === 'toolUse' ? 'tool_calls' : event.reason === 'length' ? 'length' : 'stop',
                { prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite, completion_tokens: usage.output,
                  prompt_tokens_details: { cached_tokens: usage.cacheRead } });
              if (event.message.content.some(block => ('thinkingSignature' in block && block.thinkingSignature) || ('thoughtSignature' in block && block.thoughtSignature) || ('textSignature' in block && block.textSignature))) {
                historyItem = { type: 'reasoning', id: `rs_${randomUUID().replaceAll('-', '')}`, summary: [],
                  encrypted_content: HISTORY_PREFIX + Buffer.from(JSON.stringify({ identity, content: event.message.content })).toString('base64') };
                const output_index = lastOutputIndex + 1;
                emit([{ type: 'response.output_item.added', output_index, item: { ...historyItem, encrypted_content: undefined } },
                  { type: 'response.output_item.done', output_index, item: historyItem }]);
              }
              emit(translator.finish(true)); ended = true;
            } else if (event.type === 'error') { emit(translator.fail(failureMessage('adapter-event'))); ended = true; }
          }
          if (pending.length) controller.enqueue(pending.shift()!);
          else controller.close();
        } catch { abort.abort(); controller.error(new Error(failureMessage('stream-read'))); }
      },
      async cancel() { abort.abort(); await iterator.return?.(); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
}


/** Responses-facing adapter used by Codex. Cancellation remains owned by the inbound request. */
export async function handlePiProviderRequest(
  fetchImpl: typeof fetch, body: ResponsesRequest, res: ServerResponse,
): Promise<void> {
  const abort = new AbortController();
  const closed = () => abort.abort();
  res.once('close', closed);
  try {
    const response = await fetchImpl('https://cindy-native-adapter.invalid', {
      method: 'POST', body: JSON.stringify(body), signal: abort.signal,
    });
    if (!response.body) throw new Error('Native provider returned no response');
    if (body.stream !== true) {
      const text = await response.text();
      const terminal = text.split('\n\n').map(frame => frame.split('\n').find(line => line.startsWith('data: ')))
        .filter((line): line is string => !!line).map(line => JSON.parse(line.slice(6)))
        .find(event => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
      if (!terminal?.response) throw new Error('Native provider returned no final response');
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(terminal.response));
      return;
    }
    res.writeHead(response.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const reader = response.body.getReader();
    try {
      while (!res.destroyed) {
        const next = await reader.read();
        if (next.done) break;
        if (!res.write(next.value)) await once(res, 'drain', { signal: abort.signal });
      }
      if (!res.destroyed) res.end();
    } finally { await reader.cancel().catch(() => undefined); }
  } finally { res.off('close', closed); abort.abort(); }
}
