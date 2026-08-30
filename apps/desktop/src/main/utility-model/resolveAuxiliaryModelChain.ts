/**
 * Resolve the runtime auxiliary-model chain.
 *
 * Priority: user custom 1–3 (exhaust, no fallback) → env escape hatch → frozen
 * automatic chain. Never sorts by live catalog price.
 */

import {
  AUTO_AUXILIARY_MODEL_CHAIN,
  parseAuxiliaryModelRef,
  type ParsedAuxiliaryModelRef,
} from '../../shared/auxiliaryModelChain.js';
import { encodeCatalogModelPin } from '../../shared/catalogModelPin.js';
import {
  getUtilityModelProfile,
  resolveUtilityModelProviderKindAlias,
  utilityTransportLabel,
} from '../../shared/utilityModelProfiles.js';
import { isAuxiliaryModelCustomized, readAuxiliaryModelSettings } from './auxiliary-model-settings-store.js';

export type AuxiliaryModelChainSource = 'custom' | 'auto' | 'env';

export type EffectiveAuxiliaryModelChain = {
  source: AuxiliaryModelChainSource;
  refs: string[];
};

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function resolveEnvHeadRef(providerRaw: string | undefined, modelRaw: string | undefined): string | null {
  // An explicit legacy model override follows the same profile transport, but
  // must be represented as an exact catalog pin so it cannot silently revert to
  // the profile's default model after the auxiliary migration.
  const provider = resolveUtilityModelProviderKindAlias(providerRaw ?? '')
    ?? resolveUtilityModelProviderKindAlias('');
  if (!provider) return null;
  const profile = getUtilityModelProfile(provider);
  const model = modelRaw?.trim();
  if (!model || model === profile.model) return provider;
  const modelAlias = resolveUtilityModelProviderKindAlias(model);
  if (
    modelAlias
    && getUtilityModelProfile(modelAlias).transport === profile.transport
  ) {
    return modelAlias;
  }
  return encodeCatalogModelPin({
    providerId: profile.transport === 'codex-responses' ? 'openai' : 'xd',
    agentKind: 'codex',
    model,
  });
}

function readEnvUtilityChain(): string[] | null {
  // Keep both generations of the escape hatch alive. Utility names take
  // precedence when both are set, matching the legacy utility selection.
  const chainRaw = firstNonBlank(
    process.env.XDT_UTILITY_MODEL_PROVIDER_CHAIN,
    process.env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN,
  );
  const headRaw = firstNonBlank(
    process.env.XDT_UTILITY_MODEL_PROVIDER,
    process.env.XDT_VOICE_INPUT_REFINER_PROVIDER,
  );
  const modelRaw = firstNonBlank(
    process.env.XDT_UTILITY_MODEL,
    process.env.XDT_VOICE_INPUT_REFINER_MODEL,
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
      const headProvider = resolveUtilityModelProviderKindAlias(headRaw ?? '')
        ?? resolveUtilityModelProviderKindAlias('');
      const rest = entries.filter((entry) => entry !== headProvider && entry !== headRef);
      return [headRef, ...rest];
    }
  }
  return entries.length > 0 ? entries : null;
}

export function getEffectiveAuxiliaryModelChain(): EffectiveAuxiliaryModelChain {
  const custom = readAuxiliaryModelSettings().models;
  if (custom.length > 0) {
    return { source: 'custom', refs: [...custom] };
  }
  const envChain = readEnvUtilityChain();
  if (envChain) {
    return { source: 'env', refs: envChain };
  }
  return { source: 'auto', refs: [...AUTO_AUXILIARY_MODEL_CHAIN] };
}

export function getEffectiveAuxiliaryModelRefs(): string[] {
  return getEffectiveAuxiliaryModelChain().refs;
}

export { isAuxiliaryModelCustomized };

export function formatAuxiliaryModelRefLabel(ref: string): string {
  const parsed = parseAuxiliaryModelRef(ref);
  if (!parsed) return ref;
  if (parsed.kind === 'profile') {
    const profile = getUtilityModelProfile(parsed.id);
    return `${profile.model} · ${utilityTransportLabel(profile.transport)}`;
  }
  const agent = parsed.route.agentKind === 'claude-code' ? 'Claude' : 'Codex';
  const transport = parsed.route.providerId === 'anthropic' || parsed.route.providerId === 'openai'
    ? 'Codex'
    : parsed.route.providerId === 'xd'
      ? 'Gateway'
      : parsed.route.providerId;
  if (parsed.route.providerId === 'anthropic') {
    return `${parsed.route.model} · Claude`;
  }
  if (parsed.route.providerId === 'openai') {
    return `${parsed.route.model} · ${agent}`;
  }
  return `${parsed.route.model} · ${transport}`;
}

export function parsedAuxiliaryModelRefs(refs: readonly string[]): ParsedAuxiliaryModelRef[] {
  const parsed: ParsedAuxiliaryModelRef[] = [];
  for (const ref of refs) {
    const item = parseAuxiliaryModelRef(ref);
    if (item) parsed.push(item);
  }
  return parsed;
}
