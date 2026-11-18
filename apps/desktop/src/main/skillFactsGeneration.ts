/**
 * Skill/plugin facts generation. Every skill write (shared mutation lease) and
 * every managed pi package/plugin change bumps it, so generation-keyed caches
 * drop their snapshots and the next palette open rescans instead of serving
 * stale facts.
 */
let generation = 0;
const listeners = new Set<() => void>();

export function bumpSkillFactsGeneration(): void {
  generation += 1;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* A bad subscriber must not block the rest. */ }
  }
}

export function readSkillFactsGeneration(): number {
  return generation;
}

export function onSkillFactsGenerationChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
