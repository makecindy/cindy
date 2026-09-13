/**
 * mcp-integrations/sessionOperations.ts —— cindy_helper control 类「会话操作」工具的 host 业务体。
 *
 * 对应 GUI 会话菜单的移动到项目/对话、置顶、删除、导出分享包、在新窗口打开、分叉与
 * 分支家族。所有写操作都走主进程既有路径(`updateSessionInDb` = sessions:update 业务体,
 * session-share 导出编排,maker-orchestration/fork),不另起绕过广播与副作用的写入链路。
 *
 * GUI 侧的守卫(远程会话不支持、运行中拦截、IM 接管中拦截、空草稿 / 已归档不出入口)
 * 在这里逐条复现;批量操作先对全部 id 校验,任一不过整批不写。
 *
 * 依赖全部注入(Electron / maker / im 均不直接 import),便于单测直接驱动业务体
 * (docs/dev-rules/engineering-conventions.md §3)。
 */

import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import type {
  DeleteSessionPreviewItem,
  DeleteSessionsResult,
  ExportSessionResult,
  ForkSessionResult,
  GetSessionBranchesResult,
  MoveSessionsResult,
  OpenSessionInNewWindowResult,
  SessionBranchItem,
  SessionMoveTarget,
  SessionOpErrorCode,
  SessionOpItem,
  SetSessionsPinnedResult,
} from '@cindy/mcps';

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

export interface SessionShareExportOutcomeLike {
  status: 'ok' | 'oversize';
  filePath?: string;
  fidelity?: string;
  missingTranscripts?: string[];
  mediaMissing?: number;
  orcaWorkers?: number;
  totalBytes?: number;
  mediaBytes?: number;
  limitBytes?: number;
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
  worktreeRemovalPreview(sessionId: string): Promise<{ hasWorktree: boolean; dirty: boolean }>;
  exportShare(opts: {
    sessionId: string;
    targetPath: string;
    password: string | null;
    excludeMedia: boolean;
  }): Promise<SessionShareExportOutcomeLike>;
  openInNewWindow(sessionId: string): void;
  resolveMessageClientId(sessionId: string, messageId: string): Promise<string | null>;
  forkAtMessage(sessionId: string, messageClientId: string): Promise<{ id: string }>;
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
  const workers = await deps.listWorkerSessionIds(row.id).catch(() => []);
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

export async function setSessionsPinned(
  deps: SessionOperationsDeps,
  params: { sessionIds: string[]; pinned: boolean },
): Promise<SetSessionsPinnedResult> {
  const loaded = await loadAll(deps, params.sessionIds);
  if (!Array.isArray(loaded)) return loaded;
  for (const row of loaded) {
    if (row.remoteHostId) return err('PRECONDITION_FAILED', `${row.id}: 远程(SSH)会话不支持置顶`);
    if (row.status !== 'active') {
      return err('PRECONDITION_FAILED', `${row.id}: 会话已${row.status === 'deleted' ? '删除' : '归档'},不能置顶`);
    }
  }
  const changed: SessionOpItem[] = [];
  for (const row of loaded) {
    try {
      await deps.updateSession(row.id, {
        pinnedAt: params.pinned ? new Date().toISOString() : null,
      });
      changed.push(toItem(row));
    } catch (e) {
      const mapped = mapIpcError(e);
      return { ...err('INTERNAL', `${row.id}: ${mapped.message}`), changed } as SetSessionsPinnedResult;
    }
  }
  return { ok: true, changed };
}

export async function deleteSessions(
  deps: SessionOperationsDeps,
  params: { sessionIds: string[]; dryRun: boolean },
): Promise<DeleteSessionsResult> {
  const loaded = await loadAll(deps, params.sessionIds);
  if (!Array.isArray(loaded)) return loaded;
  for (const row of loaded) {
    const reason = await mutationGuard(deps, row);
    if (reason) return err('PRECONDITION_FAILED', `${row.id}: ${reason}`);
  }
  const previews: DeleteSessionPreviewItem[] = [];
  for (const row of loaded) {
    const preview = await deps.worktreeRemovalPreview(row.id).catch(() => ({
      hasWorktree: false,
      dirty: false,
    }));
    previews.push({ ...toItem(row), dirtyWorktree: preview.hasWorktree && preview.dirty });
  }
  if (params.dryRun) return { ok: true, items: previews };
  const items: DeleteSessionPreviewItem[] = [];
  for (const preview of previews) {
    try {
      await deps.updateSession(preview.sessionId, { status: 'deleted' });
      items.push({ ...preview, status: 'deleted' });
    } catch (e) {
      const mapped = mapIpcError(e);
      return {
        ...err('INTERNAL', `${preview.sessionId}: ${mapped.message}`),
        items,
      } as DeleteSessionsResult;
    }
  }
  return { ok: true, items };
}

export async function exportSession(
  deps: SessionOperationsDeps,
  params: { sessionId: string; targetPath: string; password: string | null; excludeMedia: boolean },
  shareFileExt: string,
): Promise<ExportSessionResult> {
  const targetPath = params.targetPath.endsWith(shareFileExt)
    ? params.targetPath
    : `${params.targetPath}${shareFileExt}`;
  const parent = targetPath.slice(0, Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\')));
  if (!parent || !(await deps.isDirectory(parent))) {
    return err('INVALID_ARGS', `target_path 所在目录不存在: ${parent || params.targetPath}`);
  }
  let outcome: SessionShareExportOutcomeLike;
  try {
    outcome = await deps.exportShare({ ...params, targetPath });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : String(e);
    if (code === 'NOT_FOUND' || code === 'PRECONDITION_FAILED') return err(code, message);
    return err('INTERNAL', message);
  }
  if (outcome.status === 'oversize') {
    return {
      ...err('OVERSIZE', '分享包体积超过上限,可用 exclude_media=true 只导出文本与转录重试'),
      data: {
        total_bytes: outcome.totalBytes,
        media_bytes: outcome.mediaBytes,
        limit_bytes: outcome.limitBytes,
      },
    };
  }
  return {
    ok: true,
    filePath: outcome.filePath ?? targetPath,
    fidelity: outcome.fidelity ?? 'unknown',
    missingTranscripts: outcome.missingTranscripts ?? [],
    mediaMissing: outcome.mediaMissing ?? 0,
    orcaWorkers: outcome.orcaWorkers ?? 0,
  };
}

export async function openSessionInNewWindow(
  deps: SessionOperationsDeps,
  params: { sessionId: string },
): Promise<OpenSessionInNewWindowResult> {
  const loaded = await loadAll(deps, [params.sessionId]);
  if (!Array.isArray(loaded)) return loaded;
  const [row] = loaded;
  if (row.status === 'deleted') return err('PRECONDITION_FAILED', `${row.id}: 会话已删除`);
  try {
    deps.openInNewWindow(row.id);
  } catch (e) {
    return err('INTERNAL', e instanceof Error ? e.message : String(e));
  }
  return { ok: true, sessionId: row.id, title: row.title };
}

export async function forkSession(
  deps: SessionOperationsDeps,
  params: { sessionId: string; messageId: string },
): Promise<ForkSessionResult> {
  const loaded = await loadAll(deps, [params.sessionId]);
  if (!Array.isArray(loaded)) return loaded;
  const [row] = loaded;
  if (row.status === 'deleted') return err('PRECONDITION_FAILED', `${row.id}: 会话已删除`);
  if (row.remoteHostId) return err('PRECONDITION_FAILED', `${row.id}: 远程会话不支持在本地 fork`);
  const clientId = await deps.resolveMessageClientId(row.id, params.messageId);
  if (!clientId) return err('NOT_FOUND', `消息 ${params.messageId} 不存在于 ${row.id}`);
  let forkedId: string;
  try {
    forkedId = (await deps.forkAtMessage(row.id, clientId)).id;
  } catch (e) {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : String(e);
    switch (code) {
      case 'SOURCE_NOT_FOUND':
      case 'MESSAGE_NOT_FOUND':
        return err('NOT_FOUND', message);
      case 'NOT_USER_MESSAGE':
        return err('INVALID_ARGS', message);
      case 'SOURCE_NEVER_RAN':
      case 'NO_PRIOR_ASSISTANT':
      case 'REMOTE_NOT_SUPPORTED':
      case 'CODEX_FORK_STATE_UNAVAILABLE':
        return err('PRECONDITION_FAILED', message);
      case 'UNSUPPORTED_HISTORY':
        return err('UNSUPPORTED_CAPABILITY', message);
      default:
        return err('INTERNAL', message);
    }
  }
  const [forked] = await deps.loadSessions([forkedId]);
  return {
    ok: true,
    session: forked
      ? toItem(forked)
      : { sessionId: forkedId, title: null, workingDir: row.workingDir, workspaceKind: row.workspaceKind, status: 'active' },
  };
}

export async function getSessionBranches(
  deps: SessionOperationsDeps,
  params: { sessionId: string },
): Promise<GetSessionBranchesResult> {
  const loaded = await loadAll(deps, [params.sessionId]);
  if (!Array.isArray(loaded)) return loaded;
  // 向上找根(源被删时 parentSessionId 已 SET NULL,链在此断开即视为根)。
  let root = loaded[0];
  const seen = new Set<string>([root.id]);
  while (root.parentSessionId && !seen.has(root.parentSessionId)) {
    const [parent] = await deps.loadSessions([root.parentSessionId]);
    if (!parent) break;
    seen.add(parent.id);
    root = parent;
  }
  // 向下 BFS 收集全部派生会话。
  const family: SessionOpsRow[] = [root];
  let frontier = [root.id];
  const visited = new Set<string>([root.id]);
  while (frontier.length > 0) {
    const children = (await deps.loadChildren(frontier)).filter((row) => !visited.has(row.id));
    for (const child of children) visited.add(child.id);
    family.push(...children);
    frontier = children.map((row) => row.id);
  }
  const items: SessionBranchItem[] = family.map((row) => ({
    ...toItem(row),
    parentSessionId: row.parentSessionId,
    forkedAtMessageId: row.forkedAtMessageId,
    createdAt: row.createdAt,
  }));
  return { ok: true, rootSessionId: root.id, family: items };
}
