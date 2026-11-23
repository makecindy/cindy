import { createHash } from 'node:crypto';
import { pluginToolVisible } from '@cindy/plugin-protocol';
import { STARTUP_GHOST_TOOL_PREFIX, type GhostToolDecl, type InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';

export const STARTUP_GHOST_TOOLS_OWNER_KEY = '_cindyStartupGhostToolsOwner';

/** One identity for MCP discovery, the approval classifier and live execution. */
export function startupGhostToolName(ghost: InstalledGhost, tool: GhostToolDecl): string | undefined {
  if (!ghost.enabled || ghost.retirement || ghost.approval.state !== 'approved' ||
      ghost.namespaceState === 'pending' || tool.exposure !== 'startup' ||
      !pluginToolVisible(ghost.manifest, tool.name, 'model')) return undefined;
  const revision = createHash('sha256').update(JSON.stringify([
    installedGhostStoragePart(ghost), ghost.approval.revision, tool.name,
  ])).digest('hex').slice(0, 20);
  return `${STARTUP_GHOST_TOOL_PREFIX}${ghost.manifest.id.slice(0, 8)}_${tool.name.slice(0, 10)}_${revision}`;
}
