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
 * Old profiles stored opt-in mount lists, including generated empty allowlists.
 * The shared-capability release makes all existing companions follow Cindy.
 * Keep the old references (including imported connections), but only a choice
 * saved under this contract may restrict the inherited tools again.
 */
export function normalizeBotToolCapabilities(config: Record<string, unknown>): Record<string, unknown> & {
  toolCapabilityVersion: 1; toolsetMode: 'inherit' | 'allowlist'; mcpMode: 'inherit' | 'allowlist';
} {
  if (config.toolCapabilityVersion === 1) return {
    ...config, toolCapabilityVersion: 1,
    toolsetMode: config.toolsetMode === 'allowlist' ? 'allowlist' : 'inherit',
    mcpMode: config.mcpMode === 'allowlist' ? 'allowlist' : 'inherit',
  };
  return { ...config, toolCapabilityVersion: 1, toolsetMode: 'inherit', mcpMode: 'inherit' };
}
