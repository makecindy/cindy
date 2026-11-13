import { piSupportedEfforts } from "../../packages/model-providers/src/piThinkingLevels.mjs";

// Copilot rejects Astra on /chat/completions (makecindy/cindy#9863).
// Correct this exact source route on both bundle imports and online refreshes;
// nativeApi describes model identity and is not a general execution override.
// Responses adapter metadata: earendil-works/pi#9253 (generate-models.ts).
function correctCopilotAstraApi(row) {
  return row.provider === 'github-copilot' && row.id === 'gpt-6-astra' &&
    row.baseUrl === 'https://api.individual.githubcopilot.com' && row.api === 'openai-completions'
    ? {
        ...row, api: 'openai-responses',
        thinkingLevelMap: {
          off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
        },
        // Chat compatibility flags must not survive a change of adapter.
        compat: { supportsOpenAIGrammarTools: true },
      }
    : row;
}

// #10269 verified this exact Copilot route with Argon's IDE Chat configuration.
// Reuse the source adapter instead of maintaining a second set of versioned
// headers. Capacity, pricing, modalities and reasoning remain unknown. A future
// upstream Carbon declaration is authoritative, including a different API.
function withCopilotCarbon(models) {
  if (models.some(row => row?.id === 'gemini-4-carbon')) return models;
  const shared = models.find(row => row?.provider === 'github-copilot' &&
    row.id === 'gemini-4-argon' && row.baseUrl === 'https://api.individual.githubcopilot.com' &&
    row.api === 'openai-completions');
  if (!shared) return models;
  return [...models, {
    id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', provider: shared.provider,
    baseUrl: shared.baseUrl, api: shared.api, headers: shared.headers, compat: shared.compat,
  }];
}

/** Pi is an import source. Persist Cindy's public field names, with transport-specific data
 * confined to execution.pi. Never copy credentials or arbitrary headers into a public catalog. */
export function toCindyProviderModel(row) {
  row = correctCopilotAstraApi(row);
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
        ...(row.headers !== undefined ? { headers } : {}),
        ...(row.thinkingLevelMap
          ? { thinkingLevelMap: row.thinkingLevelMap }
          : {}),
        ...(row.compat ? { compat: row.compat } : {}),
        ...(row.samplingParams ? { samplingParams: row.samplingParams } : {}),
      },
    },
  };
}

export function toCindyCatalog(providers, generatedAt, { previous, onError, incompleteProviders = [] } = {}) {
  const incomplete = new Set(incompleteProviders);
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
            const prior = new Map((previous?.providers?.[id] ?? []).map(row => [row.id, row]));
            const converted = new Map();
            let complete = !incomplete.has(id);
            for (const sourceRow of id === 'github-copilot' ? withCopilotCarbon(models) : models) {
              try {
                const row = correctCopilotAstraApi(sourceRow);
                const old = prior.get(row?.id);
                const sameConnection = old?.upstream === (row.baseUrl ?? '') && old?.execution.pi.api === row.api;
                const adapterDefaults = sameConnection ? old.execution.pi : {};
                // Convert after filling missing adapter fields, so efforts and
                // the request mapping stay consistent. Explicit {} replaces.
                const next = toCindyProviderModel({ ...adapterDefaults, ...row,
                  ...Object.fromEntries(['headers', 'thinkingLevelMap', 'compat', 'samplingParams']
                    .filter(key => row[key] === undefined && adapterDefaults[key] !== undefined)
                    .map(key => [key, adapterDefaults[key]])),
                });
                // Last-good channel metadata is valid only for the same route.
                // A moved model remains imported; shared model defaults are
                // resolved separately rather than copied from the old channel.
                converted.set(next.id, sameConnection ? { ...old, ...next } : next);
              } catch (error) {
                if (!onError) throw error;
                complete = false;
                onError(error);
              }
            }
            if (!complete) for (const [modelId, old] of prior) {
              if (!converted.has(modelId)) converted.set(modelId, old);
            }
            return [...converted.values()].sort((a, b) => a.id.localeCompare(b.id));
          })(),
        ]),
    ),
  };
}
