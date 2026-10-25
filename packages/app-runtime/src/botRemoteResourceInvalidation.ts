import { REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { botDelegations, botProfiles, botSessionLinks } from '@cindy/runtime-db/schema';
import type { DbClient } from '@cindy/runtime-db';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { BroadcastLocal, OwnerBroadcastTap } from './ownerBroadcast.js';
import { BOT_REMOTE_RESOURCE_KIND, TEAMMATES_REMOTE_COLLECTION_ID } from './botRemoteResourceProjection.js';

export function createBotRemoteResourceInvalidation(host: Pick<OwnerBroadcastTap, 'getSafeDataOwnerPushStamp' | 'tapWindowBroadcast'> & {
  getDbClient(): DbClient;
  activeOwnerScopeKey(): string;
  isAppSessionBoundaryPending(): boolean;
  broadcastLocal: BroadcastLocal;
  log: DbLogger;
  ownerScopedUserDataPath?: () => string;
  readTaskResponsibilities?: (root: string, botId: string) => Promise<Record<string, unknown>>;
}) {
const {getDbClient, activeOwnerScopeKey, isAppSessionBoundaryPending, broadcastLocal, log, getSafeDataOwnerPushStamp, tapWindowBroadcast}=host;
const localListeners = new Set<(botId: string) => void>();

/** In-process observers of the same invalidation (e.g. cloud companion sync). */
function onBotRemoteResourceChanged(listener: (botId: string) => void): () => void {
  localListeners.add(listener);
  return () => { localListeners.delete(listener); };
}

/** Notify every controller that a host-owned teammate projection must be re-read. */
function broadcastBotRemoteResourceChanged(botId: string): void {
  for (const listener of localListeners) {
    try { listener(botId); } catch { /* observers never block the broadcast */ }
  }
  const payload = {
    collectionId: TEAMMATES_REMOTE_COLLECTION_ID,
    resourceRefs: [{
      collectionId: TEAMMATES_REMOTE_COLLECTION_ID,
      kind: BOT_REMOTE_RESOURCE_KIND,
      id: botId,
    }],
  };
  try {
    tapWindowBroadcast(REMOTE_RESOURCE_CHANGED_CHANNEL, payload, getSafeDataOwnerPushStamp());
  } catch (error) {
    log.warn('remote teammate invalidation broadcast failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  broadcastLocal(REMOTE_RESOURCE_CHANGED_CHANNEL, payload);
}

const scheduledSessionLookups = new Set<string>();

function isOwnerScopeCurrent(ownerScope: string): boolean {
  try {
    return !isAppSessionBoundaryPending() && activeOwnerScopeKey() === ownerScope;
  } catch {
    return false;
  }
}

/**
 * Message previews are projected from the canonical Session. Resolve ownership
 * after the persistence stack unwinds so ordinary message hot paths stay O(1).
 */
function scheduleBotRemoteResourceChangedForSession(
  sessionId: string,
  ownerScopeAtMutation?: string,
): void {
  let ownerScope: string;
  try {
    ownerScope = ownerScopeAtMutation ?? activeOwnerScopeKey();
  } catch {
    return;
  }
  const key = `${ownerScope}\u0000${sessionId}`;
  if (scheduledSessionLookups.has(key)) return;
  scheduledSessionLookups.add(key);
  queueMicrotask(() => {
    scheduledSessionLookups.delete(key);
    if (!isOwnerScopeCurrent(ownerScope)) return;
    void getDbClient().drizzle
      .select({ botId: botSessionLinks.botId })
      .from(botSessionLinks)
      .where(and(
        eq(botSessionLinks.sessionId, sessionId),
        inArray(botSessionLinks.role, ['canonical', 'delegation']),
        isNull(botSessionLinks.archivedAt),
      ))
      .limit(1)
      .then(([link]) => {
        if (!link || !isOwnerScopeCurrent(ownerScope)) return;
        broadcastBotRemoteResourceChanged(link.botId);
      })
      .catch((error: unknown) => {
        log.warn('resolve teammate Session invalidation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

function scheduleBotRemoteResourceChangedForDelegation(delegationId: string, childSessionId: string | null): void {
  if (!childSessionId) return;
  let ownerScope: string;
  try { ownerScope = activeOwnerScopeKey(); } catch { return; }
  void getDbClient().drizzle.select({ botId: botDelegations.requestingBotId }).from(botDelegations)
    .where(eq(botDelegations.id, delegationId)).limit(1)
    .then(([row]) => { if (row?.botId && isOwnerScopeCurrent(ownerScope)) broadcastBotRemoteResourceChanged(row.botId); })
    .catch((error: unknown) => log.warn('resolve teammate delegation invalidation failed', { error: error instanceof Error ? error.message : String(error) }));
}

function scheduleBotRemoteResourceChangedForFollowedSession(sessionId: string): void {
  let ownerScope: string;
  try { ownerScope = activeOwnerScopeKey(); } catch { return; }
  void (async () => {
    const db = getDbClient().drizzle;
    const [started, bots] = await Promise.all([
      db.select({ botId: botDelegations.requestingBotId }).from(botDelegations).where(eq(botDelegations.childSessionId, sessionId)),
      db.select({ id: botProfiles.id }).from(botProfiles).where(eq(botProfiles.status, 'active')),
    ]);
    const botIds = new Set(started.map((row) => row.botId));
    if (host.ownerScopedUserDataPath && host.readTaskResponsibilities) {
      const root = host.ownerScopedUserDataPath();
      await Promise.all(bots.filter(({ id }) => !botIds.has(id)).map(async ({ id }) => {
        const records = await host.readTaskResponsibilities!(root, id).catch(() => ({}));
        if (Object.hasOwn(records, sessionId)) botIds.add(id);
      }));
    }
    if (!isOwnerScopeCurrent(ownerScope)) return;
    for (const botId of botIds) broadcastBotRemoteResourceChanged(botId);
  })().catch((error: unknown) => log.warn('resolve followed task invalidation failed', { error: error instanceof Error ? error.message : String(error) }));
}

return { onBotRemoteResourceChanged, broadcastBotRemoteResourceChanged, scheduleBotRemoteResourceChangedForSession, scheduleBotRemoteResourceChangedForDelegation, scheduleBotRemoteResourceChangedForFollowedSession };
}
