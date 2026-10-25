import { normalizeBotToolCapabilities, reconcileBotCapabilityList } from '../../../shared/botCapabilitySelection.js';
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

export { botProfileModelSelectionChanged, normalizeBotProfileModelChain } from '../../../shared/botModelChain.js';

export function mergeBotProfileCapabilities(input: {
  previous: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  skills?: unknown;
  hasSkills: boolean;
  capabilityBaseline?: unknown;
}): Record<string, unknown> {
  const previous = normalizeBotToolCapabilities(input.previous);
  const next = input.capabilities
    ? { ...previous, ...input.capabilities }
    : { ...previous };
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
  return normalizeBotToolCapabilities(next);
}
