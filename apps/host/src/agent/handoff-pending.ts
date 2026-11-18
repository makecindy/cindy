import { createAgentHandoffPending } from '../../../desktop/src/main/maker-ipc/agentHandoffPending.ts';
import { markLatestAgentHandoffConsumedWithPorts } from '../../../desktop/src/main/localDb/agentHandoffPendingQueries.ts';
import type { CurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.ts';
import { messageToCamel } from '../../../desktop/src/main/localDb/mapper.ts';
import { writeMessageContentRow } from '../../../desktop/src/main/localDb/messageMutations.ts';
import { hostChatAttachments } from '../media-store.js';

/**
 * The Host's pending handoff registry: the desktop's (agentHandoffPending.ts, whose desktop instance
 * is agentHandoffPendingSingleton.ts) with the Host's consumed write. The summary of a rebuilt native
 * context, or of an engine switch made on the desktop, is sent once with the task's next accepted
 * send; its consumed flag is written back, so after a restart the database still knows it was sent.
 *
 * Consuming an engine switch boundary rewrites that row and shows it again, as the desktop's
 * updateAgentSwitchBoundaryContent does, to the owner of the moment of the call (the owner is the
 * database snapshot, as the Host's message store).
 */
export function createHostAgentHandoffPending(deps: {
  getOwner(): CurrentDbClientSnapshot | null;
  publish(event: Record<string, unknown>): void;
  log: { warn(message: string, fields?: Record<string, unknown>): void };
}) {
  const scopeKey = (owner: CurrentDbClientSnapshot | null) => (owner ? `${owner.userId}:${owner.clientEpoch}` : undefined);
  return createAgentHandoffPending({
    markLatestAgentHandoffConsumed: sessionId => markLatestAgentHandoffConsumedWithPorts({
      captureOwnerBroadcastScope: () => ({ ownerScopeKey: scopeKey(deps.getOwner()) }),
      // As the desktop: the rewrite goes to the current database; only the owner of the moment
      // of the call is shown it.
      async updateAgentSwitchBoundaryContent(id, clientId, content, scope) {
        const owner = deps.getOwner();
        if (!owner) throw new Error('DbClient not ready');
        const row = await writeMessageContentRow(owner.client, id, clientId, content);
        if (!row) return;
        await hostChatAttachments.commitMessageMediaRefs({ sessionId: id, role: row.role, content: row.content }, owner.client.drizzle);
        if (scope?.ownerScopeKey !== scopeKey(deps.getOwner())) return;
        const message = messageToCamel(row);
        deps.publish({ type: 'message_created', sessionId: id, messageId: message.id, message });
      },
    }, sessionId),
    log: deps.log,
  });
}
