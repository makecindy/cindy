/** Desktop wiring for the inbox helper tools; the rules live in taskInboxHost.ts. */
import type { InvokeResultPayload } from '@cindy/device-link';
import type { HistoryTaskInboxSignals, TaskInboxDeps } from '@cindy/mcps';
import { eq } from 'drizzle-orm';

import { getAgentIslandService } from '../agent-island/service.js';
import { clearSessionAttention } from '../appBadgeService.js';
import { bindingStore } from '../im/binding.js';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { dismissSessionPendingAlerts, patchSessionMetaInDb } from '../localDb/ipc/sessions.js';
import { sessions } from '../localDb/schema.js';
import { listErrorTailPendingRows, listInterruptedPendingRows } from '../localDb/sessionActiveTurn.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import { createLogger } from '../logger.js';
import { markSessionScheduleRunsRead } from '../maker-ipc/schedule.js';
import { assertTaskActionCurrent, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization.js';
import { getScheduleStorageIfInitialized } from '../scheduler-host/index.desktop.js';
import { isTaskBusyForArchive } from '../task-management/service.js';
import { createRemoteSessionsSnoozeSetter } from './sessionStatusRemote.js';
import { completeLocalSessions, readTaskInboxSignals, setLocalSessionsSnooze } from './taskInboxHost.js';

const log = createLogger('task-inbox-tools');

async function followingSessionIds(): Promise<ReadonlySet<string> | null> {
  const storage = getScheduleStorageIfInitialized();
  if (!storage) return null;
  const schedules = await storage.list({ status: 'active' });
  return new Set(schedules.flatMap((schedule) => (schedule.targetSessionId ? [schedule.targetSessionId] : [])));
}

/** list_sessions include_inbox on this computer, for local callers and the history tunnel. */
export async function readDesktopTaskInbox(
  sessionIds: string[],
): Promise<{ ok: true; signals: Record<string, HistoryTaskInboxSignals> } | { ok: false; errorCode: 'HOST_NOT_READY' | 'INTERNAL'; message: string }> {
  if (!tryGetDbClient()) return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
  try {
    return {
      ok: true,
      signals: await readTaskInboxSignals(sessionIds, {
        liveActivity: () => getAgentIslandService()?.getSessionActivitySnapshots() ?? [],
        pendingAlertSessionIds: async () => {
          const [tail, interrupted] = await Promise.all([listErrorTailPendingRows(), listInterruptedPendingRows()]);
          return new Set([...tail, ...interrupted].map((row) => row.sessionId));
        },
        followingSessionIds,
        unreadRunSessionIds: async (ids) =>
          (await getScheduleStorageIfInitialized()?.listSessionIdsWithUnreadRuns(ids)) ?? new Set(),
      }),
    };
  } catch (error) {
    return { ok: false, errorCode: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
  }
}

export function createDesktopTaskInboxWrites(deps: {
  historyRemote?: { captureAccess(): () => void };
  invokeRemote(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<InvokeResultPayload>;
}): Pick<TaskInboxDeps, 'setSessionsSnooze' | 'completeSessions'> {
  const remoteSnooze = deps.historyRemote
    ? createRemoteSessionsSnoozeSetter({ captureAccess: deps.historyRemote.captureAccess, invoke: deps.invokeRemote })
    : null;
  return {
    setSessionsSnooze: async ({ deviceId, sessionIds, snoozedUntil }) => {
      if (deviceId) {
        if (remoteSnooze) return remoteSnooze({ deviceId, sessionIds, snoozedUntil });
        return { ok: false, errorCode: 'REMOTE_UNSUPPORTED', message: '当前宿主不支持跨电脑稍后处理；本次没有写入。',
          changed: [], failedSessionId: sessionIds[0], remainingSessionIds: sessionIds.slice(1) };
      }
      if (!tryGetDbClient()) {
        return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready',
          changed: [], failedSessionId: sessionIds[0], remainingSessionIds: sessionIds.slice(1) };
      }
      return setLocalSessionsSnooze({ sessionIds, snoozedUntil }, async (sessionId, until) => {
        await assertTaskActionCurrent();
        return patchSessionMetaInDb(sessionId, { snoozedUntil: until }, { beforeWrite: captureTaskActionSyncGuard() }) as unknown as Record<string, unknown>;
      });
    },
    completeSessions: async ({ sessionIds }) => {
      if (!tryGetDbClient()) return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
      const items = await completeLocalSessions(sessionIds, {
        readSession: async (sessionId) => {
          const [row] = await getDbClient().drizzle
            .select({ status: sessions.status, title: sessions.title })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          return row ?? null;
        },
        isBusy: isTaskBusyForArchive,
        isImAttached: (sessionId) => !!bindingStore.findByTarget(sessionId),
        followingSessionIds,
        markRead: async (sessionId) => {
          await assertTaskActionCurrent();
          // Explicit read, as the sidebar's "Done": the island, badge and controllers follow.
          clearSessionAttention(sessionId, 'explicit');
          const { failed } = await dismissSessionPendingAlerts([sessionId]);
          if (failed.length > 0) log.warn('pending alert dismissal failed', { count: failed.length });
          const storage = getScheduleStorageIfInitialized();
          if (storage) await markSessionScheduleRunsRead(storage, [sessionId]);
        },
        archive: async (sessionId, recheck) => {
          await assertTaskActionCurrent();
          const assertActionCurrent = captureTaskActionSyncGuard();
          await withSessionRouteLock(sessionId, () => patchSessionMetaInDb(sessionId, { status: 'archived' }, {
            routeLockHeld: true,
            // The DB writer calls this again after its worktree and resource waits.
            beforeWrite: () => {
              recheck();
              assertActionCurrent?.();
            },
          }));
        },
      });
      return { ok: true, items };
    },
  };
}
