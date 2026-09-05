import type { BotDelegationListResult } from '../../shared/botDelegation.js';

/** Only the task-card view crosses device-link, never a database/runtime snapshot. */
export function projectRemoteBotDelegations(result: BotDelegationListResult): BotDelegationListResult {
  if (!result.ok) return result;
  return { ok: true, delegations: result.delegations.map((row) => ({
    id: row.id, requestingBotId: row.requestingBotId, targetBotId: row.targetBotId,
    targetBotName: row.targetBotName, parentSessionId: row.parentSessionId,
    childSessionId: row.childSessionId, title: row.title, objective: row.objective,
    status: row.status, resultSummary: row.resultSummary, lastError: row.lastError,
    createdAt: row.createdAt, acceptedAt: row.acceptedAt, completedAt: row.completedAt,
    updatedAt: row.updatedAt, depth: row.depth, targetProfileVersion: row.targetProfileVersion,
    contextRefs: [], lineage: [], permissionSnapshot: {},
    pendingInteraction: row.pendingInteraction ? {
      requestId: row.pendingInteraction.requestId, kind: row.pendingInteraction.kind,
      summary: row.pendingInteraction.summary, raisedAt: row.pendingInteraction.raisedAt,
    } : null,
    artifacts: row.artifacts.map(({ path, absolutePath, status }) => ({ path, absolutePath, status })),
  })) };
}
