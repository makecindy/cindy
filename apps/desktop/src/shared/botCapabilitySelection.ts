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
 * Old profiles stored generated empty allowlists as well as user selections.
 * Upgrade only empty legacy selections; preserve nonempty restrictions and
 * explicit inheritance. Versioned profiles also preserve deliberate empty lists.
 */
export function normalizeBotToolCapabilities(config: Record<string, unknown>): Record<string, unknown> & {
  toolCapabilityVersion: 1; toolsetMode: 'inherit' | 'allowlist'; mcpMode: 'inherit' | 'allowlist';
} {
  if (config.toolCapabilityVersion === 1) return {
    ...config, toolCapabilityVersion: 1,
    toolsetMode: config.toolsetMode === 'allowlist' ? 'allowlist' : 'inherit',
    mcpMode: config.mcpMode === 'allowlist' ? 'allowlist' : 'inherit',
  };
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : [];
  const toolsets = strings(config.toolsets ?? config.tools);
  // Profiles predating selection modes used these names as display placeholders.
  // An explicit allowlist containing only browser is still a real selection.
  const hasToolSelection = toolsets.length > 0 && (config.toolsetMode === 'allowlist'
    || !toolsets.every(id => ['files', 'browser', 'mcp'].includes(id)));
  return {
    ...config, toolCapabilityVersion: 1,
    toolsetMode: config.toolsetMode !== 'inherit' && hasToolSelection ? 'allowlist' : 'inherit',
    mcpMode: config.mcpMode !== 'inherit' && strings(config.mcpServers).length > 0 ? 'allowlist' : 'inherit',
  };
}
