/**
 * mcp-integrations/sessionOperationsHost.ts —— sessionOperations 业务体的真实依赖装配。
 *
 * 把 localDb、IM binding 等 main 专属
 * 依赖收拢在这一个文件里注入给 sessionOperations.ts;运行中判断由 maker-host 注入
 * (mcp-providers 不能反向 import maker-host/index,会成环)。
 */

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { MoveSessionsResult, SessionMoveTarget } from '@cindy/mcps';

import { bindingStore } from '../im/binding.js';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { updateSessionInDb } from '../localDb/ipc/sessions.js';
import { orcaTeams, orcaWorkers, sessions } from '../localDb/schema.js';
import {
  moveSessions,
  type SessionOperationsDeps,
  type SessionOpsRow,
} from './sessionOperations.js';

const ROW_COLUMNS = {
  id: sessions.id,
  title: sessions.title,
  workingDir: sessions.workingDir,
  workspaceKind: sessions.workspaceKind,
  status: sessions.status,
  source: sessions.source,
  remoteHostId: sessions.remoteHostId,
  orcaRole: sessions.orcaRole,
  parentSessionId: sessions.parentSessionId,
  forkedAtMessageId: sessions.forkedAtMessageId,
  createdAt: sessions.createdAt,
  messageCount: sql<number>`(select count(*) from messages where messages.session_id = ${sessions.id})`,
};

function toRow(row: {
  id: string;
  title: string | null;
  workingDir: string | null;
  workspaceKind: string | null;
  status: string;
  source: string | null;
  remoteHostId: string | null;
  orcaRole: string | null;
  parentSessionId: string | null;
  forkedAtMessageId: string | null;
  createdAt: number;
  messageCount: number;
}): SessionOpsRow {
  return {
    ...row,
    workspaceKind: row.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
    status: row.status as SessionOpsRow['status'],
    orcaRole: row.orcaRole as SessionOpsRow['orcaRole'],
    messageCount: Number(row.messageCount ?? 0),
  };
}

export function createSessionOperationsDeps(
  isTurnRunning: (sessionId: string) => boolean,
): SessionOperationsDeps {
  return {
    loadSessions: async (ids) => {
      if (ids.length === 0) return [];
      const rows = await getDbClient()
        .drizzle.select(ROW_COLUMNS)
        .from(sessions)
        .where(inArray(sessions.id, ids));
      return rows.map(toRow);
    },
    loadChildren: async (parentIds) => {
      if (parentIds.length === 0) return [];
      const rows = await getDbClient()
        .drizzle.select(ROW_COLUMNS)
        .from(sessions)
        .where(inArray(sessions.parentSessionId, parentIds));
      return rows.map(toRow);
    },
    // Worker 归属记录在 orca_teams → orca_workers(sessions.parent_session_id 只表示
    // fork 派生关系,创建 worker 时不会写它),与协同面板 / effectiveRunningSessionIds 同源。
    listWorkerSessionIds: async (leadSessionId) => {
      const rows = await getDbClient()
        .drizzle.select({ id: orcaWorkers.sessionId })
        .from(orcaWorkers)
        .innerJoin(orcaTeams, eq(orcaWorkers.teamId, orcaTeams.id))
        .where(and(eq(orcaTeams.leadSessionId, leadSessionId), eq(orcaTeams.status, 'active')));
      return rows.map((row) => row.id);
    },
    isTurnRunning,
    isImAttached: (sessionId) => bindingStore.findByTarget(sessionId) !== null,
    isDirectory: async (path) => {
      if (!isAbsolute(path)) return false;
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    // 带写入前复核的更新在 IM binding 的串行队列里执行:复核里的 isImAttached 与随后的
    // 写库之间不可能再有 attach 落地(attach 的持久化 + 内存索引更新在同一队列里排在后面)。
    // 队列内不得再等待 attach / detach;updateSessionInDb 只取路由锁与状态写锁,
    // 而 IM 侧没有任何路径在持有这两把锁时等待 binding 变更,不会形成锁序环。
    updateSession: (sessionId, patch, hooks) =>
      hooks?.beforeWrite
        ? bindingStore.runExclusive(() => updateSessionInDb(sessionId, patch, undefined, hooks))
        : updateSessionInDb(sessionId, patch, undefined, hooks),
  };
}

/** cindy_helper `sessionOps` 回调组:localDb 未就绪统一返回 HOST_NOT_READY。 */
export function createSessionOpsCallbacks(isTurnRunning: (sessionId: string) => boolean) {
  const deps = createSessionOperationsDeps(isTurnRunning);
  const notReady = { ok: false as const, errorCode: 'HOST_NOT_READY' as const, message: 'localDb not ready' };
  const guarded = <T>(run: () => Promise<T>): Promise<T | typeof notReady> =>
    tryGetDbClient() ? run() : Promise.resolve(notReady);
  return {
    moveSessions: (params: { sessionIds: string[]; target: SessionMoveTarget }): Promise<MoveSessionsResult> =>
      guarded(() => moveSessions(deps, params)),

  };
}
