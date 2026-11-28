import {
  projectSessionActivity,
  resolveSessionRightStatus,
  type SessionActivitySnapshot,
  type SessionRecordStatus,
} from '@cindy/maker-shared/session-activity';
import { eq } from 'drizzle-orm';

import { DESKTOP_TASK_LIST_SESSION_SOURCES, type SessionSource } from '../../shared/sessionSource.js';
import { getAgentIslandService } from '../agent-island/current.js';
import { getIssueConfirmBridge } from '../github-issue/issueConfirmBridge.js';
import { getHostInterruptedTurnStartedAt } from '../localDb/sessionInterruptionBoot.js';
import { getDbClient } from '../localDb/client/current.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { sessions } from '../localDb/schema.js';
import {
  readLatestSessionTerminal,
  readSidebarErrorTailIds,
  type SessionTerminalHint,
} from '../localDb/sessionTerminal.js';

interface PersistedTurnFacts {
  status: SessionRecordStatus;
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  clearedAt: number | null;
}

export interface PersistedSessionActivityFacts extends PersistedTurnFacts {
  source: SessionSource;
  remoteHostId: string | null;
  scheduleUnread?: 'error' | 'done' | null;
}

export type ReadSessionActivityFlags = (ids: Iterable<string>) =>
  ReadonlyMap<string, Pick<SessionActivitySnapshot, 'phase' | 'attention'>> | undefined;

export interface SessionActivityReaderDeps {
  getLiveSnapshot(sessionId: string): SessionActivitySnapshot | null;
  getPersistedFacts(sessionId: string): Promise<PersistedTurnFacts | null>;
  getLatestTerminal(
    sessionId: string,
    clearedAt: number | null,
  ): Promise<SessionTerminalHint | undefined>;
}

/**
 * Build a canonical reader from the existing live and durable authorities.
 * This is a projection only: it never persists or owns another status copy.
 */
export function createSessionActivityReader(deps: SessionActivityReaderDeps) {
  return async (sessionId: string): Promise<SessionActivitySnapshot> => {
    const live = deps.getLiveSnapshot(sessionId);
    if (live) return live;

    const row = await deps.getPersistedFacts(sessionId);
    if (!row) return projectSessionActivity({ sessionId, source: 'fallback' });

    const terminal = await deps.getLatestTerminal(sessionId, row.clearedAt);
    const visibilityBoundary = Math.max(row.endedAt ?? 0, row.clearedAt ?? 0);
    const interrupted = row.startedAt !== null && row.startedAt > visibilityBoundary;
    const completed =
      row.endedAt !== null
      && row.endedAt > (row.clearedAt ?? 0)
      && (row.startedAt === null || row.endedAt >= row.startedAt);
    const failed = terminal !== undefined || interrupted;

    return projectSessionActivity({
      sessionId,
      recordStatus: row.status,
      title: row.title,
      source: 'persisted',
      terminal: failed ? 'error' : completed ? 'completed' : null,
      startedAtMs: row.startedAt,
      lastActivityAtMs: terminal?.createdAt ?? (interrupted ? row.startedAt : row.endedAt ?? row.startedAt),
      currentActionSummary: terminal
        ? '上次运行出错'
        : interrupted
          ? '上次运行未正常结束'
          : completed
            ? '上次运行已正常结束'
            : null,
      attention: failed,
    });
  };
}

async function readPersistedSessionActivityFacts(
  sessionId: string,
): Promise<PersistedTurnFacts | null> {
  const [row] = await getDbClient()
    .drizzle.select({
      status: sessions.status,
      title: sessions.title,
      startedAt: sessions.activeTurnStartedAt,
      endedAt: sessions.lastTurnEndedAt,
      clearedAt: sessions.clearedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

const readDefaultSessionActivity = createSessionActivityReader({
  getLiveSnapshot: (sessionId) =>
    getAgentIslandService()?.getSessionActivitySnapshot(sessionId) ?? null,
  getPersistedFacts: readPersistedSessionActivityFacts,
  getLatestTerminal: readLatestSessionTerminal,
});

/** Main-owned canonical activity read shared by UI-backed state and MCP probes. */
export function readCanonicalSessionActivity(
  sessionId: string,
): Promise<SessionActivitySnapshot> {
  return readDefaultSessionActivity(sessionId);
}

/**
 * Batch read for list views: one live projection pass, with persisted facts
 * supplied by the caller's own query, so each session does not rebuild the live list.
 */
export function createCanonicalSessionRightStatusBatchReader(
  persisted: ReadonlyMap<string, PersistedSessionActivityFacts>,
  db: DbClient['drizzle'],
  readLive?: ReadSessionActivityFlags,
) {
  const live = readLive
    ? readLive(persisted.keys())
    : getAgentIslandService()?.getSessionActivityFlags(persisted.keys());
  const pendingIssues = readLive ? undefined : getIssueConfirmBridge()?.pendingSessionIds(persisted.keys());
  let errorTailIds: Promise<Set<string>> | undefined;
  return async (id: string) => {
    const row = persisted.get(id);
    if (!row) return 'time';
    const activity = live?.get(id);
    const interrupted = getHostInterruptedTurnStartedAt(row.source, {
      status: row.status,
      activeTurnStartedAt: row.startedAt,
      lastTurnEndedAt: row.endedAt,
      clearedAt: row.clearedAt == null ? null : new Date(row.clearedAt).toISOString(),
    });
    let error = interrupted !== null || row.scheduleUnread === 'error';
    if (!error && !activity && row.status === 'active') {
      // Live-only reads skip messages. Archived rows have no unresolved native error-tail alert.
      errorTailIds ??= readSidebarErrorTailIds(db, [...persisted]
        .filter(([key, facts]) =>
          !live?.has(key) && facts.status === 'active' && facts.scheduleUnread !== 'error'
          && DESKTOP_TASK_LIST_SESSION_SOURCES.includes(facts.source))
        .map(([key, facts]) => [key, facts.clearedAt]));
      error = (await errorTailIds).has(id);
    }
    return resolveSessionRightStatus(projectSessionActivity({
      sessionId: id,
      livePhase: activity?.phase,
      waitingForUser: !row.remoteHostId && pendingIssues?.has(id),
      terminal: error ? 'error' : row.scheduleUnread === 'done' ? 'completed' : null,
      attention: error || !!row.scheduleUnread || activity?.attention,
    }));
  };
}
