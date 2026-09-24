import { piSupportedEfforts } from "../../packages/model-providers/src/piThinkingLevels.mjs";

/** Pi is an import source. Persist Cindy's public field names, with transport-specific data
 * confined to execution.pi. Never copy credentials or arbitrary headers into a public catalog. */
export function toCindyProviderModel(row) {
  // Exact known routes only: Gemini 3.8 Flash rejects minimal. Keep the correction
  // in the import path so both online refreshes and bundle imports retain it.
  // https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
  const gemini38Ids = {
    google: "gemini-3.8-flash",
    "google-vertex": "gemini-3.8-flash",
    opencode: "gemini-3.8-flash",
    "github-copilot": "gemini-3.8-flash",
    "vercel-ai-gateway": "google/gemini-3.8-flash",
  };
  if (
    Object.hasOwn(gemini38Ids, row.provider) &&
    gemini38Ids[row.provider] === row.id
  ) {
    row = {
      ...row,
      thinkingLevelMap: { ...row.thinkingLevelMap, minimal: null },
    };
  }
  const efforts = piSupportedEfforts(row);
  const { id, provider, baseUrl, api } = row;
  if (
    typeof id !== 'string' || !id.trim() || id.length > 256 ||
    typeof provider !== 'string' || !provider.trim() ||
    typeof api !== 'string' || !api.trim()
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
    name: typeof row.name === 'string' && row.name.trim() ? row.name : id,
    upstream: baseUrl ?? "",
    ...(Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0 ? { contextWindow: row.contextWindow } : {}),
    ...(row.maxTokens > 0 ? { maxOutput: row.maxTokens } : {}),
    ...(Array.isArray(row.input) ? {
      modalities: { input: row.input, output: row.output ?? ["text"] },
      supportsImageInput: row.input.includes("image"),
    } : {}),
    ...(typeof row.reasoning === "boolean" ? { reasoning: row.reasoning, efforts } : {}),
    ...Object.fromEntries(["supportsFastMode", "supportsToolCalls", "reasoningRequired"]
      .filter(key => typeof row[key] === "boolean").map(key => [key, row[key]])),
    ...(['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'].includes(row.nativeApi)
      ? { nativeApi: row.nativeApi } : {}),
    // Preserve a supported explicit default; otherwise use Cindy's generic preference.
    ...(typeof row.reasoning === "boolean" ? { defaultEffort: row.defaultEffort === null ? null : efforts.includes(row.defaultEffort)
      ? row.defaultEffort
      : (["medium", "high", "low", "xhigh", "max", "minimal", "ultra"].find(
          (effort) => efforts.includes(effort),
        ) ?? null) } : {}),
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

export function toCindyCatalog(providers, generatedAt, { previous, onError } = {}) {
  return {
    schemaVersion: 1,
    generatedAt,
    source: "pi",
    providers: Object.fromEntries(
      Object.entries(providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, models]) => [
          id,
          (() => {
            const converted = new Map((previous?.providers?.[id] ?? []).map(row => [row.id, row]));
            for (const row of models) {
              try {
                const next = toCindyProviderModel(row);
                converted.set(next.id, { ...converted.get(next.id), ...next });
              } catch (error) {
                if (!onError) throw error;
                onError(error);
              }
            }
            return [...converted.values()].sort((a, b) => a.id.localeCompare(b.id));
          })(),
        ]),
    ),
  };
}
