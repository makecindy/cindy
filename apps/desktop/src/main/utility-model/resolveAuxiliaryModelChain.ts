import { resolveEffectiveAuxiliaryModelChain } from '@cindy/model-providers/utility-model/resolveAuxiliaryModelChain';
/**
 * Resolve the runtime auxiliary-model chain.
 *
 * Priority: user custom 1–3 (exhaust, no fallback) → env escape hatch → frozen
 * automatic chain. Never sorts by live catalog price.
 */

import {
  parseAuxiliaryModelRef,
  type ParsedAuxiliaryModelRef,
} from '../../shared/auxiliaryModelChain.js';
import {
  getUtilityModelProfile,
  utilityTransportLabel,
} from '../../shared/utilityModelProfiles.js';
import {
  isAuxiliaryModelCustomized,
  readAuxiliaryModelSettings,
} from './auxiliary-model-settings-store.js';

export type AuxiliaryModelChainSource = 'custom' | 'auto' | 'env';

export type EffectiveAuxiliaryModelChain = {
  source: AuxiliaryModelChainSource;
  refs: string[];
};

export function getEffectiveAuxiliaryModelChain(): EffectiveAuxiliaryModelChain {
  return resolveEffectiveAuxiliaryModelChain(readAuxiliaryModelSettings().models);
}

/**
 * Stable request-time identity for the effective auxiliary chain.
 * Async callers capture this before resolving credentials or readiness, then
 * fail closed if the user changes the routing decision while work is in flight.
 */
export function getEffectiveAuxiliaryModelChainSnapshot(): string {
  const chain = getEffectiveAuxiliaryModelChain();
  return JSON.stringify({ source: chain.source, refs: chain.refs });
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
  if (parsed.route.providerId === 'xd') {
    return `${parsed.route.model} · Cindy AI`;
  }
  const agent = parsed.route.agentKind === 'claude-code' ? 'Claude' : 'Codex';
  const provider =
    parsed.route.providerId === 'anthropic' || parsed.route.providerId === 'openai'
      ? agent
      : parsed.route.providerId;
  return `${parsed.route.model} · ${provider}`;
}

export function parsedAuxiliaryModelRefs(refs: readonly string[]): ParsedAuxiliaryModelRef[] {
  const parsed: ParsedAuxiliaryModelRef[] = [];
  for (const ref of refs) {
    const item = parseAuxiliaryModelRef(ref);
    if (item) parsed.push(item);
  }
  return parsed;
}
