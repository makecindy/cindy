import { normalizeProviderRequest } from '@cindy/model-compat';
import { createHash } from 'node:crypto';
import type { Effort, ProviderModelRecord } from '@cindy/model-providers';
import { reconcileOutboundReasoningEffort } from './outbound-reasoning-effort.js';
import { createPiProviderFetch, nativeBridgeApiKey } from './pi-provider-transport.js';
import { createResponsesHandler, type ResponsesBridgeHandler } from '@cindy/anthropic-responses-bridge';
import { ChatSseTranslator, translateResponsesRequestWithContext, type ChatBridgeCapabilities, type ResponsesRequest } from '@cindy/responses-chat-bridge';

/** Reasoning blobs are private to a connection, not to a shared upstream URL. */
export function claudeProviderReasoningNamespace(url: string, providerId?: string): string {
  const material = providerId ? `${providerId}\0${url}` : url;
  return `cindy-provider-${createHash('sha256').update(material).digest('hex')}/`;
}

/** Reuse the two existing translators without opening another server or forwarding client credentials. */
export function createClaudeProviderBridge(options: {
  url: string;
  protocol: 'openai-chat' | 'openai-responses';
  headers: Readonly<Record<string, string>>;
  efforts: readonly Effort[];
  capabilities?: ChatBridgeCapabilities;
  model?: ProviderModelRecord;
  providerId?: string;
  nativeUpstream?: string;
  fetchImpl: typeof fetch;
}): ResponsesBridgeHandler {
  const nativeFetch = options.model ? createPiProviderFetch({ row: options.model,
    providerId: options.providerId ?? 'custom',
    upstream: options.nativeUpstream,
    apiKey: nativeBridgeApiKey(options.headers),
    headers: Object.fromEntries(Object.entries(options.headers).filter(([name]) =>
      !['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'].includes(name.toLowerCase()))),
    fetchImpl: options.fetchImpl,
  }) : undefined;
  const upstreamFetch: typeof fetch = async (_url, init) => {
    const responses = JSON.parse(String(init?.body)) as ResponsesRequest;
    if (responses.reasoning) {
      const effort = reconcileOutboundReasoningEffort(responses.reasoning.effort, options.efforts);
      if (effort) responses.reasoning.effort = effort;
      else delete responses.reasoning.effort;
      init = { ...init, body: JSON.stringify(responses) };
    }
    if (nativeFetch) return nativeFetch(_url, init);
    if (options.protocol === 'openai-responses') return options.fetchImpl(options.url, init);
    const translated = translateResponsesRequestWithContext(responses, { capabilities: options.capabilities });
    const upstream = await options.fetchImpl(options.url, { ...init, body: JSON.stringify(normalizeProviderRequest(translated.request, { harness: 'claude-code', protocol: 'openai-chat', upstreamBase: options.url, model: responses.model }, { reasoningEffortAlreadyMapped: true })) });
    if (!upstream.ok || !upstream.body) return upstream;
    const translator = new ChatSseTranslator(responses.model, { toolContext: translated.toolContext });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let sequence = 0;
    const output: Uint8Array[] = [];
    let ended = false;
    const emit = (events: unknown[]) => {
      for (const event of events) {
        const value = event as Record<string, unknown>;
        output.push(encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`));
      }
    };
    const frame = (raw: string) => {
      const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') { translator.markTerminal(); emit(translator.finish(true)); ended = true; return; }
      const value = JSON.parse(data);
      if (value.error) { emit(translator.fail('Upstream chat stream failed')); ended = true; return; }
      emit(translator.push(value));
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (!output.length && !ended) {
            const chunk = await reader.read();
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            buffer = buffer.replace(/\r\n/g, '\n');
            let boundary: number;
            while (!ended && (boundary = buffer.indexOf('\n\n')) >= 0) {
              frame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
            }
            if (buffer.length > 4 * 1024 * 1024) throw new Error('Chat stream frame exceeds limit');
            if (chunk.done && !ended) {
              if (buffer.trim()) frame(buffer);
              emit(translator.finish(true)); ended = true;
            }
          }
          if (output.length) controller.enqueue(output.shift()!);
          else { controller.close(); await reader.cancel(); }
        } catch {
          emit(translator.fail('Invalid or interrupted chat stream'));
          ended = true;
          if (output.length) controller.enqueue(output.shift()!);
          else controller.error(new Error('Invalid or interrupted chat stream'));
          await reader.cancel().catch(() => undefined);
        }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(stream, { status: upstream.status, headers: { 'content-type': 'text/event-stream' } });
  };
  return createResponsesHandler({
    providers: [{
      prefix: '', reasoningNamespace: claudeProviderReasoningNamespace(options.url, options.providerId), upstreamBase: options.url, wireProtocol: 'openai-responses',
      buildHeaders: async () => Object.fromEntries(Object.entries(options.headers).filter(([name]) =>
        !['x-api-key', 'anthropic-version', 'anthropic-beta'].includes(name.toLowerCase()))),
      preserveReasoningState: !!options.model,
      maxOutputTokensSupported: true,
      supportsReasoning: () => options.efforts.length > 0,
      supportedReasoningEfforts: () => options.efforts,
    }],
    fetchImpl: upstreamFetch,
  });
}
