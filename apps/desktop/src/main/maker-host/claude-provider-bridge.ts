import { normalizeProviderRequest } from '@cindy/model-compat';
import { createHash } from 'node:crypto';
import type { Effort, ProviderModelRecord } from '@cindy/model-providers';
import { reconcileOutboundReasoningEffort } from './outbound-reasoning-effort.js';
import { createPiProviderFetch, nativeBridgeApiKey } from './pi-provider-transport.js';
import { createResponsesHandler, type ResponsesBridgeHandler } from '@cindy/anthropic-responses-bridge';
import { ChatSseTranslator, classifySystemOrderError, coalesceLeadingSystemMessages, shouldRetrySystemNormalization, translateResponsesRequestWithContext, type ChatBridgeCapabilities, type ResponsesRequest } from '@cindy/responses-chat-bridge';

/** Reasoning blobs are private to a connection, not to a shared upstream URL. */
export function claudeProviderReasoningNamespace(url: string, providerId?: string): string {
  const material = providerId ? `${providerId}\0${url}` : url;
  return `cindy-provider-${createHash('sha256').update(material).digest('hex')}/`;
}

/**
 * 读错误正文用于判定,带上限:上游可能回超长正文,而这里只为识别一句措辞。
 * 判定句在正文前部(外层 error.message 里),截断不影响命中。
 */
const SYSTEM_ORDER_PROBE_LIMIT = 8 * 1024;

async function readBoundedErrorText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < SYSTEM_ORDER_PROBE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text.slice(0, SYSTEM_ORDER_PROBE_LIMIT);
  } catch {
    return text.slice(0, SYSTEM_ORDER_PROBE_LIMIT);
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Reuse the two existing translators without opening another server or forwarding client credentials. */
export function createClaudeProviderBridge(options: {
  url: string;
  protocol: 'openai-chat' | 'openai-responses';
  headers: Readonly<Record<string, string>>;
  efforts: readonly Effort[];
  supportsFastMode?: boolean;
  capabilities?: ChatBridgeCapabilities;
  model?: ProviderModelRecord;
  providerId?: string;
  nativeUpstream?: string;
  fetchImpl: typeof fetch;
}): ResponsesBridgeHandler {
  const nativeFetch = options.model ? createPiProviderFetch({ row: {
    ...options.model, supportsFastMode: options.supportsFastMode ?? options.model.supportsFastMode,
  },
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
    const translated = translateResponsesRequestWithContext(responses, { capabilities: {
      ...options.capabilities,
      ...(options.supportsFastMode ? { passthroughFields: [...(options.capabilities?.passthroughFields ?? []), 'service_tier'] } : {}),
    } });
    const send = (request: typeof translated.request): Promise<Response> => options.fetchImpl(options.url, {
      ...init,
      body: JSON.stringify(normalizeProviderRequest(request, { harness: 'claude-code', protocol: 'openai-chat', upstreamBase: options.url, model: responses.model }, { reasoningEffortAlreadyMapped: true })),
    });
    let upstream = await send(translated.request);
    // Claude Code 的 mid-conversation-system 会把 system 消息投到 user 轮次之后;
    // 只接受开头 system 的上游(Google 的 OpenAI 兼容层、Qwen 模板运行器)会整轮 400,
    // 且下一轮原样复现 → 会话卡死。这里与 responses-chat-bridge 的 handler 同口径重试一次:
    // 只并到开头、只限本次请求内,显式策略与原生 developer 语义仍然优先。
    if (!upstream.ok && options.capabilities?.systemMessagePolicy === undefined
      && options.capabilities?.developerRole !== 'developer') {
      // clone:不重试时错误正文要原样留给调用方(handler 读它做上游错误上报与呈现)。
      const rejection = classifySystemOrderError(upstream.status, await readBoundedErrorText(upstream.clone()));
      if (rejection && shouldRetrySystemNormalization(rejection, translated.request.messages)) {
        const coalesced = coalesceLeadingSystemMessages(translated.request.messages);
        if (coalesced !== translated.request.messages) {
          translated.request.messages = coalesced;
          // 首个响应被丢弃 → 立刻释放它的 body,别让废弃的连接/缓冲挂到本轮结束。
          void upstream.body?.cancel().catch(() => undefined);
          upstream = await send(translated.request);
        }
      }
    }
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
      ...(options.supportsFastMode ? { fastServiceTier: 'priority' } : {}),
    }],
    fetchImpl: upstreamFetch,
  });
}
