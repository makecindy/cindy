export function botProfileContentChanged(input: {
  previousCapabilities: Record<string, unknown>;
  nextCapabilities: Record<string, unknown>;
  previousIdentitySource: string;
  nextIdentitySource: string;
}): boolean {
  return (
    JSON.stringify(input.previousCapabilities) !== JSON.stringify(input.nextCapabilities) ||
    input.previousIdentitySource !== input.nextIdentitySource
  );
}

export function mergeBotProfileCapabilities(input: {
  previous: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  skills?: unknown;
  hasSkills: boolean;
}): Record<string, unknown> {
  const next = input.capabilities
    ? { ...input.previous, ...input.capabilities }
    : { ...input.previous };
  if (input.hasSkills) {
    next.skills = Array.isArray(input.skills)
      ? input.skills
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 100)
      : [];
  }
  return next;
}

/** Main-owned persistence boundary for the ordered Bot runtime routes. */
export function normalizeBotProfileModelChain(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...value };
  if (Object.prototype.hasOwnProperty.call(next, 'modelChain')) {
    const chain = normalizeBotModelChain(next.modelChain);
    if (chain.length === 0) throw new Error('modelChain must contain at least one valid route');
    const primary = chain[0]!;
    next.modelChain = chain;
    next.harness = primary.harness;
    next.model = primary.model;
    next.providerId = primary.providerId;
    next.effort = primary.effort;
    next.fastMode = primary.fastMode;
  }
  if (Array.isArray(next.modelChainOverride)) {
    const override = normalizeBotModelChain(next.modelChainOverride);
    if (override.length === 0) {
      throw new Error('modelChainOverride must contain at least one valid route');
    }
    next.modelChainOverride = override;
  } else if (next.modelChainOverride !== null && next.modelChainOverride !== undefined) {
    throw new Error('modelChainOverride must be an ordered route list or null');
  }
  return next;
}
import { normalizeBotModelChain } from '../../../shared/botModelChain.js';
