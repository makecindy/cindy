import {
  DEFAULT_UTILITY_MODEL,
  DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN,
  DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
  estimateUtilityModelCostUsd,
  getUtilityModelProfile,
  getUtilityModelProfiles,
  isUtilityModelProviderKind,
  resolveUtilityModelProviderKindAlias,
  type UtilityModelAuthKind,
  type UtilityModelPricing,
  type UtilityModelProviderKind,
  type UtilityModelSettingsTab,
  type UtilityModelTransport,
} from './utilityModelProfiles.js';
import {
  decodeCatalogModelPin,
  encodeCatalogModelPin,
  type CatalogModelPinRoute,
} from './catalogModelPin.js';

export type VoiceInputRefinerTransport = UtilityModelTransport;
export type VoiceInputRefinerAuthKind = UtilityModelAuthKind;
export type VoiceInputRefinerSettingsTab = UtilityModelSettingsTab;
export type VoiceInputRefinerPricing = UtilityModelPricing;

export type VoiceInputRefinerProfile = {
  id: string;
  model: string;
  transport: VoiceInputRefinerTransport;
  auth: VoiceInputRefinerAuthKind;
  settingsTab: VoiceInputRefinerSettingsTab;
  pricing?: VoiceInputRefinerPricing;
  missingCredentialMessage: string;
};

export const DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND = DEFAULT_UTILITY_MODEL_PROVIDER_KIND;
export const DEFAULT_VOICE_INPUT_REFINER_MODEL = DEFAULT_UTILITY_MODEL;
export const DEFAULT_VOICE_INPUT_REFINER_PROVIDER_CHAIN = DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN;

/**
 * The auxiliary chain may contain an exact catalog pin whose model is not in
 * the static utility profile table yet (for example a newly released Cindy
 * Gateway model). Keep that pin as the runtime identity so voice refinement
 * does not silently replace it with a different model.
 */
export type VoiceInputRefinerCatalogProviderKind = string & {
  readonly __voiceInputRefinerCatalogProviderKind: unique symbol;
};
export type VoiceInputRefinerProviderKind =
  | UtilityModelProviderKind
  | VoiceInputRefinerCatalogProviderKind;

const CATALOG_VOICE_REFINER_PROVIDERS = new Set(['openai', 'xd']);

export function voiceInputRefinerProviderKindForCatalogRoute(
  route: CatalogModelPinRoute,
): VoiceInputRefinerCatalogProviderKind | null {
  if (route.agentKind !== 'codex' || !CATALOG_VOICE_REFINER_PROVIDERS.has(route.providerId)) {
    return null;
  }
  return encodeCatalogModelPin(route) as VoiceInputRefinerCatalogProviderKind;
}

function catalogVoiceRefinerProfile(
  provider: VoiceInputRefinerCatalogProviderKind,
): VoiceInputRefinerProfile | null {
  const route = decodeCatalogModelPin(provider);
  if (!route) return null;
  const providerKind = voiceInputRefinerProviderKindForCatalogRoute(route);
  if (providerKind !== provider) return null;
  const isCodexResponses = route.providerId === 'openai';
  const transport: VoiceInputRefinerTransport = isCodexResponses
    ? 'codex-responses'
    : 'litellm-chat-completions';
  // Catalog pins are intentionally kept as the runtime identity, but known
  // models should still use the static quote already used by the matching
  // utility transport. Unknown catalog models remain unpriced rather than
  // pretending that a reference quote is a live Gateway price.
  const pricing = getUtilityModelProfiles().find(
    (profile) => profile.transport === transport
      && profile.model.trim().toLowerCase() === route.model.trim().toLowerCase(),
  )?.pricing;
  return {
    id: provider,
    model: route.model,
    transport,
    auth: isCodexResponses ? 'codex' : 'api-key',
    settingsTab: 'providers',
    ...(pricing ? { pricing } : {}),
    missingCredentialMessage: isCodexResponses
      ? 'Codex ChatGPT login is required for voice input refinement.'
      : 'API key is required for LiteLLM voice input refinement.',
  };
}

export function getVoiceInputRefinerProfile(provider: VoiceInputRefinerProviderKind): VoiceInputRefinerProfile {
  const profile = isUtilityModelProviderKind(provider)
    ? getUtilityModelProfile(provider)
    : catalogVoiceRefinerProfile(provider);
  if (!profile) throw new Error(`Unknown voice input refiner provider ${provider}`);
  return {
    ...profile,
    missingCredentialMessage: profile.auth === 'codex'
      ? 'Codex ChatGPT login is required for voice input refinement.'
      : 'API key is required for LiteLLM voice input refinement.',
  };
}

export function getVoiceInputRefinerProfiles(): VoiceInputRefinerProfile[] {
  return getUtilityModelProfiles().map((profile) => getVoiceInputRefinerProfile(profile.id as VoiceInputRefinerProviderKind));
}

export function isVoiceInputRefinerProviderKind(value: string): value is VoiceInputRefinerProviderKind {
  return isUtilityModelProviderKind(value)
    || Boolean(catalogVoiceRefinerProfile(value as VoiceInputRefinerCatalogProviderKind));
}

export function resolveVoiceInputRefinerProviderKindAlias(value: string): VoiceInputRefinerProviderKind | null {
  return resolveUtilityModelProviderKindAlias(value)
    ?? (isVoiceInputRefinerProviderKind(value) ? value as VoiceInputRefinerProviderKind : null);
}

export function estimateVoiceInputRefinerCostUsd(
  profile: VoiceInputRefinerProfile,
  usage: { promptTokens?: number; cachedTokens?: number; completionTokens?: number },
): number {
  return estimateUtilityModelCostUsd(profile, usage);
}
