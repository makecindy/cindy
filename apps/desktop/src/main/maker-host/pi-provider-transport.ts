import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { ChatSseTranslator, translateResponsesRequestWithContext, type ResponsesRequest } from '@cindy/responses-chat-bridge';
import type { Api, Model, Context, AssistantMessage, TextContent, ImageContent, ThinkingLevel, ProviderStreams } from '@earendil-works/pi-ai';
import { PI_REASONING_EFFORTS, providerModelRecord, providerModelAdapterId, providerPresetModelRecord, type CatalogModel, type ProviderModelRecord, type PiModelApi } from '@cindy/model-providers';

export function invocationModelRecord(model: CatalogModel, upstream: string, api?: PiModelApi): ProviderModelRecord | undefined {
  const selected = model.api ?? api;
  const known = providerModelRecord(model.id, upstream, selected)
    ?? (selected ? providerPresetModelRecord(model.catalogPresetId, model.id, selected) : undefined);
  if (!selected && !known) return undefined;
  return {
    ...(known ?? {}), id: model.id, name: model.name, upstream,
    contextWindow: model.contextWindowMax ?? model.contextWindow,
    maxOutput: model.maxOutput ?? known?.maxOutput,
    modalities: model.modalities ?? known?.modalities ?? { input: ['text'], output: ['text'] },
    supportsImageInput: model.supportsImageInput ?? known?.supportsImageInput ?? false,
    reasoning: model.efforts.length > 0, efforts: model.efforts, defaultEffort: model.defaultEffort,
    execution: { pi: { ...known?.execution.pi, api: selected ?? known!.execution.pi.api,
      thinkingLevelMap: { ...known?.execution.pi.thinkingLevelMap, ...(model.reasoningRequired ? { off: null } : {}) },
    } },
  };
}

const adapters: Record<string, () => Promise<ProviderStreams>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai'),
  'google-vertex': () => import('@earendil-works/pi-ai/api/google-vertex'),
  'azure-openai-responses': () => import('@earendil-works/pi-ai/api/azure-openai-responses'),
  'bedrock-converse-stream': () => import('@earendil-works/pi-ai/api/bedrock-converse-stream'),
  'mistral-conversations': () => import('@earendil-works/pi-ai/api/mistral-conversations'),
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
export function createPiProviderFetch(options: {
  row: ProviderModelRecord;
  providerId: string;
  /** Account-specific destination; the catalog row still identifies its adapter. */
  upstream?: string;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  fetchImpl: typeof fetch;
}): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as ResponsesRequest;
    const converted = translateResponsesRequestWithContext(request, { capabilities: {
      imageInput: 'image_url', reasoningHistoryField: 'reasoning_content',
    } });
    const row = options.row;
    const model: Model<Api> = { id: request.model, name: row.name, provider: providerModelAdapterId(row) ?? options.providerId,
      api: row.execution.pi.api, baseUrl: options.upstream ?? row.upstream, contextWindow: row.contextWindow,
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
    const load = adapters[model.api];
    if (!load) throw new Error('Native API is not supported by the bundled Pi adapter');
    const adapter = await load();
    const abort = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal;
    const cloudflareGateway = model.provider === 'cloudflare-ai-gateway';
    const events = adapter.streamSimple(model, context, {
      apiKey: cloudflareGateway ? undefined : options.apiKey, env: options.env,
      headers: cloudflareGateway ? { ...options.headers, 'cf-aig-authorization': `Bearer ${options.apiKey}`,
        Authorization: null, 'x-api-key': null } : options.headers,
      // Pi's Google SDK rejects injected fetch. Its native transport must be used; all other
      // adapters that support injection use Cindy's existing outbound route.
      ...(!['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(model.api)
        ? { fetch: options.fetchImpl } : {}),
      signal, maxRetries: 0,
      reasoning: request.reasoning?.effort && request.reasoning.effort !== 'none'
        ? request.reasoning.effort as ThinkingLevel : undefined,
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
            } else if (event.type === 'error') { emit(translator.fail('Native provider request failed')); ended = true; }
          }
          if (pending.length) controller.enqueue(pending.shift()!);
          else controller.close();
        } catch { abort.abort(); controller.error(new Error('Native provider request failed')); }
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
