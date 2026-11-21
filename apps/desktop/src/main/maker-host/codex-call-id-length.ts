import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { shortenResponsesItemId, type RecoveryRule, type RequestTransform, type ResponseObserver } from '@cindy/anthropic-compat-proxy';
import { resolveProviderCompatibilityProfile } from '@cindy/model-compat';

function callId(item: unknown): string | undefined {
  if (item && typeof item === 'object' && 'call_id' in item && typeof item.call_id === 'string') {
    return item.call_id;
  }
}

/** Project a self-contained Responses replay onto the 64-character wire contract. */
export function shortenCodexCallIds(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || !('input' in body) || !Array.isArray(body.input)) return null;
  // With server-side history, an output may refer to a call held only by the upstream.
  // Preserve that reference. A length rejection can fall back to a full HTTP replay.
  if ('previous_response_id' in body && body.previous_response_id) return null;

  const reserved = new Set<string>();
  const oversized = new Set<string>();
  for (const item of body.input) {
    const id = callId(item);
    if (!id) continue;
    if (id.length > 64 && /^.{65}/su.test(id)) oversized.add(id);
    else reserved.add(id);
  }
  if (!oversized.size) return null;

  const aliases = new Map<string, string>();
  for (const id of oversized) {
    const digest = createHash('sha256').update(id).digest('hex').slice(0, 40);
    const base = 'call_' + digest;
    let alias = base;
    for (let suffix = 1; reserved.has(alias); suffix++) alias = base + '_' + suffix;
    reserved.add(alias);
    aliases.set(id, alias);
  }
  return { ...body, input: body.input.map(item => {
    const id = callId(item);
    const alias = id && aliases.get(id);
    return alias ? { ...item, call_id: alias } : item;
  }) };
}

export function isResponsesReplayPath(url: string): boolean {
  return /\/responses(?:\/compact)?\/?(?:\?.*)?$/.test(url);
}

export const shortenOpenAiReplayCallIds: RequestTransform = (body, ctx) => {
  if (!ctx.upstreamBase || !isResponsesReplayPath(ctx.url)) return null;
  const profile = resolveProviderCompatibilityProfile({
    harness: 'codex', protocol: 'openai-responses', upstreamBase: ctx.upstreamBase, model: '',
  });
  return profile?.id === 'openai' || profile?.id === 'openai-apikey' ? shortenCodexCallIds(body) : null;
};

// A custom Responses gateway can confirm the same wire limit in its own rejection.
export const responsesCallIdLengthRule: RecoveryRule = {
  id: 'responses_call_id_length',
  enabled: () => true,
  matches: text => /input\[\d+\]\.call_id\b[^\n]{0,150}?maximum length (?:of )?64\b/i.test(text),
  strip: body => {
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
    const next = shortenCodexCallIds(parsed);
    if (!next || !Array.isArray(next.input)) return null;
    // Recover both local identifier fields on the sole retry. Stored references
    // still address upstream items and cannot be renamed by this replay.
    const referencedIds = new Set<unknown>();
    for (const item of next.input) {
      if (item?.type === 'item_reference') referencedIds.add(item.id);
    }
    const input = next.input.map(item => typeof item?.id === 'string' && item.id.length > 64 && !referencedIds.has(item.id)
      ? { ...item, id: shortenResponsesItemId(item.id) }
      : item);
    return Buffer.from(JSON.stringify({ ...next, input }));
  },
  applyOnUnmatchedRetry: false,
  allowExtraRules: false,
  threadIdHeaders: ['thread-id'],
  useUpstreamModel: true,
};

const MAX_CALL_ID_ERROR_BYTES = 16 * 1024;

function decodeCallIdError(body: Buffer, encoding: string | undefined): string | null {
  const options = { maxOutputLength: MAX_CALL_ID_ERROR_BYTES };
  try {
    switch (encoding?.trim().toLowerCase()) {
      case undefined:
      case '':
      case 'identity': return body.toString('utf8');
      case 'gzip':
      case 'x-gzip': return gunzipSync(body, options).toString('utf8');
      case 'br': return brotliDecompressSync(body, options).toString('utf8');
      case 'deflate':
        try { return inflateSync(body, options).toString('utf8'); }
        catch { return inflateRawSync(body, options).toString('utf8'); }
      default: return null;
    }
  } catch {
    return null;
  }
}

/** Learn from final errors delivered to Codex, including the result of an attachment retry. */
export function createResponsesCallIdLimitObserver(
  remember: (threadId: string, model: string, upstreamBase: string) => void,
): ResponseObserver {
  return ctx => {
    if ((ctx.status !== 400 && ctx.status !== 422) || ctx.method !== 'POST' || !isResponsesReplayPath(ctx.url)) return null;
    const threadId = ctx.requestHeaders['thread-id']?.trim();
    if (!threadId) return null;

    const chunks: Buffer[] = [];
    let size = 0;
    return {
      onData: chunk => {
        if (size > MAX_CALL_ID_ERROR_BYTES) return;
        size += chunk.length;
        if (size > MAX_CALL_ID_ERROR_BYTES) chunks.length = 0;
        else chunks.push(chunk);
      },
      onEnd: () => {
        if (!chunks.length) return;
        const error = decodeCallIdError(Buffer.concat(chunks, size), ctx.responseHeaders['content-encoding']);
        if (!error || !responsesCallIdLengthRule.matches(error)) return;
        let request: unknown;
        try { request = JSON.parse(ctx.requestBody.toString('utf8')); } catch { return; }
        if (request && typeof request === 'object' && 'model' in request && typeof request.model === 'string'
          && shortenCodexCallIds(request)) remember(threadId, request.model, ctx.upstreamBase);
      },
    };
  };
}
