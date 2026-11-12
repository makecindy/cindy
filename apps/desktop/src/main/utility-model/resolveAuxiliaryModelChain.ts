/**
 * Resolve the runtime auxiliary-model chain.
 *
 * Priority: user custom 1–3 (exhaust, no fallback) → env escape hatch → frozen
 * automatic chain. Never sorts by live catalog price.
 */

// The resolver itself lives in resolveAuxiliaryModelChainCore.ts (shared with the Node Host).
// This module builds the single Desktop instance over the Desktop settings store.
import { createAuxiliaryModelChainResolver } from './resolveAuxiliaryModelChainCore.js';
import { isAuxiliaryModelCustomized, readAuxiliaryModelSettings } from './auxiliary-model-settings-store.js';

export type { AuxiliaryModelChainSource, EffectiveAuxiliaryModelChain } from './resolveAuxiliaryModelChainCore.js';

const desktopResolver = createAuxiliaryModelChainResolver({
  readAuxiliaryModelSettings: (...args) => readAuxiliaryModelSettings(...args),
});
type Instance = typeof desktopResolver;

export function getEffectiveAuxiliaryModelChain(...args: Parameters<Instance['getEffectiveAuxiliaryModelChain']>): ReturnType<Instance['getEffectiveAuxiliaryModelChain']> {
  return desktopResolver.getEffectiveAuxiliaryModelChain(...args);
}

export function getEffectiveAuxiliaryModelChainSnapshot(...args: Parameters<Instance['getEffectiveAuxiliaryModelChainSnapshot']>): ReturnType<Instance['getEffectiveAuxiliaryModelChainSnapshot']> {
  return desktopResolver.getEffectiveAuxiliaryModelChainSnapshot(...args);
}

export function getEffectiveAuxiliaryModelRefs(...args: Parameters<Instance['getEffectiveAuxiliaryModelRefs']>): ReturnType<Instance['getEffectiveAuxiliaryModelRefs']> {
  return desktopResolver.getEffectiveAuxiliaryModelRefs(...args);
}

export { isAuxiliaryModelCustomized };

export function formatAuxiliaryModelRefLabel(...args: Parameters<Instance['formatAuxiliaryModelRefLabel']>): ReturnType<Instance['formatAuxiliaryModelRefLabel']> {
  return desktopResolver.formatAuxiliaryModelRefLabel(...args);
}

export function parsedAuxiliaryModelRefs(...args: Parameters<Instance['parsedAuxiliaryModelRefs']>): ReturnType<Instance['parsedAuxiliaryModelRefs']> {
  return desktopResolver.parsedAuxiliaryModelRefs(...args);
}
