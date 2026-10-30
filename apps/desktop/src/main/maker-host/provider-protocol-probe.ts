import {
  appendProviderRequestPath, isLoopbackProviderUrl, providerProtocolCandidates,
  providerModelRecord, providerPresetModelRecord,
  type PiModelApi, type ProviderProtocolCandidate, type ProviderModelRecord,
} from '@cindy/model-providers';
import type { ProviderConnectionProbeSpec, ProviderConnectionTestResult, ProtocolProbeDecision } from '../../shared/providerConnectionTest.js';
import { classifyProviderError } from '../../shared/providerErrors.js';
import { invocationModelRecord, probePiProvider, readBoundedResponseText } from './pi-provider-transport.js';
import { withOpenCodeGoSessionHeader } from './opencode-go-session.js';

type ProbeSpec = ProviderConnectionProbeSpec & { nativeModel?: ProviderModelRecord };

const API: Record<ProviderProtocolCandidate['wireProtocol'], PiModelApi> = {
  'openai-chat': 'openai-completions', 'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages', 'google-generative-ai': 'google-generative-ai',
};
const BLOCKED = new Set(['AUTH_INVALID', 'AUTH_FORBIDDEN', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'MODEL_NOT_FOUND']);

/** Only explicit pre-generation protocol/route rejections permit another paid request. */
function failure(status: number | undefined, bodyText: string, accepted: boolean): ProviderConnectionTestResult {
  if (accepted && bodyText) {
    try {
      const error = JSON.parse(bodyText);
      const type = String(error.type ?? error.code ?? '');
      status = typeof error.status === 'number' ? error.status
        : /auth|invalid_api_key/.test(type) ? 401 : /quota|balance/.test(type) ? 402
          : /rate_limit/.test(type) ? 429 : /model_not_found/.test(type) ? 404 : 400;
    } catch { /* Unstructured streamed errors remain inconclusive. */ }
  }
  const cls = classifyProviderError({ status, bodyText });
  let decision: ProtocolProbeDecision = BLOCKED.has(cls.code) ? 'blocked' : 'inconclusive';
  if (!accepted && [400, 404, 405, 415, 422].includes(status ?? 0)
    && !BLOCKED.has(cls.code)
    && /unsupported_protocol|unsupported_endpoint|route_not_found|(?:protocol|endpoint|route) (?:is )?(?:not supported|not found)/i.test(bodyText)) {
    decision = 'next';
  }
  return { ok: false, code: decision === 'next' && cls.code === 'UNKNOWN' ? 'WIRE_INCOMPATIBLE' : cls.code,
    status, latencyMs: 0, decision };
}

/** Observe protocol termination as well as SDK parsing: empty or truncated streams cannot pass. */
function observeSse(wire: ProviderProtocolCandidate['wireProtocol']) {
  let buffer = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  const state = { terminal: false, generated: false, error: '' };
  const frame = (text: string) => {
    const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const value = JSON.parse(data);
    if (value.error) { state.error = JSON.stringify(value.error); return; }
    if (wire === 'openai-chat') {
      for (const choice of value.choices ?? []) {
        if (choice.delta?.content || choice.delta?.reasoning_content) state.generated = true;
        if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') state.terminal = true;
      }
    } else if (wire === 'openai-responses') {
      if (value.type === 'response.output_text.delta' || value.type === 'response.reasoning_text.delta') state.generated = true;
      if (value.type === 'response.completed' || (value.type === 'response.incomplete'
        && value.response?.incomplete_details?.reason === 'max_output_tokens')) state.terminal = true;
      if (value.type === 'response.failed' || value.type === 'error') state.error = JSON.stringify(value);
    } else if (wire === 'anthropic-messages') {
      if (value.type === 'content_block_delta' && (value.delta?.text || value.delta?.thinking)) state.generated = true;
      if (value.type === 'message_stop') state.terminal = true;
    } else {
      for (const candidate of value.candidates ?? []) {
        if (candidate.content?.parts?.some((part: { text?: string }) => part.text)) state.generated = true;
        if (['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) state.terminal = true;
      }
    }
  };
  const consume = (chunk: Uint8Array, final = false) => {
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) throw new Error('probe response exceeds diagnostic budget');
    buffer += decoder.decode(chunk, { stream: !final });
    buffer = buffer.replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      frame(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
    }
    if (buffer.length > 64 * 1024) throw new Error('probe SSE frame exceeds diagnostic budget');
    if (final && buffer.trim()) frame(buffer);
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { consume(chunk); controller.enqueue(chunk); },
    flush() { consume(new Uint8Array(), true); },
  });
  return { state, transform };
}

/** Native adapters own payloads. Google needs bounded HTTP because its SDK rejects injected
 * fetch; it uses the same native base, auth and streaming endpoint. */
async function attempt(
  spec: ProbeSpec, candidate: ProviderProtocolCandidate,
  fetchImpl: typeof fetch, signal: AbortSignal,
): Promise<ProviderConnectionTestResult> {
  let accepted = false;
  let rejected: ProviderConnectionTestResult | undefined;
  let networkCode: string | undefined;
  const observer = observeSse(candidate.wireProtocol);
  const guardedFetch: typeof fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== new URL(candidate.baseUrl).origin) throw new Error('probe destination changed');
    let response: Response;
    const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const credentialNames = ['authorization', 'x-api-key', 'x-goog-api-key'];
    if (!spec.apiKey || spec.authMethod === 'none') {
      for (const name of credentialNames) requestHeaders.delete(name);
      if (spec.authMethod !== 'none') {
        const originalHeaders = new Headers(spec.headers);
        for (const name of credentialNames) {
          const value = originalHeaders.get(name);
          if (value) requestHeaders.set(name, value);
        }
      }
    }
    for (const name of ['authorization', 'x-api-key']) {
      if (requestHeaders.get(name)?.includes('cindy-probe-header-auth')) requestHeaders.delete(name);
    }
    try { response = await fetchImpl(input, { ...init, headers: requestHeaders, redirect: 'error', signal }); }
    catch (error) {
      networkCode = (error as { cause?: { code?: string }; name?: string }).cause?.code
        ?? (error as { name?: string }).name;
      throw error;
    }
    if (!response.ok) {
      const text = await readBoundedResponseText(response);
      rejected = failure(response.status, text, accepted);
      return new Response(text, { status: response.status, headers: response.headers });
    }
    accepted = true;
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('expected a native event stream');
    }
    return new Response(response.body.pipeThrough(observer.transform), { status: response.status, headers: response.headers });
  };
  try {
    const api = API[candidate.wireProtocol];
    const known = providerModelRecord(spec.modelId, candidate.baseUrl, api)
      ?? providerPresetModelRecord(spec.catalogPresetId, spec.modelId, api);
    const row = spec.nativeModel ?? known ?? invocationModelRecord({ id: spec.modelId, name: spec.modelId, group: 'custom',
      contextWindow: 4096, maxOutput: 256, efforts: [], defaultEffort: null, api }, candidate.baseUrl)!;
    const headers = withOpenCodeGoSessionHeader(Object.fromEntries(Object.entries(spec.headers ?? {}).filter(([name]) =>
      !(spec.apiKey || spec.authMethod === 'none') || !['authorization', 'x-api-key', 'x-goog-api-key'].includes(name.toLowerCase()))),
      { providerId: spec.catalogPresetId ?? '', catalogPresetId: spec.catalogPresetId, upstream: candidate.baseUrl }) ?? {};
    const key = spec.authMethod === 'none' ? 'cindy-local-provider' : spec.apiKey
      ?? new Headers(headers).get('authorization')?.replace(/^Bearer /i, '')
      ?? new Headers(headers).get('x-api-key') ?? new Headers(headers).get('x-goog-api-key')
      ?? (Object.keys(headers).length ? 'cindy-probe-header-auth' : '');
    if (!key && spec.authMethod !== 'none') return { ok: false, code: 'AUTH_INVALID', latencyMs: 0, decision: 'blocked' };
    let nativeOk = true;
    let nativeGenerated = false;
    if (api === 'google-generative-ai') {
      const response = await guardedFetch(appendProviderRequestPath(candidate.baseUrl,
        '/models/' + encodeURIComponent(spec.modelId.replace(/^models\//, '')) + ':streamGenerateContent?alt=sse'), {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json',
          ...(spec.authMethod !== 'none' && key ? { 'x-goog-api-key': key } : {}) },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
          generationConfig: { maxOutputTokens: Math.min(256, row.maxOutput ?? 256) } }),
      });
      if (response.ok && response.body) {
        const reader = response.body.getReader();
        try { while (!(await reader.read()).done) { /* observer validates every frame */ } }
        finally { reader.releaseLock(); }
      }
    } else {
      const result = await probePiProvider({ row, providerId: spec.catalogPresetId ?? 'custom-probe', upstream: candidate.baseUrl,
        apiKey: key, headers, fetchImpl: guardedFetch }, signal, 256);
      nativeOk = result.stopReason === 'stop' || result.stopReason === 'length';
      nativeGenerated = result.content.some(block => (block.type === 'text' && Boolean(block.text))
        || (block.type === 'thinking' && Boolean(block.thinking)));
    }
    if (signal.aborted) return { ok: false, code: 'TIMEOUT', latencyMs: 0, decision: 'inconclusive' };
    if (rejected) return rejected;
    if (!accepted && networkCode) {
      return { ok: false, code: classifyProviderError({ networkErrorCode: networkCode }).code, latencyMs: 0, decision: 'inconclusive' };
    }
    if (nativeOk && observer.state.terminal && (observer.state.generated || nativeGenerated) && !observer.state.error) {
      return { ok: true, latencyMs: 0, decision: 'success', selected: candidate };
    }
    return failure(accepted ? 200 : undefined, observer.state.error, accepted);
  } catch {
    if (rejected) return rejected;
    const cls = classifyProviderError({ networkErrorCode: signal.aborted ? 'TimeoutError' : networkCode ?? 'UNKNOWN' });
    return { ok: false, code: cls.code, latencyMs: 0, decision: 'inconclusive' };
  }
}

/** One bounded operation: no parallel candidates, SDK retry, or retry after ambiguous execution. */
export async function probeProviderProtocols(
  spec: ProbeSpec, auto: boolean, fetchImpl: typeof fetch, signal?: AbortSignal,
): Promise<ProviderConnectionTestResult> {
  const start = Date.now();
  if (spec.authMethod === 'none' && !isLoopbackProviderUrl(spec.baseUrl)) throw new TypeError('no-auth probe requires loopback');
  let candidates: ProviderProtocolCandidate[];
  try {
    candidates = auto ? providerProtocolCandidates(spec.baseUrl, spec.wireProtocol)
      : [{ baseUrl: spec.baseUrl, wireProtocol: spec.wireProtocol ?? 'openai-chat' }];
  } catch { return { ok: false, code: 'ENDPOINT_NOT_FOUND', latencyMs: 0, decision: 'inconclusive' }; }
  // Bound interactive auto-detection without shortening explicit single-route tests.
  const overall = AbortSignal.any([AbortSignal.timeout(auto ? 15_000 : 60_000), ...(signal ? [signal] : [])]);
  const attempts: NonNullable<ProviderConnectionTestResult['attempts']> = [];
  let result: ProviderConnectionTestResult = { ok: false, code: 'UNKNOWN', latencyMs: 0, decision: 'inconclusive' };
  for (const candidate of candidates) {
    if (overall.aborted) break;
    const current = AbortSignal.any([overall, AbortSignal.timeout(auto ? 8_000 : 20_000)]);
    result = await attempt(spec, candidate, fetchImpl, current);
    attempts.push({ ...candidate, decision: result.decision!, code: result.code, status: result.status });
    if (result.decision !== 'next') break;
  }
  if (signal?.aborted) result = { ok: false, latencyMs: 0, decision: 'cancelled' };
  else if (overall.aborted) result = { ok: false, code: 'TIMEOUT', latencyMs: 0, decision: 'inconclusive' };
  return { ...result, latencyMs: Date.now() - start, attempts };
}
