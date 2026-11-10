import { createLogger } from '../logger.js';
import type { Session } from '@cindy/maker-core';
import {
  mergeBotLearningReceipts,
  readBotLearningReceipts,
  type BotLearningReceipt,
} from '@cindy/maker-shared/bot-learning';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  broadcastMessageAgentMetaUpdate,
  patchMessageAgentMetaWithResult,
} from '../localDb/ipc/messages.js';
import { enqueueDurableWrite } from '../messagePersistBroadcaster.desktop.js';
import { botLearningTracker } from './botLearningTracker.js';

export function learningTurnIdentity(session: Session, generation = session.getTurnGeneration()) {
  return `${session.instanceId}:${generation}`;
}

/**
 * Which replies may carry a save receipt:
 * - a teammate Session (`source='bot'`): only its main or history chat (`canonical` / `history`);
 *   group lanes, channels, topics, routines and delegated tasks show none;
 * - an ordinary task: any Session that is neither a teammate Session nor linked to a teammate.
 */
function sessionShowsReceipts(source: string | null, botRole: string | null): boolean {
  if (botRole === null) return source !== 'bot';
  return source === 'bot' && (botRole === 'canonical' || botRole === 'history');
}

/** Frozen owner + reply ID, so delayed writes cannot migrate to a later bubble/account. */
export function learningReceiptPublisher(sessionId: string) {
  const owner = activeOwnerScopeKey();
  return (replyId: string, receipts: BotLearningReceipt[]) => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) return;
    const db = getDbClient();
    void enqueueDurableWrite(`bot-learning:${sessionId}:${replyId}`, async (scope) => {
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner || getDbClient() !== db)
        return;
      const row = await db.queryOne<{ meta: string; source: string | null; botRole: string | null }>(
        `
        SELECT m.agent_meta AS meta, s.source AS source, b.role AS botRole FROM messages m
        JOIN sessions s ON s.id=m.session_id LEFT JOIN bot_session_links b ON b.session_id=s.id
        WHERE m.session_id=? AND m.client_id=? AND m.role='assistant' AND m.rewind_at IS NULL
          AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
      `,
        [sessionId, replyId],
      );
      if (!row || !sessionShowsReceipts(row.source ?? null, row.botRole ?? null)) return;
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(row.meta || '{}');
      } catch {
        return;
      }
      // Sub-agent messages never carry one; the teammate-only markers do not occur in ordinary tasks.
      if (meta.parentUuid || meta.botPrivateReply || meta.botGroupLane) return;
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner || getDbClient() !== db)
        return;
      const botLearning = mergeBotLearningReceipts(
        readBotLearningReceipts(meta.botLearning),
        receipts,
      );
      if (await patchMessageAgentMetaWithResult(sessionId, replyId, { botLearning }))
        await broadcastMessageAgentMetaUpdate(sessionId, replyId, scope);
    }).catch(() => createLogger('bot-learning').warn('Could not persist learning receipt'));
  };
}

export function observeBotLearningTurn(session: Session, generation?: number) {
  if (session.remoteHostId) return;
  botLearningTracker.observe(
    session.id,
    learningTurnIdentity(session, generation),
    learningReceiptPublisher(session.id),
  );
}
