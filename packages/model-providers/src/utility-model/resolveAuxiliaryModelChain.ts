/**
 * Resolve the runtime auxiliary-model chain.
 *
 * Priority: user custom 1–3 (exhaust, no fallback) → env escape hatch → frozen
 * automatic chain. Never sorts by live catalog price.
 */

import {
  AUTO_AUXILIARY_MODEL_CHAIN,
} from '../auxiliaryModelChain.js';
import { encodeCatalogModelPin } from '../catalogModelPin.js';
import {
  DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
  getUtilityModelProfile,
  resolveUtilityModelProviderKindAlias,
} from '../utilityModelProfiles.js';

export type AuxiliaryModelChainSource = 'custom' | 'auto' | 'env';

export type EffectiveAuxiliaryModelChain = {
  source: AuxiliaryModelChainSource;
  refs: string[];
};

function firstNonBlank(
  ...values: Array<string | undefined>
): string | undefined {
  return values
    .find((value) => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

function resolveEnvHeadRef(
  providerRaw: string | undefined,
  modelRaw: string | undefined,
): string | null {
  // Preserve the exact model identity when migrating a legacy provider/model
  // override. The resulting catalog pin remains subject to active-catalog
  // membership at dispatch; unknown models fail closed instead of becoming an
  // unlisted profile override. Do not introduce a second persisted ref format.
  const provider =
    resolveUtilityModelProviderKindAlias(providerRaw ?? '') ??
    resolveUtilityModelProviderKindAlias('');
  if (!provider) return null;
  const profile = getUtilityModelProfile(provider);
  const model = modelRaw?.trim();
  if (!model || model === profile.model) return provider;
  const modelAlias = resolveUtilityModelProviderKindAlias(model);
  if (
    modelAlias &&
    getUtilityModelProfile(modelAlias).transport === profile.transport
  ) {
    return modelAlias;
  }
  return encodeCatalogModelPin({
    providerId: profile.transport === 'codex-responses' ? 'openai' : 'xd',
    agentKind: 'codex',
    model,
  });
}

function readEnvUtilityChain(env: NodeJS.ProcessEnv): string[] | null {
  // Keep both generations of the escape hatch alive. Utility names take
  // precedence when both are set, matching the legacy utility selection.
  const chainRaw = firstNonBlank(
    env.XDT_UTILITY_MODEL_PROVIDER_CHAIN,
    env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN,
  );
  const headRaw = firstNonBlank(
    env.XDT_UTILITY_MODEL_PROVIDER,
    env.XDT_VOICE_INPUT_REFINER_PROVIDER,
  );
  const modelRaw = firstNonBlank(
    env.XDT_UTILITY_MODEL,
    env.XDT_VOICE_INPUT_REFINER_MODEL,
  );
  const entries: string[] = [];
  if (typeof chainRaw === 'string' && chainRaw.trim()) {
    for (const part of chainRaw.split(',')) {
      const resolved = resolveUtilityModelProviderKindAlias(part.trim());
      if (resolved && !entries.includes(resolved)) entries.push(resolved);
    }
  }
  const hasHeadOrModelOverride = Boolean(headRaw || modelRaw);
  if (hasHeadOrModelOverride) {
    const headRef = resolveEnvHeadRef(headRaw, modelRaw);
    if (headRef) {
      const headProvider =
        resolveUtilityModelProviderKindAlias(headRaw ?? '') ??
        resolveUtilityModelProviderKindAlias('');
      const rest = entries.filter(
        (entry) => entry !== headProvider && entry !== headRef,
      );
      return [headRef, ...rest];
    }
  }
  if (entries.length > 0) {
    // `UtilityModelSelection` has always treated a provider-chain-only
    // configuration as a fallback tail behind the implicit default provider.
    // Keep that legacy ordering when migrating the escape hatch into the
    // shared auxiliary chain; otherwise the first configured fallback would
    // silently become the primary route.
    return [
      DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
      ...entries.filter(
        (entry) => entry !== DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
      ),
    ];
  }
  return null;
}

export function resolveEffectiveAuxiliaryModelChain(
  custom: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EffectiveAuxiliaryModelChain {
  if (custom.length > 0) {
    return { source: 'custom', refs: [...custom] };
  }
  const envChain = readEnvUtilityChain(env);
  if (envChain) {
    return { source: 'env', refs: envChain };
  }
  return { source: 'auto', refs: [...AUTO_AUXILIARY_MODEL_CHAIN] };
}
