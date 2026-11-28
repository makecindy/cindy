import {
  projectSessionActivity,
  type SessionActivitySnapshot,
  type SessionRecordStatus,
} from '@cindy/maker-shared/session-activity';
import { eq } from 'drizzle-orm';

import { getAgentIslandService } from '../agent-island/service.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import {
  readLatestSessionTerminal,
  type SessionTerminalHint,
} from '../localDb/sessionTerminal.js';
import type { WorktreeProvisioningSnapshot } from '../../shared/worktreeProvisioning.js';

type ProvisioningLookup = (sessionId: string) => WorktreeProvisioningSnapshot | null;
let provisioningSnapshotLookup: ProvisioningLookup | null = null;

/** Composition-root injection (Desktop register.ts) avoids circular imports with register.ts. */
export function setSessionActivityProvisioningLookup(lookup: ProvisioningLookup | null): void {
  provisioningSnapshotLookup = lookup;
}

export interface PersistedSessionActivityFacts {
  status: SessionRecordStatus;
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  clearedAt: number | null;
}

export interface SessionActivityReaderDeps {
  getLiveSnapshot(sessionId: string): SessionActivitySnapshot | null;
  getProvisioningSnapshot?(sessionId: string): WorktreeProvisioningSnapshot | null;
  getPersistedFacts(sessionId: string): Promise<PersistedSessionActivityFacts | null>;
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

    const provisioning = deps.getProvisioningSnapshot?.(sessionId) ?? null;
    if (provisioning) {
      const row = await deps.getPersistedFacts(sessionId);
      if (row && row.status !== 'deleted' && row.status !== 'archived') {
        const failed = provisioning.status === 'failed';
        return projectSessionActivity({
          sessionId,
          recordStatus: row.status,
          title: row.title,
          source: 'live',
          livePhase: failed ? 'error' : 'provisioning',
          terminal: failed ? 'error' : null,
          startedAtMs: provisioning.startedAt,
          lastActivityAtMs: provisioning.startedAt,
          currentActionSummary: failed
            ? 'Worktree 创建失败'
            : provisioning.stage === 'queued'
              ? '排队等待创建 worktree'
              : '正在创建 worktree',
          attention: failed,
        });
      }
    }

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
): Promise<PersistedSessionActivityFacts | null> {
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
  getProvisioningSnapshot: (sessionId) => provisioningSnapshotLookup?.(sessionId) ?? null,
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
export function createCanonicalSessionActivityBatchReader(
  persisted: ReadonlyMap<string, PersistedSessionActivityFacts>,
) {
  const live = new Map(
    (getAgentIslandService()?.getSessionActivitySnapshots() ?? []).map((item) => [item.sessionId, item]),
  );
  return createSessionActivityReader({
    getLiveSnapshot: (sessionId) => live.get(sessionId) ?? null,
    getProvisioningSnapshot: (sessionId) => provisioningSnapshotLookup?.(sessionId) ?? null,
    getPersistedFacts: async (sessionId) => persisted.get(sessionId) ?? null,
    getLatestTerminal: readLatestSessionTerminal,
  });
}
