import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { getSessionListActivityAt, type SessionRightStatus } from '@cindy/maker-shared/session-activity';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { botSessionLinks, orcaTeams, orcaWorkers, sessions } from '../localDb/schema.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import type { PluginObserveTask, PluginObserveTaskStatus, PluginSessionStatus } from '../../shared/pluginObserve.js';
import { createCanonicalSessionRightStatusBatchReader, type PersistedSessionActivityFacts } from './sessionActivityProjection.js';

const MAX_PROJECT_TASKS = 200;
const projectKey = (dir: string) => projectKeyComparisonKey(`local:${dir}`, process.platform);

/** Ordinary records that openSession can navigate to by known ID in this account's database. */
const observableSession = and(
  or(eq(sessions.status, 'active'), eq(sessions.status, 'archived')),
  isNull(sessions.hiddenAt),
  isNull(botSessionLinks.id),
  ne(sessions.source, 'bot'),
  ne(sessions.source, 'review'),
  or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
);

const visibleTask = and(
  observableSession,
  eq(sessions.workspaceKind, 'project'),
  isNull(sessions.remoteHostId),
  isNull(sessions.agentDeviceId),
);

const activityFacts = {
  status: sessions.status,
  title: sessions.title,
  startedAt: sessions.activeTurnStartedAt,
  endedAt: sessions.lastTurnEndedAt,
  clearedAt: sessions.clearedAt,
};

async function registeredProjectKey(snapshot: CurrentDbClientSnapshot, project: string): Promise<string> {
  const key = projectKey(project);
  const registered = (await listRecentWorkdirs(snapshot.client)).some((row) => row.exists && projectKey(row.path) === key);
  if (!key || !registered) throw new Error('TARGET_UNAVAILABLE');
  return key;
}

/** Sidebar rule: a local lead shows its workers' error, then awaiting, above its own status. */
function withWorkerAttention(own: SessionRightStatus, workers: SessionRightStatus[]): SessionRightStatus {
  if (own === 'error' || workers.includes('error')) return 'error';
  if (own === 'awaiting' || workers.includes('awaiting')) return 'awaiting';
  return own;
}

async function readObserveStatuses(
  db: DbClient['drizzle'],
  matched: Array<PersistedSessionActivityFacts & Pick<typeof sessions.$inferSelect, 'id' | 'orcaRole'>>,
): Promise<Map<string, PluginObserveTaskStatus>> {
  const statuses = new Map<string, PluginObserveTaskStatus>();
  if (matched.length === 0) return statuses;
  const leadIds = matched.filter((row) => row.orcaRole === 'lead').map((row) => row.id);
  const workers = leadIds.length === 0 ? [] : await db
    .select({ ...activityFacts, id: sessions.id, leadSessionId: orcaTeams.leadSessionId })
    .from(orcaWorkers)
    .innerJoin(orcaTeams, eq(orcaTeams.id, orcaWorkers.teamId))
    .innerJoin(sessions, eq(sessions.id, orcaWorkers.sessionId))
    .where(and(
      inArray(orcaTeams.leadSessionId, leadIds),
      eq(orcaTeams.status, 'active'),
      isNull(orcaWorkers.executionDeviceId),
      eq(sessions.status, 'active'),
    ));
  const persisted = new Map<string, PersistedSessionActivityFacts>([...matched, ...workers].map((row) => [row.id, row]));
  const readStatus = createCanonicalSessionRightStatusBatchReader(persisted, db);
  const workerStatuses = new Map<string, SessionRightStatus[]>();
  for (const worker of workers) {
    const list = workerStatuses.get(worker.leadSessionId) ?? [];
    list.push(await readStatus(worker.id));
    workerStatuses.set(worker.leadSessionId, list);
  }
  for (const row of matched) {
    const status = withWorkerAttention(await readStatus(row.id), workerStatuses.get(row.id) ?? []);
    statuses.set(row.id, status === 'time' ? 'idle' : status);
  }
  return statuses;
}

/** Metadata-only task list for one registered local project. */
export async function listPluginObserveTasks(project: string): Promise<PluginObserveTask[]> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  const db = snapshot.client.drizzle;
  const key = await registeredProjectKey(snapshot, project);
  const rows = await db
    .select({
      ...activityFacts,
      id: sessions.id,
      agentKind: sessions.agentKind,
      orcaRole: sessions.orcaRole,
      workingDir: sessions.workingDir,
      lastActivityAt: sessions.lastActivityAt,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
    .where(visibleTask);
  const matched = rows
    .filter((row) => row.workingDir !== null && projectKey(row.workingDir) === key)
    .sort((a, b) => getSessionListActivityAt(b) - getSessionListActivityAt(a))
    .slice(0, MAX_PROJECT_TASKS);
  const statuses = await readObserveStatuses(db, matched);
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
  return matched.map(row => ({
    id: row.id,
    title: row.title,
    agentKind: row.agentKind,
    archived: row.status === 'archived',
    status: statuses.get(row.id)!,
    lastActivityAt: getSessionListActivityAt(row),
  }));
}

/** The record owner is the selected database. SSH and agent-device fields describe execution. */
export async function listPluginSessionStatuses(ids: string[]): Promise<PluginSessionStatus[]> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  if (ids.length === 0) return [];
  const db = snapshot.client.drizzle;
  const requested = [...new Set(ids)];
  const rows = await db.select({ ...activityFacts, id: sessions.id, orcaRole: sessions.orcaRole })
    .from(sessions)
    .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
    .where(and(inArray(sessions.id, requested), observableSession));
  const statuses = await readObserveStatuses(db, rows);
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
  return requested.flatMap(id => {
    const status = statuses.get(id);
    return status ? [{ id, status }] : [];
  });
}

/** Only a visible task of a registered local project may be opened. */
export async function assertPluginObservableTask(taskId: string): Promise<void> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  const [row] = await snapshot.client.drizzle
    .select({ workingDir: sessions.workingDir })
    .from(sessions)
    .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
    .where(and(eq(sessions.id, taskId), visibleTask))
    .limit(1);
  if (!row?.workingDir) throw new Error('TARGET_UNAVAILABLE');
  await registeredProjectKey(snapshot, row.workingDir);
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
}
