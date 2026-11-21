import { createHash } from 'node:crypto';
import type { RecoveryRule, RequestTransform } from '@cindy/anthropic-compat-proxy';
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
    return next ? Buffer.from(JSON.stringify(next)) : null;
  },
  applyOnUnmatchedRetry: false,
  useUpstreamModel: true,
};
