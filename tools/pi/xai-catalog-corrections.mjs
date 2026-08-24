// Official xAI Grok 4.6 reasoning ladder, retrieved 2026-08-16 from
// https://docs.x.ai/developers/model-capabilities/text/reasoning
// and https://docs.x.ai/developers/grok-4-6:
//   low | medium | high (default) | xhigh
// "xhigh is available on grok-4.6 and later. On models that do not support
// it, such as grok-4.5, requests with xhigh are treated as high."
// Pi's public catalog still ships grok-4.6 as supportsReasoningEffort:false
// with no thinkingLevelMap; re-sync must keep this overlay.

export const XAI_THINKING_CORRECTIONS = {
  'grok-4.6': {
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    },
    defaultEffort: 'high',
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

export function preferredDefaultEffort(modelId, efforts, fallbackDefaultEffort) {
  const requested = XAI_THINKING_CORRECTIONS[modelId]?.defaultEffort;
  if (requested && efforts.includes(requested)) return requested;
  return fallbackDefaultEffort(efforts);
}
