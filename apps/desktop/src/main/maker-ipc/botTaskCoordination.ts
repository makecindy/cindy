import { and, eq, isNull } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { botDelegations, botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import type { BotTaskCoordination, SessionMessagePurpose } from '../../shared/botTaskCoordination.js';
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';

/** Same-owner DB joins, not the caller's source labels, prove the delegation. */
export async function readBotTaskCoordination(
  senderSessionId: string, targetSessionId: string,
): Promise<BotTaskCoordination | null> {
  const [row] = await getDbClient().drizzle.select({
    delegationId: botDelegations.id, runSequence: botDelegations.runSequence,
  }).from(botDelegations)
    .innerJoin(botProfiles, eq(botProfiles.id, botDelegations.requestingBotId))
    .innerJoin(botSessionLinks, and(eq(botSessionLinks.botId, botProfiles.id), eq(botSessionLinks.sessionId, targetSessionId)))
    .innerJoin(sessions, eq(sessions.id, botDelegations.childSessionId))
    .where(and(eq(botDelegations.childSessionId, senderSessionId),
      eq(botDelegations.parentSessionId, targetSessionId),
      eq(botProfiles.canonicalSessionId, targetSessionId), eq(botProfiles.status, 'active'),
      eq(botSessionLinks.role, 'canonical'), isNull(botSessionLinks.archivedAt),
      eq(sessions.status, 'active'))).limit(1);
  return row ? { ...row, senderSessionId } : null;
}

export async function classifySessionMessagePurpose(params: {
  senderSessionId?: string;
  targetSessionId?: string;
  purpose?: SessionMessagePurpose;
}, read = readBotTaskCoordination): Promise<{ coordination: BotTaskCoordination | null; delegatedContinuation: boolean }> {
  const receipt = params.senderSessionId && params.targetSessionId
    ? await read(params.senderSessionId, params.targetSessionId) : null;
  if (!receipt && params.purpose === 'coordination') {
    throw new Error('Coordination requires a delegated task sending to its requesting teammate.');
  }
  // Visibility is independent of authority: public task messages are still delegated input.
  return { coordination: params.purpose === 'user-visible' ? null : receipt, delegatedContinuation: receipt !== null };
}

export async function assertBotTaskCoordination(
  targetSessionId: string, receipt: BotTaskCoordination,
  read = readBotTaskCoordination,
): Promise<void> {
  const current = await read(receipt.senderSessionId, targetSessionId);
  if (!current || current.delegationId !== receipt.delegationId || current.runSequence !== receipt.runSequence) {
    throw new Error('The task coordination recipient or execution has changed; delivery was not accepted.');
  }
}

export function coordinationInput(message: string, receipt: BotTaskCoordination) {
  return { message, persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${message}`, botTaskCoordination: receipt };
}
