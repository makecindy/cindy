import { piSupportedEfforts } from "../../packages/model-providers/src/piThinkingLevels.mjs";

/** Pi is an import source. Persist Cindy's public field names, with transport-specific data
 * confined to execution.pi. Never copy credentials or arbitrary headers into a public catalog. */
export function toCindyProviderModel(row) {
  const efforts = piSupportedEfforts(row);
  const { id, provider, baseUrl, api } = row;
  if (
    !id ||
    !provider ||
    !api ||
    !Number.isSafeInteger(row.contextWindow) ||
    row.contextWindow <= 0
  ) {
    throw new Error(`Invalid upstream model: ${provider}/${id}`);
  }
  const url = baseUrl ? new URL(baseUrl) : null;
  if (url?.username || url?.password)
    throw new Error(`Credential-bearing catalog URL: ${provider}/${id}`);
  const allowedHeaders = new Set([
    "user-agent",
    "editor-version",
    "editor-plugin-version",
    "copilot-integration-id",
    "nvcf-poll-seconds",
  ]);
  const headers = Object.fromEntries(
    Object.entries(row.headers ?? {}).filter(
      ([key, value]) =>
        allowedHeaders.has(key.toLowerCase()) && typeof value === "string",
    ),
  );
  const cost = Object.fromEntries(
    Object.entries(row.cost ?? {}).filter(
      ([key, value]) =>
        ["input", "output", "cacheRead", "cacheWrite"].includes(key) &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0,
    ),
  );
  if (Array.isArray(row.cost?.tiers)) cost.tiers = row.cost.tiers;
  return {
    id,
    name: row.name ?? id,
    upstream: baseUrl ?? "",
    contextWindow: row.contextWindow,
    ...(row.maxTokens > 0 ? { maxOutput: row.maxTokens } : {}),
    modalities: { input: row.input ?? ["text"], output: ["text"] },
    supportsImageInput: row.input?.includes("image") ?? false,
    reasoning: row.reasoning === true,
    efforts,
    // Same product preference as defaultEffortForCapabilities; guarded by the import test.
    defaultEffort: ["medium", "high", "low", "xhigh", "max", "minimal", "ultra"].find(effort => efforts.includes(effort)) ?? null,
    ...(Object.keys(cost).length ? { cost } : {}),
    execution: {
      pi: {
        api,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(row.thinkingLevelMap
          ? { thinkingLevelMap: row.thinkingLevelMap }
          : {}),
        ...(row.compat ? { compat: row.compat } : {}),
        ...(row.samplingParams ? { samplingParams: row.samplingParams } : {}),
      },
    },
  };
}

export function toCindyCatalog(providers, generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    source: "pi",
    providers: Object.fromEntries(
      Object.entries(providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, models]) => [
          id,
          models
            .map(toCindyProviderModel)
            .sort((a, b) => a.id.localeCompare(b.id)),
        ]),
    ),
  };
}
