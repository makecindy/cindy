import { createHash } from 'node:crypto';
import { pluginToolVisible } from '@cindy/plugin-protocol';
import { STARTUP_GHOST_TOOL_PREFIX, type GhostToolDecl, type InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';

export const STARTUP_GHOST_TOOLS_OWNER_KEY = '_cindyStartupGhostToolsOwner';

interface StartupGhostToolTarget {
  instance: string;
  tool: string;
}

// Task catalogs strongly own the binding. The lookup for Agent approvals
// should neither scan installations nor keep ended task catalogs alive.
const startupTargets = new Map<string, WeakRef<StartupGhostToolTarget>>();
const releasedTargets = new FinalizationRegistry<string>(name => {
  if (!startupTargets.get(name)?.deref()) startupTargets.delete(name);
});

export function findStartupGhostToolTarget(name: string): StartupGhostToolTarget | undefined {
  return startupTargets.get(name)?.deref();
}

export function registerStartupGhostToolTarget(
  name: string,
  instance: string,
  tool: string,
): StartupGhostToolTarget {
  const existing = findStartupGhostToolTarget(name);
  if (existing) return existing;
  const target = { instance, tool };
  startupTargets.set(name, new WeakRef(target));
  releasedTargets.register(target, name);
  return target;
}

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
