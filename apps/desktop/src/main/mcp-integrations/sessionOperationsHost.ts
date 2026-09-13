/**
 * mcp-integrations/sessionOperationsHost.ts —— sessionOperations 业务体的真实依赖装配。
 *
 * 把 Electron 窗口、localDb、worktree、session-share、fork、IM binding 等 main 专属
 * 依赖收拢在这一个文件里注入给 sessionOperations.ts;运行中判断由 maker-host 注入
 * (mcp-providers 不能反向 import maker-host/index,会成环)。
 */

import { stat } from 'node:fs/promises';
import { BrowserWindow } from 'electron';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type {
  DeleteSessionsResult,
  ExportSessionResult,
  ForkSessionResult,
  GetSessionBranchesResult,
  MoveSessionsResult,
  OpenSessionInNewWindowResult,
  SessionMoveTarget,
  SetSessionsPinnedResult,
} from '@cindy/mcps';

import { bindingStore } from '../im/binding.js';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { updateSessionInDb } from '../localDb/ipc/sessions.js';
import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast.js';
import { messages, sessions } from '../localDb/schema.js';
import { forkSessionAtMessage } from '../maker-orchestration/fork.js';
import { openSessionInNewWindow as openSecondaryWindow } from '../secondary-windows.js';
import { exportSessionShare } from '../session-share/sessionShareExport.js';
import { SHARE_FILE_EXT } from '../session-share/xdtshareFormat.pure.js';
import { getRemovalPreview } from '../worktree/WorktreeManager.js';
import {
  deleteSessions,
  exportSession,
  forkSession,
  getSessionBranches,
  moveSessions,
  openSessionInNewWindow,
  setSessionsPinned,
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
    listWorkerSessionIds: async (leadSessionId) => {
      const rows = await getDbClient()
        .drizzle.select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.parentSessionId, leadSessionId), eq(sessions.orcaRole, 'worker')));
      return rows.map((row) => row.id);
    },
    isTurnRunning,
    isImAttached: (sessionId) => bindingStore.findByTarget(sessionId) !== null,
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    updateSession: (sessionId, patch) => updateSessionInDb(sessionId, patch),
    worktreeRemovalPreview: (sessionId) => getRemovalPreview(sessionId),
    exportShare: (opts) => exportSessionShare(opts),
    openInNewWindow: (sessionId) => {
      const anchor = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      openSecondaryWindow(sessionId, anchor);
    },
    resolveMessageClientId: async (sessionId, messageId) => {
      const [row] = await getDbClient()
        .drizzle.select({ clientId: messages.clientId })
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
        .limit(1);
      return row?.clientId ?? null;
    },
    forkAtMessage: async (sessionId, messageClientId) => {
      const session = await forkSessionAtMessage(sessionId, messageClientId);
      emitSessionCreated(session.id);
      return { id: session.id };
    },
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
    setSessionsPinned: (params: { sessionIds: string[]; pinned: boolean }): Promise<SetSessionsPinnedResult> =>
      guarded(() => setSessionsPinned(deps, params)),
    deleteSessions: (params: { sessionIds: string[]; dryRun: boolean }): Promise<DeleteSessionsResult> =>
      guarded(() => deleteSessions(deps, params)),
    exportSession: (params: {
      sessionId: string;
      targetPath: string;
      password: string | null;
      excludeMedia: boolean;
    }): Promise<ExportSessionResult> => guarded(() => exportSession(deps, params, SHARE_FILE_EXT)),
    openSessionInNewWindow: (params: { sessionId: string }): Promise<OpenSessionInNewWindowResult> =>
      guarded(() => openSessionInNewWindow(deps, params)),
    forkSession: (params: { sessionId: string; messageId: string }): Promise<ForkSessionResult> =>
      guarded(() => forkSession(deps, params)),
    getSessionBranches: (params: { sessionId: string }): Promise<GetSessionBranchesResult> =>
      guarded(() => getSessionBranches(deps, params)),
  };
}
