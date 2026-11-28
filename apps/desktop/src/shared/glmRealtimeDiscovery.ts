import type { ProviderRuntimeModelConfig } from '@cindy/model-providers';

export const GLM_REALTIME_FLASH = 'glm-realtime-flash';
export const GLM_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';

export function isGlmApiBase(base: string) {
  return base === GLM_API_BASE || base === GLM_API_BASE + '/';
}

// The ordinary mainland preset also uses these official interfaces for chat.
// The dedicated Coding Plan preset and custom endpoints never inherit this grant.
export function isGlmPresetRoute(base: string, presetId?: string) {
  return presetId === 'zhipu-glm-cn' && (
    isGlmApiBase(base) || /^https:\/\/open\.bigmodel\.cn\/api\/(?:coding\/paas\/v4|anthropic)\/?$/.test(base)
  );
}

export function hasGlmFlashDiscovery(model?: ProviderRuntimeModelConfig) {
  const found = model?.discoveredMetadata;
  return model?.id === GLM_REALTIME_FLASH && found?.mode === 'realtime'
    && found.modalities?.input.includes('audio') === true && found.modalities.output.includes('audio');
}

// A saved row can carry user overrides. Invalidate only the discovery evidence
// used by the GLM voice picker, leaving the row and its overrides in place.
export function clearGlmFlashDiscovery(model: ProviderRuntimeModelConfig): ProviderRuntimeModelConfig {
  if (!hasGlmFlashDiscovery(model)) return model;
  // Keep its realtime classification so losing access never turns it into a chat model.
  const { modalities: _modalities, ...metadata } = model.discoveredMetadata!;
  return { ...model, discoveredMetadata: metadata };
}
