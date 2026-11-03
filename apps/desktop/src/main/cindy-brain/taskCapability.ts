import { ghostPermissionItems, type InstalledGhost } from '../../shared/ghost.js';
import type { GhostInstallConsentFacts } from '../../shared/ghostInstallConsent.js';

/** One automatic attempt per owner/install identity. Only Host UI may retry. */
export class PluginTaskApprovalGate {
  private readonly attempts = new Map<string, { identity: string; pending: boolean }>();

  async request(id: string, identity: string, explicit: boolean, attempt: () => Promise<boolean>): Promise<boolean> {
    const previous = this.attempts.get(id);
    if (previous?.pending || (previous?.identity === identity && !explicit)) return false;
    const state = { identity, pending: true };
    this.attempts.set(id, state);
    try {
      const approved = await attempt();
      if (approved && this.attempts.get(id) === state) this.attempts.delete(id);
      return approved;
    } finally {
      state.pending = false;
    }
  }
}

export function hasPluginTaskApproval(ghost: InstalledGhost | null | undefined): boolean {
  return (
    ghost?.enabled === true &&
    ghost.manifest.agent?.tasks === true &&
    ghost.approval?.state === 'approved' &&
    ghost.taskCapabilityApproved === true
  );
}

export function hasPluginTargetApproval(ghost: InstalledGhost | null | undefined): boolean {
  return hasPluginTaskApproval(ghost) && ghost?.manifest.agent?.targets === true && ghost.targetCapabilityApproved === true;
}

export function hasPluginDelegationApproval(ghost: InstalledGhost | null | undefined): boolean {
  return hasPluginTargetApproval(ghost) && ghost?.manifest.agent?.delegation === true && ghost.delegationCapabilityApproved === true;
}

export function pluginCapabilityApproval(capability: 'tasks' | 'targets' | 'delegation' | 'observe'): (ghost: InstalledGhost | null | undefined) => boolean {
  return capability === 'observe' ? hasPluginObserveApproval : capability === 'delegation' ? hasPluginDelegationApproval : capability === 'targets' ? hasPluginTargetApproval : hasPluginTaskApproval;
}

/** Read-only observation is independent of task creation, so it does not require tasks approval. */
export function hasPluginObserveApproval(ghost: InstalledGhost | null | undefined): boolean {
  return (
    ghost?.enabled === true &&
    ghost.manifest.agent?.observe === true &&
    ghost.approval?.state === 'approved' &&
    ghost.observeCapabilityApproved === true
  );
}

/** Reuse Host permission UI; no plugin-supplied confirmation or manifest flag is authority. */
export async function ensurePluginTaskApproval(
  id: string,
  deps: {
    getGhost(id: string): InstalledGhost | null;
    isCurrent(): boolean;
    confirm(facts: GhostInstallConsentFacts): Promise<boolean>;
    approve(id: string, revision: string, isCurrent: () => boolean): Promise<boolean>;
  },
  capability: 'tasks' | 'targets' | 'delegation' | 'observe' = 'tasks',
): Promise<boolean> {
  const ghost = deps.getGhost(id);
  if (!deps.isCurrent()) return false;
  if (pluginCapabilityApproval(capability)(ghost)) return true;
  if (
    !ghost?.enabled ||
    (capability === 'observe' ? ghost.manifest.agent?.observe !== true : ghost.manifest.agent?.tasks !== true) ||
    ghost.approval?.state !== 'approved' ||
    (capability === 'targets' && (!hasPluginTaskApproval(ghost) || ghost.manifest.agent?.targets !== true)) ||
    (capability === 'delegation' && (!hasPluginTargetApproval(ghost) || ghost.manifest.agent?.delegation !== true))
  )
    return false;
  const revision = ghost.approval.revision;
  const permissions = ghostPermissionItems(ghost.manifest).filter((item) => item.kind !== 'tool');
  const added = permissions.filter((item) => item.key === `agent:${capability}`);
  if (added.length !== 1) return false;
  const confirmed = await deps.confirm({
    kind: 'update',
    ghostId: id,
    name: ghost.manifest.name,
    version: ghost.manifest.version,
    previousVersion: ghost.manifest.version,
    added,
    removed: [],
    unchangedCount: permissions.length - added.length,
    builtinOauthClientChanged: false,
  });
  if (!confirmed || !deps.isCurrent()) return false;
  return deps.approve(id, revision, deps.isCurrent);
}
