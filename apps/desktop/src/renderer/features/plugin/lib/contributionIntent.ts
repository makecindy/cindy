import { ghostInstallApprovalToken, type InstalledGhost } from '../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';

/** Navigation intent only: no package, credential or grant crosses an owner boundary. */
interface ExactTarget {
  instanceId: string;
  directory: string;
  approvalToken: string;
  ghostId: string;
  version: string;
  sourceKey: string;
}
let pending: { nonce: string; target: ExactTarget; at: number } | null = null;
export function rememberContributionIntent(ghost: InstalledGhost): string {
  pending = {
    nonce: crypto.randomUUID(),
    at: Date.now(),
    target: {
      instanceId: installedGhostStoragePart(ghost),
      directory: ghost.dir,
      approvalToken: ghostInstallApprovalToken(ghost.approval),
      ghostId: ghost.manifest.id,
      version: ghost.manifest.version,
      sourceKey: JSON.stringify(ghost.publishingSource),
    },
  };
  return pending.nonce;
}
export function consumeContributionIntent(nonce: string): ExactTarget | null {
  if (!pending || pending.nonce !== nonce) return null;
  const value = pending;
  pending = null;
  return Date.now() - value.at <= 15 * 60_000 ? value.target : null;
}
export function matchesContributionIntent(target: ExactTarget, ghost: InstalledGhost): boolean {
  return (
    installedGhostStoragePart(ghost) === target.instanceId &&
    ghost.dir === target.directory &&
    ghostInstallApprovalToken(ghost.approval) === target.approvalToken &&
    ghost.approval.state === 'approved' &&
    ghost.manifest.id === target.ghostId &&
    ghost.manifest.version === target.version &&
    ghost.namespace === null &&
    ghost.namespaceState === 'confirmed'
    && ghost.publishingSource?.kind === 'local'
    && JSON.stringify(ghost.publishingSource) === target.sourceKey
  );
}
