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

function readEnvUtilityChain(): string[] | null {
  const chainRaw = process.env.XDT_UTILITY_MODEL_PROVIDER_CHAIN;
  const headRaw = process.env.XDT_UTILITY_MODEL_PROVIDER;
  const entries: string[] = [];
  if (typeof chainRaw === 'string' && chainRaw.trim()) {
    for (const part of chainRaw.split(',')) {
      const resolved = resolveUtilityModelProviderKindAlias(part.trim());
      if (resolved && !entries.includes(resolved)) entries.push(resolved);
    }
  }
  if (typeof headRaw === 'string' && headRaw.trim()) {
    const resolved = resolveUtilityModelProviderKindAlias(headRaw.trim());
    if (resolved) {
      const rest = entries.filter((entry) => entry !== resolved);
      return [resolved, ...rest];
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
