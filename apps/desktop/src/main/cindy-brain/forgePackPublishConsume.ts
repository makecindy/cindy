/**
 * Consume a forge-pack ticket for Agent-initiated publishing.
 *
 * The order is deliberate: an account boundary must not burn a valid ticket;
 * after the one-shot consume, the captured owner must still match the current
 * session. Package id and bytes stay bound by the publisher pipeline itself.
 */
import type { ActiveAppSession } from '../appSessionState.js';
import type { ForgePackIntegrityTicket, ForgePackStagingController } from './forgePackStaging.js';

export type ForgePackPublishConsume =
  | { kind: 'accepted'; ticket: ForgePackIntegrityTicket }
  | {
      kind: 'rejected';
      reason: 'session-boundary-pending' | 'ticket-invalid' | 'owner-mismatch';
    };

export function sameActiveAppSessionOwner(
  a: ActiveAppSession,
  b: ActiveAppSession,
): boolean {
  return a.mode === b.mode && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
}

export function consumeForgePackForPublish(
  controller: ForgePackStagingController,
  input: {
    token: string;
    currentOwner: ActiveAppSession;
    boundaryPending: boolean;
  },
): ForgePackPublishConsume {
  if (input.boundaryPending) {
    return { kind: 'rejected', reason: 'session-boundary-pending' };
  }
  const ticket = controller.consume(input.token);
  if (!ticket) return { kind: 'rejected', reason: 'ticket-invalid' };
  if (!sameActiveAppSessionOwner(ticket.owner, input.currentOwner)) {
    controller.releaseStaging(ticket.stagingPath);
    return { kind: 'rejected', reason: 'owner-mismatch' };
  }
  return { kind: 'accepted', ticket };
}
