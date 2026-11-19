/**
 * "Opened by this teammate": the host records which teammate created a task with
 * send_to_session (task-responsibility.v1.json, `created`), and resolves the teammate behind a
 * caller session. The record feeds the sidebar mark, the teammate filter and the roster links;
 * it grants no access to the task.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { broadcastBotLinkedProjectsChanged } from './botLinkedProjectStore.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import { listBotDelegationChildIds } from './botDelegationHistory.js';
import { createdSessionIds, readTaskResponsibilities, setTaskResponsibility } from './botTaskResponsibility.js';

type Failure = { ok: false; errorCode: string; message: string };
export type TeammateCallerResult = { ok: true; botId: string } | Failure;

/** The teammate whose lane on this computer is calling (its project links are managed from any of them). */
export async function resolveTeammateMainCaller(callerSessionId: string): Promise<TeammateCallerResult> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      sessionStatus: sessions.status,
      remoteHostId: sessions.remoteHostId,
      profileStatus: botProfiles.status,
      linkArchivedAt: botSessionLinks.archivedAt,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(eq(botSessionLinks.sessionId, callerSessionId), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row) return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
  if (row.sessionStatus !== 'active' || row.profileStatus !== 'active' || row.linkArchivedAt !== null) {
    return { ok: false, errorCode: 'BOT_SESSION_INACTIVE', message: '伙伴或它的主任务已停用' };
  }
  // Any lane of the teammate (its chat, a topic, a channel or group lane) is the teammate: whether a
  // change is allowed is the task's ordinary authorization, not which lane asked.
  if (row.remoteHostId) {
    // Stable code kept from the workbench era; older callers branch on it.
    return { ok: false, errorCode: 'REMOTE_WORKBENCH_UNAVAILABLE', message: '远端伙伴暂不支持项目关联' };
  }
  return { ok: true, botId: row.botId };
}

/** The facts that decide whether a freshly created task can carry a creator mark. */
async function readWorkbenchTarget(taskId: string): Promise<{
  status: string; botLinked: boolean; remoteHostId: string | null; orcaRole: string | null;
} | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ status: sessions.status, remoteHostId: sessions.remoteHostId, orcaRole: sessions.orcaRole })
    .from(sessions)
    .where(eq(sessions.id, taskId))
    .limit(1);
  if (!row) return null;
  const [link] = await db.select({ id: botSessionLinks.id }).from(botSessionLinks).where(eq(botSessionLinks.sessionId, taskId)).limit(1);
  return { status: row.status, botLinked: Boolean(link), remoteHostId: row.remoteHostId ?? null, orcaRole: row.orcaRole ?? null };
}

/**
 * The tasks this teammate opened with send_to_session, wherever they live, plus the children of
 * its V1 background tasks (read from the existing rows). `delegatedSessionIds` keeps every one of
 * them (the owner chip); `sessionIds` drops the ones it released (the sidebar avatar and teammate
 * filter). Tasks in the teammate's own project are matched by path instead.
 */
export async function readBotResponsibilityScope(
  userDataDir: string, botId: string,
): Promise<{ sessionIds: string[]; delegatedSessionIds: string[] }> {
  const records = await readTaskResponsibilities(userDataDir, botId);
  const created = [...new Set([...createdSessionIds(records), ...await listBotDelegationChildIds(botId)])].sort();
  return {
    sessionIds: created.filter((id) => records[id]?.responsible !== false),
    delegatedSessionIds: created,
  };
}

/** Creation attribution is not a main-chat check: channel/group conversations can create tasks too. */
async function resolveBotTaskCreator(callerSessionId: string): Promise<string | null> {
  const [row] = await getDbClient().drizzle
    .select({ botId: botSessionLinks.botId })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(
      eq(botSessionLinks.sessionId, callerSessionId),
      inArray(botSessionLinks.role, ['canonical', 'thread', 'channel', 'group', 'routine']),
      isNull(botSessionLinks.archivedAt),
      eq(sessions.source, 'bot'),
      eq(sessions.status, 'active'),
      isNull(sessions.remoteHostId),
      eq(botProfiles.status, 'active'),
    ))
    .limit(1);
  return row?.botId ?? null;
}

/** Capture the creator before a generic create-mode handoff crosses async boundaries. */
export async function captureBotCreatedTaskResponsibility(callerSessionId?: string,
  options?: { remoteDeviceId: string },
) {
  if (!callerSessionId || isAppSessionBoundaryPending()) return null;
  const scope = activeOwnerScopeKey();
  const root = ownerScopedUserDataPath();
  const botId = await resolveBotTaskCreator(callerSessionId);
  if (!botId) return null;
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) throw new Error('OWNER_SCOPE_CHANGED');
  };
  assertCurrent();
  return async (sessionId: string) => {
    assertCurrent();
    if (options?.remoteDeviceId) {
      // Only the host's successful ordinary-create receipt calls this recorder.
      // Its qualified ID is stored in the existing responsibility map, never as a local row.
      const prefix = `${options.remoteDeviceId}::`;
      if (!sessionId.startsWith(prefix) || !sessionId.slice(prefix.length) || sessionId.slice(prefix.length).includes('::')) return;
    } else {
      const target = await readWorkbenchTarget(sessionId);
      if (!target || target.status !== 'active' || target.botLinked || target.remoteHostId || target.orcaRole === 'worker') return;
    }
    assertCurrent();
    await setTaskResponsibility(root, botId, sessionId, true, assertCurrent, { created: true });
    // The desktop sidebar re-reads the follow scopes on the same push.
    broadcastBotLinkedProjectsChanged(botId);
    // Remote task rows draw the same mark from the teammate roster's links.
    broadcastBotRemoteResourceChanged(botId);
  };
}
