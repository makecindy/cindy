import { createHash } from 'node:crypto';
import { GHOST_PARTITION_PREFIX, ghostInstallApprovalToken, parseGhostPartition, type GhostInstallApproval } from '../../shared/ghost.js';
import { installedGhostLogicalIdentity, isValidPluginStoragePart, pluginStoragePart } from '../../shared/pluginIdentity.js';
import { dataOwnerStorageKey, type ActiveAppSession } from '../appSessionState.js';

const GHOST_OWNER_PARTITION_PREFIX = `${GHOST_PARTITION_PREFIX}owner:`;

export interface ResolvedGhostWebviewPartition {
  ghostId: string;
  partition: string;
}

/** Main 持有的真实 owner → 不透明、稳定的插件 Electron session 分区。 */
export function ownerScopedGhostPartition(
  ghostId: string,
  owner: Pick<ActiveAppSession, 'mode' | 'dataOwnerId'>,
  knownRoot = false,
): string | null {
  if (!isValidPluginStoragePart(ghostId) || owner.mode === 'signed-out' || !owner.dataOwnerId) return null;
  return `${GHOST_OWNER_PARTITION_PREFIX}${owner.mode}:${dataOwnerStorageKey(owner.dataOwnerId)}:${ghostId}${knownRoot ? ':root' : ''}`;
}

export function ownerScopedGhostPartitionForInstalledGhost(
  ghost: { manifest: { id: string }; namespace?: string | null; approval?: GhostInstallApproval; dir?: string },
  owner: Pick<ActiveAppSession, 'mode' | 'dataOwnerId'> & Partial<Pick<ActiveAppSession, 'generation'>>,
): string | null {
  const partition = ownerScopedGhostPartition(
    pluginStoragePart(installedGhostLogicalIdentity(ghost)),
    owner,
    ghost.namespace === null,
  );
  if (!partition || ghost.approval?.state !== 'approved') return partition;
  const receipt = createHash('sha256')
    .update(JSON.stringify([ghostInstallApprovalToken(ghost.approval), ghost.dir ?? null, owner.generation ?? null]))
    .digest('hex');
  return partition + ':receipt:' + receipt;
}

/**
 * Main 侧 WebView attach 的 owner 决策原语。
 * Renderer 的 ghost-only partition 只是 attach claim；实际 partition 由 Main
 * 根据当前已提交 owner 生成，Renderer 无法挑选另一个 owner 的 session。
 */
export function resolveGhostWebviewPartitionClaim(
  partitionClaim: unknown,
  activeOwner: Pick<ActiveAppSession, 'mode' | 'dataOwnerId'>,
): ResolvedGhostWebviewPartition | null {
  const ghostId = parseGhostPartition(partitionClaim);
  if (!ghostId) return null;
  const partition = ownerScopedGhostPartition(ghostId, activeOwner);
  return partition ? { ghostId, partition } : null;
}
