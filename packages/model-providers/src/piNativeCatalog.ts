import { providerCatalogForPi } from "./providerModelCatalog.js";

import { defaultEffortForCapabilities } from "./effortResolution.js";
import { piSupportedEfforts } from "./piThinkingLevels.mjs";
import type { ModelMetadata } from "./modelMetadataLayers.js";
import type {
  CatalogModel,
  ModelCost,
  PiModelApi,
  ProviderWireProtocol,
} from "./types.js";

interface PiCatalogRow {
  id: string;
  name?: string;
  api?: string;
  provider: string;
  baseUrl?: string;
  contextWindow: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>> | null;
  cost?: ModelCost;
}

const PI_CATALOG = providerCatalogForPi() as unknown as {
  generatedAt: string;
  providers: Record<string, PiCatalogRow[]>;
};

function portablePiApi(api: string | undefined): PiModelApi | undefined {
  switch (api) {
    // Same Responses wire family; pi-host retains the specialized subscription adapter.
    case "openai-codex-responses":
      return "openai-responses";
    case "anthropic-messages":
    case "openai-responses":
    case "openai-completions":
    case "google-generative-ai":
      return api;
    default:
      return undefined;
  }
}

/**
 * Convert Pi's pinned native catalog into a legacy/offline Pi declaration fallback.
 * Explicit server declarations replace this public membership list; native transport
 * compatibility is consumed separately by pi-host.
 *
 * The OpenAI subscription route keeps Cindy's `chatgpt/` identity prefix, while its native
 * `openai-codex-responses` transport remains in the raw snapshot for pi-host to materialize.
 */
export function piNativeCatalogModels(
  piProviderId: string,
  options: { idPrefix?: string; group?: string } = {},
): CatalogModel[] {
  const rows = PI_CATALOG.providers[piProviderId];
  if (!rows) {
    throw new Error(
      `[model-providers] Pi catalog missing provider '${piProviderId}'`,
    );
  }
  return rows.map((row, index) => {
    if (
      row.provider !== piProviderId ||
      !Number.isFinite(row.contextWindow) ||
      row.contextWindow <= 0
    ) {
      throw new Error(
        `[model-providers] invalid Pi catalog row '${piProviderId}/${row.id}'`,
      );
    }
    const efforts = piSupportedEfforts(row);
    const piApi = portablePiApi(row.api);
    return {
      id: `${options.idPrefix ?? ""}${row.id}`,
      name: row.name ?? row.id,
      ...(options.group ? { group: options.group } : {}),
      sortOrder: index,
      contextWindow: row.contextWindow,
      contextWindowVerified: true,
      ...(Number.isFinite(row.maxTokens) && row.maxTokens! > 0
        ? { maxOutput: row.maxTokens }
        : {}),
      efforts,
      discoveredMetadata: {
        ...(row.name ? { name: row.name } : {}),
        contextWindow: row.contextWindow,
        efforts,
        ...(row.maxTokens ? { maxOutputTokens: row.maxTokens } : {}),
        ...(row.input
          ? { supportsImageInput: row.input.includes("image") }
          : {}),
      },
      defaultEffort: defaultEffortForCapabilities(efforts),
      status: "active",
      ...(row.input?.includes("image") ? { supportsImageInput: true } : {}),
      ...(row.cost ? { cost: row.cost } : {}),
      ...(piApi ? { piApi } : {}),
    };
  });
}

function wireProtocolToPiCatalogApi(protocol: ProviderWireProtocol): string {
  switch (protocol) {
    case "anthropic-messages":
      return "anthropic-messages";
    case "openai-responses":
      return "openai-responses";
    case "openai-chat":
      return "openai-completions";
  }
}

/**
 * Whether a user runtime still points at the official Pi route of `piProviderId`
 * (single catalog baseUrl and API family, same as pi-host's official-model overlay gate).
 * A hand-edited endpoint or protocol must not borrow the official capability table.
 */
export function piNativeCatalogRouteMatches(
  piProviderId: string,
  baseUrl: string,
  wireProtocol: ProviderWireProtocol | undefined,
): boolean {
  const rows = PI_CATALOG.providers[piProviderId];
  if (!rows?.length) return false;
  const baseUrls = new Set(
    rows.map((row) => (row.baseUrl ?? "").trim().replace(/\/+$/, "")),
  );
  const apis = new Set(rows.map((row) => row.api));
  return (
    baseUrls.size === 1 &&
    baseUrls.has(baseUrl.trim().replace(/\/+$/, "")) &&
    apis.size === 1 &&
    (wireProtocol === undefined ||
      apis.has(wireProtocolToPiCatalogApi(wireProtocol)))
  );
}

/**
 * Capability defaults of one official Pi catalog model, for user sources that are marked
 * with `piCatalogProviderId` but whose stored model lacks reasoning metadata (sources created
 * before `catalogPresetId` existed). Keeps the Orca/route projection on the same capability
 * table pi-host materializes at runtime; explicit user settings still override these defaults.
 */
export function piNativeCatalogModelDefaults(
  piProviderId: string,
  modelId: string,
): ModelMetadata | undefined {
  const row = PI_CATALOG.providers[piProviderId]?.find(
    (candidate) => candidate.id === modelId,
  );
  if (!row) return undefined;
  const efforts = piSupportedEfforts(row);
  return {
    contextWindow: row.contextWindow,
    ...(Number.isFinite(row.maxTokens) && row.maxTokens! > 0
      ? { maxOutputTokens: row.maxTokens }
      : {}),
    efforts,
    defaultEffort: defaultEffortForCapabilities(efforts),
    ...(row.input ? { supportsImageInput: row.input.includes("image") } : {}),
  };
}
