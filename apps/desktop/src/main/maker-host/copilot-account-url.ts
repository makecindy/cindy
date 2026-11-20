import { copilotModelsUrl, PROVIDER_MODEL_CATALOG, providerPresetModelRecord } from '@cindy/model-providers';
import type { RequestTransformCtx, RoutingDecision } from '@cindy/anthropic-compat-proxy';

const copilotResponsesHeaders = providerPresetModelRecord('github-copilot', 'gpt-6.1-sol', 'openai-responses')
  ?.execution.pi.headers;

/** Fill only missing inference headers on the official account API. */
export function withCopilotResponsesHeaders(upstream: string, headers: Record<string, string> = {}): Record<string, string> {
  if (!copilotModelsUrl(upstream) || !copilotResponsesHeaders) return headers;
  const existing = new Set(Object.keys(headers).map(name => name.toLowerCase()));
  return {
    ...headers,
    ...Object.fromEntries(Object.entries(copilotResponsesHeaders).filter(([name]) => !existing.has(name.toLowerCase()))),
  };
}

/** Preserve the transparent route, including its path and payload. */
export function withCopilotForwardHeaders(
  decision: RoutingDecision | null,
  oauthResponses: boolean,
  ctx: RequestTransformCtx,
): RoutingDecision | null {
  if (!oauthResponses || ctx.method !== 'POST' || !decision?.upstreamOverride || decision.localHandler) return decision;
  if (!copilotModelsUrl(decision.upstreamOverride) || !copilotResponsesHeaders) return decision;
  const existing = new Set([
    ...Object.keys(ctx.headers), ...Object.keys(decision.headerOverride ?? {}), ...(decision.headerDelete ?? []),
  ].map(name => name.toLowerCase()));
  const defaults = Object.entries(copilotResponsesHeaders).filter(([name]) => !existing.has(name.toLowerCase()));
  if (defaults.length === 0) return decision;
  return { ...decision, headerOverride: { ...decision.headerOverride, ...Object.fromEntries(defaults) } };
}

/** Discovery has its own path and client identity, independent of inference API. */
export function copilotModelsRequest(value: string): { url: string; headers: Record<string, string> } | undefined {
  const url = copilotModelsUrl(value);
  if (!url) return undefined;
  const headers = Object.fromEntries(Object.entries(
    PROVIDER_MODEL_CATALOG.providers['github-copilot']?.[0]?.execution.pi.headers ?? {},
  ).map(([key, value]) => [key.toLowerCase(), value]));
  return { url: url.toString(), headers };
}

/** Copilot inference tokens assign one of three official account API hosts. */
export function resolveCopilotAccountUrl(value: string, token: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'api.individual.githubcopilot.com') {
      const host = token.match(/(?:^|;)proxy-ep=(proxy\.(?:individual|business|enterprise)\.githubcopilot\.com)(?:;|$)/)?.[1];
      if (host) {
        url.hostname = host.replace(/^proxy\./, 'api.');
        return url.toString().replace(/\/$/, '');
      }
    }
  } catch {
    // Keep invalid endpoints for the caller's existing URL validation/error path.
  }
  return value;
}
