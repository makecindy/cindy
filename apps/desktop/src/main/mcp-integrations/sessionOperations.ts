/**
 * mcp-integrations/sessionOperations.ts —— cindy_helper control 类「会话操作」工具的 host 业务体。
 *
 * 对应 GUI 会话菜单的移动到项目/对话。写操作复用 updateSessionInDb,保留广播与副作用。
 *
 * GUI 侧的守卫(远程会话不支持、运行中拦截、IM 接管中拦截、空草稿 / 已归档不出入口)
 * 在这里逐条复现;批量操作先对全部 id 校验,任一不过整批不写。
 *
 * 依赖全部注入(Electron / maker / im 均不直接 import),便于单测直接驱动业务体
 * (docs/dev-rules/engineering-conventions.md §3)。
 */

import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import type { MoveSessionsResult, SessionMoveTarget, SessionOpErrorCode, SessionOpItem } from '@cindy/mcps';

import { isIpcError } from '../../shared/ipc-errors.js';

export interface SessionOpsRow {
  id: string;
  title: string | null;
  workingDir: string | null;
  workspaceKind: 'project' | 'dialogue';
  status: 'active' | 'archived' | 'deleted';
  source: string | null;
  remoteHostId: string | null;
  orcaRole: 'lead' | 'worker' | null;
  parentSessionId: string | null;
  forkedAtMessageId: string | null;
  createdAt: number;
  messageCount: number;
}

export interface SessionOperationsDeps {
  /** 按 id 读会话行(任意 status);缺失的 id 不出现在结果里。 */
  loadSessions(ids: string[]): Promise<SessionOpsRow[]>;
  /** 读 parentSessionId ∈ ids 的直接子会话(分支家族遍历用)。 */
  loadChildren(parentIds: string[]): Promise<SessionOpsRow[]>;
  /** Orca lead 下的 worker 会话 id。 */
  listWorkerSessionIds(leadSessionId: string): Promise<string[]>;
  isTurnRunning(sessionId: string): boolean;
  isImAttached(sessionId: string): boolean;
  isDirectory(path: string): Promise<boolean>;
  /** sessions:update 业务体(updateSessionInDb)。 */
  updateSession(sessionId: string, patch: Record<string, unknown>): Promise<unknown>;

}

type Err<E extends string> = { ok: false; errorCode: E; message: string };

function err<E extends string>(errorCode: E, message: string): Err<E> {
  return { ok: false, errorCode, message };
}

function toItem(row: SessionOpsRow): SessionOpItem {
  return {
    sessionId: row.id,
    title: row.title,
    workingDir: row.workingDir,
    workspaceKind: row.workspaceKind,
    status: row.status,
  };
}

function mapIpcError(e: unknown): Err<SessionOpErrorCode> {
  const message = e instanceof Error ? e.message : String(e);
  if (isIpcError(e)) {
    if (e.code === 'NOT_FOUND' || e.code === 'PRECONDITION_FAILED') return err(e.code, message);
    if (e.code === 'UNSUPPORTED_CAPABILITY') return err('PRECONDITION_FAILED', message);
    if (e.code === 'INVALID_PARAMS') return err('INVALID_ARGS', message);
  }
  return err('INTERNAL', message);
}

/** 读全部目标行;任一缺失即 NOT_FOUND(device-link 镜像会话不在本地库,同样落这里)。 */
async function loadAll(
  deps: SessionOperationsDeps,
  ids: string[],
): Promise<SessionOpsRow[] | Err<'NOT_FOUND'>> {
  const rows = await deps.loadSessions(ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return err('NOT_FOUND', `session 不存在(或是远程设备上的会话): ${missing.join(', ')}`);
  }
  return ids.map((id) => byId.get(id) as SessionOpsRow);
}

/** 会话本身或(lead 时)任一 worker 正在跑 turn —— 与 sidebar effectiveRunningSessionIds 口径一致。 */
async function isRunning(deps: SessionOperationsDeps, row: SessionOpsRow): Promise<boolean> {
  if (deps.isTurnRunning(row.id)) return true;
  if (row.orcaRole !== 'lead') return false;
  const workers = await deps.listWorkerSessionIds(row.id);
  return workers.some((id) => deps.isTurnRunning(id));
}

/**
 * GUI 移动 / 删除共用的前置守卫。返回 null 表示放行,否则是给模型看的原因。
 * 远程会话与 IM 接管的判断与 CCAgentSidebarUpper.handleMoveSession 同款。
 */
async function mutationGuard(
  deps: SessionOperationsDeps,
  row: SessionOpsRow,
): Promise<string | null> {
  if (row.remoteHostId) return '远程(SSH)会话不支持此操作';
  if (row.status === 'deleted') return '会话已删除';
  if (await isRunning(deps, row)) return '会话正在运行中(含协同 worker),请等它结束';
  if (deps.isImAttached(row.id)) return '会话正被 IM 接管中';
  return null;
}

export async function moveSessions(
  deps: SessionOperationsDeps,
  params: { sessionIds: string[]; target: SessionMoveTarget },
): Promise<MoveSessionsResult> {
  if (params.target.kind === 'project') {
    if (!(await deps.isDirectory(params.target.workingDir))) {
      return err('INVALID_ARGS', `working_dir 不是已存在的目录: ${params.target.workingDir}`);
    }
  }
  const loaded = await loadAll(deps, params.sessionIds);
  if (!Array.isArray(loaded)) return loaded;
  for (const row of loaded) {
    const reason =
      (await mutationGuard(deps, row)) ??
      (row.status === 'archived'
        ? '已归档的会话不能移动,请先 unarchive_sessions'
        : row.source === 'review'
          ? 'review 会话的工作区固定跟随源任务,不能移动'
          : isDefaultDraftSessionTitle(row.title) && row.messageCount === 0
            ? '空草稿会话没有可移动的内容'
            : null);
    if (reason) return err('PRECONDITION_FAILED', `${row.id}: ${reason}`);
  }
  const patch =
    params.target.kind === 'dialogue'
      ? { workspaceKind: 'dialogue' as const }
      : { workingDir: params.target.workingDir, workspaceKind: 'project' as const };
  const moved: SessionOpItem[] = [];
  for (const row of loaded) {
    if (await isRunning(deps, row)) {
      return err('PRECONDITION_FAILED', `${row.id}: 会话在移动前重新进入运行中`);
    }
    try {
      const updated = (await deps.updateSession(row.id, { ...patch })) as Partial<SessionOpsRow>;
      moved.push(
        toItem({
          ...row,
          workingDir: updated.workingDir ?? row.workingDir,
          workspaceKind: updated.workspaceKind ?? patch.workspaceKind,
        }),
      );
    } catch (e) {
      const mapped = mapIpcError(e);
      return { ...err('INTERNAL', `${row.id}: ${mapped.message}`), moved } as MoveSessionsResult;
    }
  }
  return { ok: true, moved };
}
