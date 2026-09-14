import { GHOST_PARTITION_PREFIX, isValidGhostId, parseGhostPartition } from '../../shared/ghost.js';
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
): string | null {
  if (!isValidGhostId(ghostId) || owner.mode === 'signed-out' || !owner.dataOwnerId) return null;
  return `${GHOST_OWNER_PARTITION_PREFIX}${owner.mode}:${dataOwnerStorageKey(owner.dataOwnerId)}:${ghostId}`;
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
