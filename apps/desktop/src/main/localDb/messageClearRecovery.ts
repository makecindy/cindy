import { and, eq, isNull } from 'drizzle-orm';
import { messages } from './schema.js';
import type { DbClient } from './client/DbClient.js';
import type { createLogger } from '../logger.js';

export interface MessageClearRecoveryPorts<Scope> {
  captureOwnerBroadcastScope(): Scope;
  isOwnerBroadcastScopeCurrent(scope: Scope): boolean;
  getDbClient(scope: Scope): DbClient;
  removeMediaRefs(params: { refKind: 'message'; refId: string }, scope: Scope): Promise<unknown>;
  collectCindyMediaHashes(content: string): string[];
  removeSessionAttachmentRefIfUnreferencedByLiveMessage(params: { sessionId: string; hash: string }, scope: Scope): Promise<unknown>;
  broadcastMessageDeleted(payload: { sessionId: string; clientId: string; clientIds: string[] }, scope: Scope): void;
  recomputePrRefsForSession(sessionId: string, scope: Scope): Promise<void>;
  log: Pick<ReturnType<typeof createLogger>, 'warn'>;
}

/** A clear-race tombstone retains client-id idempotency; it is not a new
 * context rebuild. Launchers supply owner-scoped cleanup and publication. */
export function createMessageClearRecovery<Scope>(ports: MessageClearRecoveryPorts<Scope>) {
  const { captureOwnerBroadcastScope, isOwnerBroadcastScopeCurrent, getDbClient,
    removeMediaRefs, collectCindyMediaHashes, removeSessionAttachmentRefIfUnreferencedByLiveMessage,
    broadcastMessageDeleted, recomputePrRefsForSession, log } = ports;
  return async function rewindPersistedUserMessageAfterClear(
    sessionId: string, clientId: string, options?: { discard?: boolean },
  ): Promise<void> {
    const ownerScope = captureOwnerBroadcastScope();
    if (!isOwnerBroadcastScopeCurrent(ownerScope)) return;
    const dbClient = getDbClient(ownerScope);
    const db = dbClient.drizzle;
    const [row] = await db
      .select({ id: messages.id, clientId: messages.clientId, content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.clientId, clientId),
          eq(messages.role, 'user'),
          isNull(messages.rewindAt),
        ),
      )
      .limit(1);
    if (!isOwnerBroadcastScopeCurrent(ownerScope)) return;
    if (!row) return;

    const rewoundAt = Date.now();
    const updated = await dbClient.tx('message.rewindUserAfterClear', {
      sessionId,
      clientId,
      rewoundAt,
      ...(options?.discard ? { discard: true } : {}),
    });
    if (!isOwnerBroadcastScopeCurrent(ownerScope)) return;
    if (updated.changes === 0) return;

    const mediaCleanup = await Promise.allSettled(
      [...new Set([row.id, row.clientId])].map((refId) =>
        removeMediaRefs({ refKind: 'message', refId }, ownerScope),
      ),
    );
    for (const [index, cleanup] of mediaCleanup.entries()) {
      if (cleanup.status === 'fulfilled') continue;
      log.warn('clear-race user media ref cleanup failed', {
        sessionId,
        clientId,
        refId: [row.id, row.clientId][index],
        error: cleanup.reason instanceof Error ? cleanup.reason.message : String(cleanup.reason),
      });
    }
    const mediaHashes = collectCindyMediaHashes(row.content);
    const mediaHashCleanup = await Promise.allSettled(
      mediaHashes.map((hash) =>
        removeSessionAttachmentRefIfUnreferencedByLiveMessage({ sessionId, hash }, ownerScope),
      ),
    );
    for (const [index, cleanup] of mediaHashCleanup.entries()) {
      if (cleanup.status === 'fulfilled') continue;
      log.warn('clear-race session media ref reconcile failed', {
        sessionId,
        clientId,
        hash: mediaHashes[index],
        error: cleanup.reason instanceof Error ? cleanup.reason.message : String(cleanup.reason),
      });
    }
    broadcastMessageDeleted({ sessionId, clientId, clientIds: [clientId] }, ownerScope);
    void recomputePrRefsForSession(sessionId, ownerScope).catch(() => undefined);
  };
}
