/**
 * A pending switch onto a plugin engine (`agentSwitchIntent.targetAgentKind = 'acp'`,
 * docs/plans/acp-plugin-bridge.md) only reaches controllers that declared
 * CONTROLLER_CAPABILITY_PLUGIN_ENGINE_SWITCH_INTENT_V1. Phones shipped before it apply the patch
 * as-is and would show the plugin engine as Claude Code (and ask for its capabilities); for them
 * the intent reads as "no pending switch". Every other field of the push is unchanged.
 */
export function withoutPluginEngineSwitchIntent(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const push = payload as { patch?: unknown };
  const patch = push.patch;
  if (!patch || typeof patch !== 'object') return payload;
  const intent = (patch as { agentSwitchIntent?: unknown }).agentSwitchIntent;
  if (!isPluginEngineSwitchIntent(intent)) return payload;
  return { ...push, patch: { ...(patch as Record<string, unknown>), agentSwitchIntent: null } };
}

/** The projected (public) pending intent targets a plugin engine. */
export function isPluginEngineSwitchIntent(intent: unknown): boolean {
  return !!intent && typeof intent === 'object'
    && (intent as { targetAgentKind?: unknown }).targetAgentKind === 'acp';
}
