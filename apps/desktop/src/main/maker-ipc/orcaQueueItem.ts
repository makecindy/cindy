import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

/**
 * Resolve the durable Orca team identity for both current and legacy queue
 * snapshots. Older snapshots predate `origin.teamId` and only retain the
 * workflow id inside the captured vendor options.
 */
export function resolveOrcaQueueItemTeamId(item: AgentInputQueuedMessage): string | null {
  if (item.origin?.kind !== 'orca') return null;
  if (typeof item.origin.teamId === 'string' && item.origin.teamId.length > 0) {
    return item.origin.teamId;
  }
  const legacyTeamId = item.createOpts.vendorOptions?.orcaWorkflowId;
  return typeof legacyTeamId === 'string' && legacyTeamId.length > 0 ? legacyTeamId : null;
}
