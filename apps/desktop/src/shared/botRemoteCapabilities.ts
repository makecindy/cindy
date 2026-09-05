import type { AgentKind } from '@cindy/maker-core';

/**
 * SSH Claude/Codex only receive the narrowly scoped host bridge declared in
 * codexHttpBridge.ts. Pi has a per-session SSH tunnel for the complete MCP
 * bridge, so its enabled local Toolsets remain available remotely.
 *
 * Keep this list in user-facing Plugin IDs: Bot profiles freeze Toolsets by
 * Plugin ID, while the transport layer maps those IDs to MCP provider names.
 */
const REMOTE_CC_CODEX_TOOLSET_IDS = new Set(['collab', 'memory']);

export function isBotToolsetAvailableOnTarget(input: {
  agentKind: AgentKind;
  remoteHostId?: string | null;
  toolsetId: string;
}): boolean {
  if (!input.remoteHostId || input.agentKind === 'pi') return true;
  return REMOTE_CC_CODEX_TOOLSET_IDS.has(input.toolsetId);
}
