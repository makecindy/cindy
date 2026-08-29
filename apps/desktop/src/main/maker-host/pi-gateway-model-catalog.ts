import type { PiModelApi } from '@cindy/model-providers';
import piModelCatalogJson from '@cindy/model-providers/pi-model-catalog' with { type: 'json' };

export interface BundledPiGatewayModelProfile {
  api: PiModelApi;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
}

interface PiCatalogRow extends BundledPiGatewayModelProfile {
  id: string;
  provider: string;
}

const catalog = piModelCatalogJson as unknown as {
  providers: Record<string, PiCatalogRow[]>;
};
const rows = Object.values(catalog.providers).flat();

const gatewayModelIdsByApi: Record<PiModelApi, ReadonlySet<string>> = {
  'anthropic-messages': new Set([
    'claude-fable-5',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'anthropic/claude-opus-5',
  ]),
  'openai-responses': new Set([
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'codex/gpt-5.4',
    'codex/gpt-5.4-mini',
    'codex/gpt-5.5',
    'codex/gpt-5.5:auto',
    'codex/gpt-5.6-luna',
    'codex/gpt-5.6-sol',
    'codex/gpt-5.6-terra',
    'meta/muse-spark-1.2',
    'x-ai-grok/grok-4.6',
    'x-ai/grok-4.5',
    'x-ai/grok-4.6',
  ]),
  'openai-completions': new Set([
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-flash-vision-exp',
    'deepseek/deepseek-v4-pro',
    'moonshot/kimi-k3',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k3',
    'qwen/qwen3.7-max',
    'qwen/qwen3.8-27b',
    'qwen/qwen3.8-flash',
    'qwen/qwen3.8-max',
    'tencent/hy3',
    'z-ai/glm-5.1',
    'z-ai/glm-5.2',
    'z-ai/glm-5.3',
    'z-ai/glm-5.3-flash',
  ]),
  'google-generative-ai': new Set([
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'google/gemini-3.6-flash',
    'google/gemini-3.7-flash',
  ]),
};

function normalizeModelId(modelId: string): string {
  return modelId.replace(/\[1m\]$/, '');
}

function bareGatewayModelId(modelId: string): string {
  return normalizeModelId(modelId).slice(normalizeModelId(modelId).lastIndexOf('/') + 1);
}

function authoritativeGatewayApi(modelId: string): PiModelApi | undefined {
  const normalized = normalizeModelId(modelId);
  for (const [api, ids] of Object.entries(gatewayModelIdsByApi) as Array<
    [PiModelApi, ReadonlySet<string>]
  >) {
    if (ids.has(normalized)) return api;
  }
  return undefined;
}

/** Preferred provider identity in Pi's complete bundled catalog. */
export function resolveBundledPiGatewayCatalogIdentity(
  modelId: string,
): { provider: string; modelId: string } | undefined {
  const bareId = bareGatewayModelId(modelId);
  const api = authoritativeGatewayApi(modelId);
  if (!api) return undefined;
  if (api === 'anthropic-messages') return { provider: 'anthropic', modelId: bareId };
  if (api === 'google-generative-ai') return { provider: 'google', modelId: bareId };
  if (bareId.startsWith('gpt-')) {
    return {
      provider: 'openai',
      modelId: bareId.endsWith(':auto') ? bareId.slice(0, -':auto'.length) : bareId,
    };
  }
  if (bareId.startsWith('grok-')) return { provider: 'xai', modelId: bareId };
  if (bareId.startsWith('deepseek-')) return { provider: 'deepseek', modelId: bareId };
  if (bareId.startsWith('glm-')) return { provider: 'zai', modelId: bareId };
  if (bareId.startsWith('kimi-')) return { provider: 'moonshotai', modelId: bareId };
  if (bareId.startsWith('qwen')) return { provider: 'qwen-token-plan-cn', modelId: bareId };
  return undefined;
}

/**
 * Resolve the current Gateway model through Cindy's version-matched Pi table.
 *
 * Model Access owns membership, public capabilities, and every explicit Pi wireProtocol. This
 * version-matched table is consulted only when a Pi member omits that field. Unknown identities
 * fail closed instead of guessing a provider or protocol.
 */
export function resolveBundledPiGatewayModelProfile(
  modelId: string,
): BundledPiGatewayModelProfile | undefined {
  const api = authoritativeGatewayApi(modelId);
  if (!api) return undefined;
  const normalized = normalizeModelId(modelId);
  const identity = resolveBundledPiGatewayCatalogIdentity(modelId);
  const exact = identity
    ? rows.find((row) => row.provider === identity.provider && row.id === identity.modelId)
    : rows.find((row) => `${row.provider}/${row.id}` === normalized);
  // Never borrow compat by bare ID across providers. An allowlisted Gateway identity may still
  // use its locally selected API, but provider-specific serialization metadata requires an exact
  // canonical provider/model row (or the exact binary probe in pi-host).
  const matched = exact;
  return {
    api,
    ...(matched?.compat ? { compat: structuredClone(matched.compat) } : {}),
    ...(matched?.samplingParams ? { samplingParams: structuredClone(matched.samplingParams) } : {}),
    ...(matched?.thinkingLevelMap ? { thinkingLevelMap: { ...matched.thinkingLevelMap } } : {}),
  };
}
