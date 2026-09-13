import { sourceProviderForPreset } from './providerPresetIdentity.js';
import { providerEndpointBindings } from './providerEndpointTemplate.js';
import { declaredModelInterface } from './providerInterfaceRoutes.js';
import interfaceModels from "../catalog/provider-interface-models.json" with { type: "json" };
import generated from "../catalog/provider-models.json" with { type: "json" };
import type { ModelMetadata } from "./modelMetadataLayers.js";
import type { ModelCost, PiModelApi, ProviderWireProtocol } from "./types.js";

export interface ProviderModelRecord {
  id: string;
  name: string;
  upstream: string;
  contextWindow: number;
  maxOutput?: number;
  modalities: { input: string[]; output: string[] };
  supportsImageInput: boolean;
  reasoning: boolean;
  efforts: NonNullable<ModelMetadata["efforts"]>;
  defaultEffort: ModelMetadata["defaultEffort"];
  cost?: ModelCost;
  execution: {
    pi: {
      api: string;
      headers?: Record<string, string>;
      thinkingLevelMap?: Record<string, string | null>;
      compat?: Record<string, unknown>;
      samplingParams?: Record<string, unknown>;
    };
  };
}

const sourceCatalog = generated as unknown as {
  schemaVersion: number;
  generatedAt: string;
  providers: Record<string, ProviderModelRecord[]>;
};

export const PROVIDER_MODEL_CATALOG = { ...sourceCatalog, providers: { ...sourceCatalog.providers } };

// Official per-model contracts override the pinned Pi serializer choice, without
// borrowing another supplier's metadata or adding unlisted models to an account.
for (const [provider, declaration] of Object.entries(interfaceModels)) {
  const interfaces = declaration.models as Record<string, { api: string; endpoint: string }>;
  const rows = PROVIDER_MODEL_CATALOG.providers[provider];
  if (!rows) continue;
  PROVIDER_MODEL_CATALOG.providers[provider] = rows.map(row => {
    const declared = interfaces[row.id];
    if (!declared || new URL(declared.endpoint).origin !== new URL(row.upstream).origin) return row;
    return { ...row, upstream: declaredModelInterface(provider, row.id)!.baseUrl, execution: { ...row.execution, pi: { ...row.execution.pi, api: declared.api } } };
  });
}

const byEndpointAndId = new Map<string, ProviderModelRecord[]>();
const apisByEndpoint = new Map<string, Set<string>>();
const normalize = (url: string) => url.trim().replace(/\/+$/, "");
for (const rows of Object.values(PROVIDER_MODEL_CATALOG.providers)) {
  for (const row of rows) {
    const endpoint = normalize(row.upstream);
    const apis = apisByEndpoint.get(endpoint) ?? new Set<string>();
    apis.add(row.execution.pi.api);
    apisByEndpoint.set(endpoint, apis);
    const key = `${endpoint}\n${row.id}`;
    const existing = byEndpointAndId.get(key) ?? [];
    // Upstream may publish the exact same record in several subscription catalogs.
    // Duplicate evidence is not a conflict; differing records must stay ambiguous.
    if (!existing.some(candidate => JSON.stringify(candidate) === JSON.stringify(row))) {
      byEndpointAndId.set(key, [...existing, row]);
    }
  }
}

/** Exact route identity, shared by every harness. No fuzzy names or cross-proxy borrowing. */
export function providerModelRecord(
  modelId: string,
  upstream: string,
  protocol?: ProviderWireProtocol | PiModelApi,
  allowMixedProtocol = false,
): ProviderModelRecord | undefined {
  const api = protocol === "openai-chat" ? "openai-completions" : protocol;
  // A mixed catalog declares per-model APIs. A single-protocol endpoint does not
  // override a caller's explicitly selected transport.
  const mixed = allowMixedProtocol && (apisByEndpoint.get(normalize(upstream))?.size ?? 0) > 1;
  const matches = byEndpointAndId
    .get(`${normalize(upstream)}\n${modelId}`)
    ?.filter((row) => mixed || api === undefined || row.execution.pi.api === api);
  return matches?.length === 1 ? matches[0] : undefined;
}

/** Account-specific endpoints may still explicitly reference a maintained connection template. */
export function providerPresetModelRecord(presetId: string | undefined, modelId: string, api?: PiModelApi): ProviderModelRecord | undefined {
  if (!presetId) return undefined;
  const provider = sourceProviderForPreset(presetId);
  const matches = PROVIDER_MODEL_CATALOG.providers[provider]?.filter(row => row.id === modelId && (!api || row.execution.pi.api === api));
  return matches?.length === 1 ? matches[0] : undefined;
}

/** Preserve the upstream adapter identity, independently of a user's connection UUID. */
export function providerModelAdapterId(row: ProviderModelRecord): string | undefined {
  const matches = Object.entries(PROVIDER_MODEL_CATALOG.providers).filter(([, rows]) =>
    rows.some(candidate => candidate.id === row.id && (normalize(candidate.upstream) === normalize(row.upstream) || (candidate.upstream.includes('{') && providerEndpointBindings(candidate.upstream, row.upstream) !== null))
      && candidate.execution.pi.api === row.execution.pi.api));
  // Duplicated subscription catalogs can share endpoints; never guess between distinct identities.
  return matches.length === 1 ? matches[0][0] : undefined;
}

export function providerModelMetadata(row: ProviderModelRecord): ModelMetadata {
  return {
    name: row.name,
    contextWindow: row.contextWindow,
    ...(row.maxOutput ? { maxOutputTokens: row.maxOutput } : {}),
    modalities: row.modalities,
    supportsImageInput: row.supportsImageInput,
    efforts: row.efforts,
    defaultEffort: row.defaultEffort,
    ...(row.execution.pi.thinkingLevelMap?.off === null
      ? { reasoningRequired: true }
      : {}),
  };
}

/** Adapter only: reconstruct Pi's wire names from the same standard catalog used by UI/Codex. */
export function providerCatalogForPi() {
  return {
    generatedAt: PROVIDER_MODEL_CATALOG.generatedAt,
    providers: Object.fromEntries(
      Object.entries(PROVIDER_MODEL_CATALOG.providers).map(
        ([provider, rows]) => [
          provider,
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            provider,
            baseUrl: row.upstream,
            contextWindow: row.contextWindow,
            maxTokens: row.maxOutput,
            input: row.modalities.input,
            reasoning: row.reasoning,
            ...(row.cost ? { cost: row.cost } : {}),
            ...row.execution.pi,
          })),
        ],
      ),
    ),
  };
}

/** Offline membership for an exact, supported endpoint; never infer a proxy's inventory. */
export function providerModelsForRoute(
  upstream: string,
  protocol?: ProviderWireProtocol | PiModelApi,
): ProviderModelRecord[] {
  const api = protocol === "openai-chat" ? "openai-completions" : protocol;
  const models = Object.values(PROVIDER_MODEL_CATALOG.providers)
    .flat()
    .filter(
      (row) =>
        normalize(row.upstream) === normalize(upstream) &&
        (api === undefined || row.execution.pi.api === api),
    );
  return models.filter(
    (row) => providerModelRecord(row.id, upstream, protocol) === row,
  );
}
