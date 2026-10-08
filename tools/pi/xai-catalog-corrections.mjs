// Official xAI Grok 4.6 reasoning ladder, retrieved 2026-08-16 from
// https://docs.x.ai/developers/model-capabilities/text/reasoning
// and https://docs.x.ai/developers/grok-4-6:
//   low | medium | high (default) | xhigh
// "xhigh is available on grok-4.6 and later. On models that do not support
// it, such as grok-4.5, requests with xhigh are treated as high."
// Pi's public catalog still ships grok-4.6 as supportsReasoningEffort:false
// with no thinkingLevelMap; re-sync must keep this overlay.

export const XAI_THINKING_CORRECTIONS = {
  "grok-4.6": {
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    defaultEffort: "high",
    supportsReasoningEffort: true,
  },
};

export function applyKnownXaiCorrections(models) {
  return models.map((model) => {
    const correction = XAI_THINKING_CORRECTIONS[model.id];
    if (!correction) return model;
    return {
      ...model,
      thinkingLevelMap: { ...correction.thinkingLevelMap },
      compat: {
        ...(model.compat ?? {}),
        supportsReasoningEffort: correction.supportsReasoningEffort,
      },
    };
  });
}

export function preferredDefaultEffort(
  modelId,
  efforts,
  fallbackDefaultEffort,
) {
  const requested = XAI_THINKING_CORRECTIONS[modelId]?.defaultEffort;
  if (requested && efforts.includes(requested)) return requested;
  return fallbackDefaultEffort(efforts);
}

// Official contract verified 2026-09-22:
// https://docs.x.ai/developers/grok-4-7
// https://docs.x.ai/developers/pricing
// No separate text output limit; Pi's finite maxTokens is bounded by the shared
// 500k context, and its serializer reserves space for the input on each request.
// Add only when absent; upstream capabilities and explicit defaults remain authoritative.
// Pi rows may omit Cindy's defaultEffort extension, so keep the official default then.
export function applyGrok47CatalogAddition(providers) {
  const existing = providers.xai?.find((row) => row.id === "grok-4.7");
  if (existing) {
    if (existing.defaultEffort == null) {
      providers.xai = providers.xai.map((row) =>
        row === existing ? { ...row, defaultEffort: "high" } : row,
      );
    }
    return providers;
  }
  providers.xai = [
    ...(providers.xai ?? []),
    {
      id: "grok-4.7",
      name: "Grok 4.7",
      provider: "xai",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 500_000,
      maxTokens: 500_000,
      defaultEffort: "high",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
      cost: {
        input: 2,
        output: 6,
        cacheRead: 0.5,
        cacheWrite: 0,
        tiers: [
          {
            inputTokensAbove: 199_999,
            input: 4,
            output: 12,
            cacheRead: 1,
            cacheWrite: 0,
          },
        ],
      },
    },
  ];
  return providers;
}

// Preserve Cindy's already shipped model addition when importing its older pinned binary.
export function applyPinnedXaiAdditions(providers, version) {
  if (
    version !== "0.85.1" ||
    providers.xai?.some((row) => row.id === "grok-build-0.1")
  )
    return;
  providers.xai = [
    ...(providers.xai ?? []),
    {
      id: "grok-build-0.1",
      name: "Grok Build 0.1",
      api: "openai-responses",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      compat: {
        supportsLongCacheRetention: false,
      },
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0.2,
        cacheWrite: 0,
      },
      contextWindow: 256000,
      maxTokens: 256000,
      thinkingLevelMap: {
        off: null,
        minimal: null,
      },
    },
  ];
}
