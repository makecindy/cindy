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

/** Reuse Host permission UI; no plugin-supplied confirmation or manifest flag is authority. */
export async function ensurePluginTaskApproval(
  id: string,
  deps: {
    getGhost(id: string): InstalledGhost | null;
    isCurrent(): boolean;
    confirm(facts: GhostInstallConsentFacts): Promise<boolean>;
    approve(id: string, revision: string, isCurrent: () => boolean): Promise<boolean>;
  },
): Promise<boolean> {
  const ghost = deps.getGhost(id);
  if (!deps.isCurrent()) return false;
  if (hasPluginTaskApproval(ghost)) return true;
  if (
    !ghost?.enabled ||
    ghost.manifest.agent?.tasks !== true ||
    ghost.approval?.state !== 'approved'
  )
    return false;
  const revision = ghost.approval.revision;
  const permissions = ghostPermissionItems(ghost.manifest).filter((item) => item.kind !== 'tool');
  const added = permissions.filter((item) => item.key === 'agent:tasks');
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
