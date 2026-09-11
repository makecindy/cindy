import { normalizeBotModelChain } from '../../../shared/botModelChain.js';
import { reconcileBotCapabilityList } from '../../../shared/botCapabilitySelection.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

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

/** A saved model selection supersedes an earlier runtime-only fallback. */
export function botProfileModelSelectionChanged(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return ['modelChainOverride', 'modelOverride', 'modelChain', 'harness', 'model', 'providerId', 'effort', 'fastMode']
    .some((key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null));
}

export function mergeBotProfileCapabilities(input: {
  previous: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  skills?: unknown;
  hasSkills: boolean;
  capabilityBaseline?: unknown;
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
  if (input.capabilityBaseline !== undefined) {
    const baseline = input.capabilityBaseline;
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
      throwIpcError('INVALID_PARAMS', 'capabilityBaseline must be an object');
    }
    for (const key of ['skills', 'mcpServers', 'toolsets'] as const) {
      const before = (baseline as Record<string, unknown>)[key];
      if (before === undefined) continue;
      const local = next[key];
      const hasSelection = key === 'skills' ? input.hasSkills
        : Object.prototype.hasOwnProperty.call(input.capabilities ?? {}, key);
      if (!hasSelection || !Array.isArray(before) || !before.every((id) => typeof id === 'string')
        || !Array.isArray(local) || !local.every((id) => typeof id === 'string')) {
        throwIpcError('INVALID_PARAMS', 'capabilityBaseline requires matching string lists');
      }
      const current = input.previous[key];
      next[key] = reconcileBotCapabilityList(before, local,
        Array.isArray(current) ? current.filter((id): id is string => typeof id === 'string') : []);
    }
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
    if (chain.length === 0 && next.modelChainOverride !== null && next.modelOverride !== null) {
      throw new Error('modelChain must contain at least one valid route');
    }
    const primary = chain[0];
    next.modelChain = chain;
    if (primary) {
      next.harness = primary.harness;
      next.model = primary.model;
      next.providerId = primary.providerId;
      next.effort = primary.effort;
      next.fastMode = primary.fastMode;
    }
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
