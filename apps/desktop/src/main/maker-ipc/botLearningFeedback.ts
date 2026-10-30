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
import { enqueueDurableWrite } from '../messagePersistBroadcaster.js';
import { botLearningTracker } from './botLearningTracker.js';

export function learningTurnIdentity(session: Session, generation = session.getTurnGeneration()) {
  return `${session.instanceId}:${generation}`;
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
      const row = await db.queryOne<{ meta: string }>(
        `
        SELECT m.agent_meta AS meta FROM messages m
        JOIN sessions s ON s.id=m.session_id JOIN bot_session_links b ON b.session_id=s.id
        WHERE m.session_id=? AND m.client_id=? AND m.role='assistant' AND m.rewind_at IS NULL
          AND b.role IN ('canonical', 'history') AND s.source='bot'
          AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
      `,
        [sessionId, replyId],
      );
      if (!row) return;
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(row.meta || '{}');
      } catch {
        return;
      }
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
