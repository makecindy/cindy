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
