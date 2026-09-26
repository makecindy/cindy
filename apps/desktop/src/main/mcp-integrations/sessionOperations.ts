/**
 * mcp-integrations/sessionOperations.ts —— cindy_helper control 类「会话操作」工具共用的 host 骨架。
 *
 * 这里只放各工具共用的行加载、守卫与错误映射;具体工具(置顶 / 删除 / 导出 / 新窗口 /
 * 分叉 / 分支家族)各自的业务体由对应 PR 追加到本文件。会话「移动到项目」由 main 自带的
 * move_session 工具负责(apps/desktop/src/main/mcp-integrations/moveSession.ts),本文件不再实现。
 *
 * GUI 侧的守卫(远程会话不支持、运行中拦截、IM 接管中拦截、空草稿 / 已归档不出入口)
 * 在这里逐条复现;批量操作先对全部 id 校验,任一不过整批不写。
 *
 * 依赖全部注入(Electron / maker / im 均不直接 import),便于单测直接驱动业务体
 * (docs/dev-rules/engineering-conventions.md §3)。
 */

import type {
  DeleteSessionPreviewItem,
  DeleteSessionsResult,
  SessionOpErrorCode,
  SessionOpItem,
} from '@cindy/mcps';
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';

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
  /**
   * sessions:update 业务体(updateSessionInDb)。`beforeWrite` 在会话路由锁内、写库前执行,
   * 返回非空字符串即以 PRECONDITION_FAILED 拒绝本次写入。
   *
   * host 侧把它适配到 main 的 `moveGuard.beforeWrite`(抛错语义);这里保留
   * 「返回原因字符串」的形状,是因为各工具的复核理由要原样进 errorCode/message。
   */
  updateSession(
    sessionId: string,
    patch: Record<string, unknown>,
    hooks?: { beforeWrite?: () => Promise<string | null> },
  ): Promise<unknown>;
  /** WorktreeManager.getRemovalPreview:托管 worktree 是否存在、是否有未提交改动。 */
  worktreeRemovalPreview(sessionId: string): Promise<{ hasWorktree: boolean; dirty: boolean }>;
}

type Err<E extends string> = { ok: false; errorCode: E; message: string };

export function err<E extends string>(errorCode: E, message: string): Err<E> {
  return { ok: false, errorCode, message };
}

export function toItem(row: SessionOpsRow): SessionOpItem {
  return {
    sessionId: row.id,
    title: row.title,
    workingDir: row.workingDir,
    workspaceKind: row.workspaceKind,
    status: row.status,
  };
}

export function mapIpcError(e: unknown): Err<SessionOpErrorCode> {
  const message = e instanceof Error ? e.message : String(e);
  if (isIpcError(e)) {
    if (e.code === 'NOT_FOUND' || e.code === 'PRECONDITION_FAILED') return err(e.code, message);
    if (e.code === 'UNSUPPORTED_CAPABILITY') return err('PRECONDITION_FAILED', message);
    if (e.code === 'INVALID_PARAMS') return err('INVALID_ARGS', message);
  }
  return err('INTERNAL', message);
}

/** 读全部目标行;任一缺失即 NOT_FOUND(device-link 镜像会话不在本地库,同样落这里)。 */
export async function loadAll(
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
export async function isRunning(deps: SessionOperationsDeps, row: SessionOpsRow): Promise<boolean> {
  if (deps.isTurnRunning(row.id)) return true;
  if (row.orcaRole !== 'lead') return false;
  const workers = await deps.listWorkerSessionIds(row.id);
  return workers.some((id) => deps.isTurnRunning(id));
}

/**
 * GUI 移动 / 删除共用的前置守卫。返回 null 表示放行,否则是给模型看的原因。
 * 远程会话与 IM 接管的判断与 CCAgentSidebarUpper.handleMoveSession 同款。
 */
export async function mutationGuard(
  deps: SessionOperationsDeps,
  row: SessionOpsRow,
): Promise<string | null> {
  if (row.remoteHostId) return '远程(SSH)会话不支持此操作';
  if (row.status === 'deleted') return '会话已删除';
  // 伙伴(Bot)会话的工作区固定为其 workspace,Orca worker 的工作区继承自 lead 且不在侧栏:
  // 两者在 GUI 都没有此类入口,工具侧同样拒绝,避免改写受管会话。
  if (row.source === 'bot') return '伙伴(Bot)会话由伙伴运行时管理,不能在此操作';
  if (row.orcaRole === 'worker') return '协同 worker 会话由协同面板管理,不能在此操作';
  if (await isRunning(deps, row)) return '会话正在运行中(含协同 worker),请等它结束';
  if (deps.isImAttached(row.id)) return '会话正被 IM 接管中';
  return null;
}

/**
 * 写入前(路由锁内)复核:重读该行,任何一条 GUI 守卫不再成立即拒绝。与预检相比多了
 * "已归档 / 已删除"的终态复核 —— 预检后另一窗口归档或删除该会话时,不能把它当作已移动。
 */
export async function lateGuard(
  deps: SessionOperationsDeps,
  sessionId: string,
  options: { allowArchived: boolean },
): Promise<string | null> {
  const [fresh] = await deps.loadSessions([sessionId]);
  if (!fresh) return '会话已不存在';
  if (fresh.status === 'deleted') return '会话已在此期间被删除';
  if (!options.allowArchived && fresh.status === 'archived') return '会话已在此期间被归档';
  if (await isRunning(deps, fresh)) return '会话在写入前重新进入运行中';
  if (deps.isImAttached(fresh.id)) return '会话在写入前被 IM 接管';
  return null;
}

/** 预览失败时保守地按 dirty 处理,并标记 unknown,避免把"查不到"呈现成"干净"。 */
async function previewDelete(
  deps: SessionOperationsDeps,
  row: SessionOpsRow,
): Promise<DeleteSessionPreviewItem> {
  try {
    const preview = await deps.worktreeRemovalPreview(row.id);
    return { ...toItem(row), dirtyWorktree: preview.hasWorktree && preview.dirty, dirtyWorktreeUnknown: false };
  } catch {
    return { ...toItem(row), dirtyWorktree: true, dirtyWorktreeUnknown: true };
  }
}

/**
 * 批量软删除(GUI「删除」同款):守卫整批校验;dryRun 只返回预览;真删前把预览状态与
 * 调用方在 dry_run 时拿到的 expectedDirty 逐个比对,不一致即拒绝(用户批准的是预览时的
 * 状态);运行态 / IM 接管 / 终态复核放在 updateSessionInDb 的路由锁内(beforeWrite)。
 */
export async function deleteSessions(
  deps: SessionOperationsDeps,
  params: { sessionIds: string[]; dryRun: boolean; expectedDirty?: Record<string, boolean> },
): Promise<DeleteSessionsResult> {
  const loaded = await loadAll(deps, params.sessionIds);
  if (!Array.isArray(loaded)) return loaded;
  for (const row of loaded) {
    const reason = await mutationGuard(deps, row);
    if (reason) return err('PRECONDITION_FAILED', `${row.id}: ${reason}`);
  }
  const previews: DeleteSessionPreviewItem[] = [];
  for (const row of loaded) previews.push(await previewDelete(deps, row));
  if (params.dryRun) return { ok: true, items: previews };
  if (params.expectedDirty) {
    for (const item of previews) {
      if (params.expectedDirty[item.sessionId] !== item.dirtyWorktree) {
        return err(
          'PRECONDITION_FAILED',
          `${item.sessionId}: worktree 状态自预览后已变化,请重新 dry_run 并向用户确认`,
        );
      }
    }
  }
  const items: DeleteSessionPreviewItem[] = [];
  for (const preview of previews) {
    try {
      await deps.updateSession(preview.sessionId, { status: 'deleted' }, {
        beforeWrite: () => lateGuard(deps, preview.sessionId, { allowArchived: true }),
      });
      items.push({ ...preview, status: 'deleted' });
    } catch (e) {
      const mapped = mapIpcError(e);
      return { ...mapped, message: `${preview.sessionId}: ${mapped.message}`, items } as DeleteSessionsResult;
    }
  }
  return { ok: true, items };
}
