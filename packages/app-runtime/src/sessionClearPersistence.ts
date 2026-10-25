import { eq, sql } from 'drizzle-orm';
import { sessions } from '@cindy/runtime-db/schema';
import type { SessionServiceHost } from './sessionServiceHost.js';
export function createSessionClearPersistence(host: Pick<SessionServiceHost<unknown>, 'captureOwnerScope' | 'noteSessionClearBoundary' | 'getDbClient' | 'isOwnerScopeCurrent' | 'recoverGeneratedImagesForHistory' | 'removeTurnChangeSetsForSession' | 'recomputePrRefsForSession' | 'broadcastSessionPatched' | 'broadcastSubagentRunsInvalidated' | 'logger'>) {
  const { captureOwnerScope, noteSessionClearBoundary, getDbClient, isOwnerScopeCurrent, recoverGeneratedImagesForHistory, removeTurnChangeSetsForSession, recomputePrRefsForSession, broadcastSessionPatched, broadcastSubagentRunsInvalidated, logger: log } = host;
  async function clearSessionContextInDb(
    sessionId: string,
    atMs?: number,
  ): Promise<void> {
    const ownerScope = captureOwnerScope();
    const ts =
      typeof atMs === "number" && Number.isFinite(atMs) && atMs > 0
        ? Math.floor(atMs)
        : Date.now();
    // Device-link /clear has no local renderer sessions:update call to populate
    // the main-process background-event boundary. Advance it before the DB await
    // so persistence failure still keeps old late events behind the clear.
    noteSessionClearBoundary(sessionId, ts);
    const db = getDbClient().drizzle;
    await db
      .update(sessions)
      .set({
        sdkSessionId: null,
        codexPlanJson: null,
        // Concurrent /clear calls may finish their DB awaits out of order. Keep
        // both persisted boundaries monotonic so the older completion cannot
        // make pre-clear history visible again or invalidate a newer input token.
        clearedAt: sql<number>`MAX(COALESCE(${sessions.clearedAt}, 0), ${ts})`,
        updatedAt: sql<number>`MAX(COALESCE(${sessions.updatedAt}, 0), ${ts})`,
        listPreview: null,
        listPreviewRole: null,
      })
      .where(eq(sessions.id, sessionId));
    const [updated] = await db
      .select({ clearedAt: sessions.clearedAt, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const effectiveClearedAt = updated?.clearedAt ?? ts;
    if (isOwnerScopeCurrent(ownerScope))
      void recoverGeneratedImagesForHistory(sessionId).catch(() => undefined);
    const effectiveUpdatedAt = updated?.updatedAt ?? effectiveClearedAt;
    // Concurrent clears can make SQLite return a newer monotonic boundary than
    // this request supplied. Mirror the effective value into the in-memory gate.
    noteSessionClearBoundary(sessionId, effectiveClearedAt);
    try {
      await removeTurnChangeSetsForSession(sessionId);
    } catch (error) {
      log.warn("turn change-set cleanup after clear failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    void recomputePrRefsForSession(sessionId).catch(() => undefined);
    if (isOwnerScopeCurrent(ownerScope)) {
      broadcastSessionPatched(
        sessionId,
        {
          sdkSessionId: null,
          clearedAt: new Date(effectiveClearedAt).toISOString(),
          updatedAt: new Date(effectiveUpdatedAt).toISOString(),
          preview: null,
        },
        ownerScope,
      );
      broadcastSubagentRunsInvalidated(sessionId, ownerScope);
    }
  }

  return { clearSessionContextInDb };
}
