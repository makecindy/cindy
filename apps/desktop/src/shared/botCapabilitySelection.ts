import { isRetiredBuiltinToolset } from './featureRetirements.js';

/** Editing baseline, sent only for capability lists changed by the settings form. */
export type BotCapabilityBaseline = Partial<Record<'skills' | 'mcpServers' | 'toolsets', string[]>>;

/** Apply the local additions/removals to the latest list, preserving concurrent changes. */
export function reconcileBotCapabilityList(previous: string[], local: string[], remote: string[]): string[] {
  const baseline = new Set(previous);
  const selected = new Set(local);
  return [...new Set([
    ...remote.filter((id) => !baseline.has(id) || selected.has(id)),
    ...local.filter((id) => !baseline.has(id)),
  ])];
}

/**
 * Legacy lists do not distinguish generated defaults from user selections.
 * The shared-capability migration intentionally opens every legacy list while
 * retaining its references. Choices saved under version 1, including empty
 * allowlists, remain explicit restrictions on subsequent loads.
 */
export function normalizeBotToolCapabilities(config: Record<string, unknown>): Record<string, unknown> & {
  toolCapabilityVersion: 1; toolsetMode: 'inherit' | 'allowlist'; mcpMode: 'inherit' | 'allowlist';
} {
  // Keep unavailable third-party references removable; only retired built-ins
  // disappear. Do not mutate historical profiles or change their permissions.
  const current = { ...config };
  for (const key of ['toolsets', 'tools']) {
    const ids = current[key];
    if (Array.isArray(ids)) current[key] = ids.filter((id) => typeof id !== 'string' || !isRetiredBuiltinToolset(id));
  }
  if (config.toolCapabilityVersion === 1) return {
    ...current, toolCapabilityVersion: 1,
    toolsetMode: config.toolsetMode === 'allowlist' ? 'allowlist' : 'inherit',
    mcpMode: config.mcpMode === 'allowlist' ? 'allowlist' : 'inherit',
  };
  return { ...current, toolCapabilityVersion: 1, toolsetMode: 'inherit', mcpMode: 'inherit' };
}
