import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { getSessionListActivityAt, resolveSessionRightStatus, type SessionRightStatus } from '@cindy/maker-shared/session-activity';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botSessionLinks, orcaTeams, orcaWorkers, sessions } from '../localDb/schema.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import type { PluginObserveTask } from '../../shared/pluginObserve.js';
import { createCanonicalSessionActivityBatchReader, type PersistedSessionActivityFacts } from './sessionActivityProjection.js';

const MAX_PROJECT_TASKS = 200;
const projectKey = (dir: string) => projectKeyComparisonKey(`local:${dir}`, process.platform);

/** Same visibility as plugin targets, plus archived tasks; excludes dialogues. */
const visibleTask = and(
  or(eq(sessions.status, 'active'), eq(sessions.status, 'archived')),
  eq(sessions.workspaceKind, 'project'),
  isNull(sessions.remoteHostId),
  isNull(sessions.agentDeviceId),
  isNull(sessions.hiddenAt),
  isNull(botSessionLinks.id),
  ne(sessions.source, 'bot'),
  ne(sessions.source, 'review'),
  or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
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

/**
 * Metadata-only task list for one registered local project, using the
 * canonical activity read model so status matches the sidebar.
 */
export async function listPluginObserveTasks(project: string): Promise<PluginObserveTask[]> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  const key = await registeredProjectKey(snapshot, project);
  const db = snapshot.client.drizzle;
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
  const readActivity = createCanonicalSessionActivityBatchReader(persisted);
  const readStatus = async (id: string) => resolveSessionRightStatus(await readActivity(id));
  const workerStatuses = new Map<string, SessionRightStatus[]>();
  for (const worker of workers) {
    const list = workerStatuses.get(worker.leadSessionId) ?? [];
    list.push(await readStatus(worker.id));
    workerStatuses.set(worker.leadSessionId, list);
  }
  const tasks = await Promise.all(matched.map(async (row): Promise<PluginObserveTask> => {
    const status = withWorkerAttention(await readStatus(row.id), workerStatuses.get(row.id) ?? []);
    return {
      id: row.id,
      title: row.title,
      agentKind: row.agentKind,
      archived: row.status === 'archived',
      status: status === 'time' ? 'idle' : status,
      lastActivityAt: getSessionListActivityAt(row),
    };
  }));
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
  return tasks;
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
