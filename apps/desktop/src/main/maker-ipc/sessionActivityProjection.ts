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

export interface PersistedSessionActivityFacts {
  status: SessionRecordStatus;
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  clearedAt: number | null;
}

export interface SessionActivityReaderDeps {
  getLiveSnapshot(sessionId: string): SessionActivitySnapshot | null;
  getPersistedFacts(sessionId: string): Promise<PersistedSessionActivityFacts | null>;
  getLatestTerminal(
    sessionId: string,
    clearedAt: number | null,
  ): Promise<SessionTerminalHint | undefined>;
  /**
   * 宿主实时 turn 状态。「疑似中断」按规则还要求「会话空闲」
   * (src/main/localDb/sessionActiveTurn.ts)，所以起过的 turn 不能被当成中断。
   * 拿不到时按「没在跑」处理，保持旧的纯持久判定。
   */
  isTurnRunning?(sessionId: string): Promise<boolean> | boolean;
}

/**
 * 默认探针：maker-core 里这一轮的实时状态，与 `maker:list-active` 的 isTurnRunning 同一来源。
 * 懒加载避免模块初始化时就依赖 maker 宿主；Host 客户端模式下拿不到就按「没在跑」。
 */
async function defaultIsTurnRunning(sessionId: string): Promise<boolean> {
  try {
    const { getMaker } = await import('../maker-host/index.js');
    return getMaker().getSession(sessionId)?.isTurnRunning() === true;
  } catch {
    return false;
  }
}

/**
 * Build a canonical reader from the existing live and durable authorities.
 * This is a projection only: it never persists or owns another status copy.
 */
export function createSessionActivityReader(deps: SessionActivityReaderDeps) {
  const isTurnRunning = deps.isTurnRunning ?? defaultIsTurnRunning;
  return async (sessionId: string): Promise<SessionActivitySnapshot> => {
    const live = deps.getLiveSnapshot(sessionId);
    if (live) return live;

    const row = await deps.getPersistedFacts(sessionId);
    if (!row) return projectSessionActivity({ sessionId, source: 'fallback' });

    const [terminal, turnRunning] = await Promise.all([
      deps.getLatestTerminal(sessionId, row.clearedAt),
      isTurnRunning(sessionId),
    ]);
    const visibilityBoundary = Math.max(row.endedAt ?? 0, row.clearedAt ?? 0);
    // startedAt > endedAt 也可能是「现在正在跑的那一轮」；只有会话空闲时才是疑似中断。
    const interrupted = !turnRunning && row.startedAt !== null && row.startedAt > visibilityBoundary;
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
      running: turnRunning,
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
    getPersistedFacts: async (sessionId) => persisted.get(sessionId) ?? null,
    getLatestTerminal: readLatestSessionTerminal,
  });
}
