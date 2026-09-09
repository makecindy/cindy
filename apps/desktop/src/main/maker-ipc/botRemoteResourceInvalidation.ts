import { BrowserWindow } from 'electron';
import { REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import { and, eq, isNull } from 'drizzle-orm';

import {
  BOT_REMOTE_RESOURCE_KIND,
  TEAMMATES_REMOTE_COLLECTION_ID,
} from '../localDb/ipc/botRemoteResourceProjection.js';
import {
  getSafeDataOwnerPushStamp,
  tapWindowBroadcast,
} from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks } from '../localDb/schema.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';

const log = createLogger('maker-ipc:bot-remote-resource');

/** Notify every controller that a host-owned teammate projection must be re-read. */
export function broadcastBotRemoteResourceChanged(botId: string): void {
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
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(REMOTE_RESOURCE_CHANGED_CHANNEL, payload);
    } catch (error) {
      log.warn('remote teammate window invalidation failed', { error: String(error) });
    }
  }
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
export function scheduleBotRemoteResourceChangedForSession(
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
        eq(botSessionLinks.role, 'canonical'),
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
