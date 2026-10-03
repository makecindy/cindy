/**
 * mcp-integrations/sessionOperationsHost.ts —— sessionOperations 业务体的真实依赖装配。
 *
 * 把 localDb、IM binding 等 main 专属
 * 依赖收拢在这一个文件里注入给 sessionOperations.ts;运行中判断由 maker-host 注入
 * (mcp-providers 不能反向 import maker-host/index,会成环)。
 */

import { BrowserWindow } from 'electron';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { GetSessionBranchesResult, OpenSessionInNewWindowResult } from '@cindy/mcps';

import { bindingStore } from '../im/binding.js';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { updateSessionInDb } from '../localDb/ipc/sessions.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { orcaTeams, orcaWorkers, sessions } from '../localDb/schema.js';
import { openSessionInNewWindow as openSecondaryWindow } from '../secondary-windows.js';
import {
  getSessionBranches,
  openSessionInNewWindow,
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
    // 写入前复核在 IM binding 的串行队列里执行:复核里的 isImAttached 与随后的写库之间
    // 不可能再有 attach 落地(attach 的持久化 + 内存索引更新在同一队列里排在后面)。
    // 队列内不得再等待 attach / detach;updateSessionInDb 只取路由锁与状态写锁,
    // 而 IM 侧没有任何路径在持有这两把锁时等待 binding 变更,不会形成锁序环。
    //
    // 形状适配:骨架里的 beforeWrite 返回「拒绝原因」字符串,而 updateSessionInDb 的
    // moveGuard.beforeWrite 是抛错语义(见 localDb/ipc/sessions.ts);这里把前者翻成后者。
    // assertCurrent / beforeUpdate 是 move_session 的 data-owner 与锁内复核钩子,
    // 本骨架的工具不改工作区,无需参与,给成空实现。
    updateSession: (sessionId, patch, hooks) => {
      const guard = hooks?.beforeWrite
        ? {
            assertCurrent: () => {},
            beforeUpdate: async () => {},
            beforeWrite: async () => {
              const reason = await hooks.beforeWrite!();
              if (reason) throwIpcError('PRECONDITION_FAILED', reason);
            },
          }
        : undefined;
      const run = () => updateSessionInDb(sessionId, patch, undefined, guard);
      return guard ? bindingStore.runExclusive(run) : run();
    },
    openInNewWindow: (sessionId) => {
      const anchor = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      openSecondaryWindow(sessionId, anchor);
    },
  };
}

/**
 * cindy_helper 会话操作工具各 host 回调共用的装配:注入好的依赖 + 统一的失败包装。
 *
 * `guarded` 的口径:localDb 未就绪统一返回 HOST_NOT_READY;预检阶段
 * (loadSessions / Orca 关系表查询等)抛出的异常映射为 INTERNAL,不让异常穿透到
 * MCP 层变成无结构的失败。
 *
 * 各工具在本文件末尾追加 `createX(isTurnRunning)` 工厂,并在 mcp-providers 里按
 * `XdtHelperMcpDeps` 的单工具可选回调逐个注入(与 moveSession 同款)。
 */
export function createSessionOpsGuard(isTurnRunning: (sessionId: string) => boolean) {
  const deps = createSessionOperationsDeps(isTurnRunning);
  const hostFailure = (errorCode: 'HOST_NOT_READY' | 'INTERNAL', message: string) =>
    ({ ok: false as const, errorCode, message });
  const notReady = hostFailure('HOST_NOT_READY', 'localDb not ready');
  const guarded = <T>(run: () => Promise<T>): Promise<T | ReturnType<typeof hostFailure>> =>
    tryGetDbClient()
      ? run().catch((error) =>
          hostFailure('INTERNAL', error instanceof Error ? error.message : String(error)),
        )
      : Promise.resolve(notReady);
  return { deps, guarded };
}

/** cindy_helper open_session_in_new_window 的 host 回调。 */
export function createOpenSessionInNewWindow(isTurnRunning: (sessionId: string) => boolean) {
  const { deps, guarded } = createSessionOpsGuard(isTurnRunning);
  return (params: { sessionId: string }): Promise<OpenSessionInNewWindowResult> =>
    guarded(() => openSessionInNewWindow(deps, params));
}

/** cindy_helper get_session_branches 的 host 回调。 */
export function createGetSessionBranches(isTurnRunning: (sessionId: string) => boolean) {
  const { deps, guarded } = createSessionOpsGuard(isTurnRunning);
  return (params: { sessionId: string }): Promise<GetSessionBranchesResult> =>
    guarded(() => getSessionBranches(deps, params));
}
