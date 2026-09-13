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
import { isAbsolute } from 'node:path';
import type {
  ForkSessionResult,
  MoveSessionsResult,
  SessionMoveTarget,
  SessionOpErrorCode,
  SessionOpItem,
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
  /**
   * sessions:update 业务体(updateSessionInDb)。`beforeWrite` 在会话路由锁内、写库前执行,
   * 返回非空字符串即以 PRECONDITION_FAILED 拒绝本次写入。
   */
  updateSession(
    sessionId: string,
    patch: Record<string, unknown>,
    hooks?: { beforeWrite?: () => Promise<string | null> },
  ): Promise<unknown>;
  /** history 消息 id → fork 所需的 messages.clientId 及该消息的角色与文本;不存在返回 null。 */
  resolveMessageClientId(
    sessionId: string,
    messageId: string,
  ): Promise<{ clientId: string; role: string; text: string } | null>;
  /** maker-orchestration/fork 的 forkSessionAtMessage + 新会话广播。 */
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
async function lateGuard(
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

export async function moveSessions(
  deps: SessionOperationsDeps,
  params: { sessionIds: string[]; target: SessionMoveTarget },
): Promise<MoveSessionsResult> {
  if (params.target.kind === 'project') {
    if (!isAbsolute(params.target.workingDir)) {
      return err('INVALID_ARGS', `working_dir 必须是绝对路径: ${params.target.workingDir}`);
    }
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
      // 运行中 / IM 接管 / 终态的复核放在 updateSessionInDb 的路由锁内(beforeWrite),
      // 与写入同一串行区间;host 侧还把整次更新放进 IM binding 的串行队列,复核与写库
      // 之间不会有新的接管落地。Pi/Codex 另有 closeIdleSessionForMove 在锁内二次拦截。
      const updated = (await deps.updateSession(row.id, { ...patch }, {
        beforeWrite: () => lateGuard(deps, row.id, { allowArchived: false }),
      })) as Partial<SessionOpsRow>;
      moved.push(
        toItem({
          ...row,
          workingDir: updated.workingDir ?? row.workingDir,
          workspaceKind: updated.workspaceKind ?? patch.workspaceKind,
        }),
      );
    } catch (e) {
      // 保留映射后的业务错误码(NOT_FOUND / PRECONDITION_FAILED / INVALID_ARGS),
      // 只有未知异常才是 INTERNAL;已完成的 moved 一并带回。
      const mapped = mapIpcError(e);
      return { ...mapped, message: `${row.id}: ${mapped.message}`, moved } as MoveSessionsResult;
    }
  }
  return { ok: true, moved };
}

/**
 * 在某条消息处分叉出新会话(GUI Fork 同款):remote / deleted 拒绝,消息 id 先换算成
 * clientId,fork 编排层的错误码按工具契约映射。
 */
export async function forkSession(
  deps: SessionOperationsDeps,
  params: { sessionId: string; messageId: string },
): Promise<ForkSessionResult> {
  const loaded = await loadAll(deps, [params.sessionId]);
  if (!Array.isArray(loaded)) return loaded;
  const [row] = loaded;
  if (row.status === 'deleted') return err('PRECONDITION_FAILED', `${row.id}: 会话已删除`);
  if (row.remoteHostId) return err('PRECONDITION_FAILED', `${row.id}: 远程会话不支持在本地 fork`);
  const target = await deps.resolveMessageClientId(row.id, params.messageId);
  if (!target) return err('NOT_FOUND', `消息 ${params.messageId} 不存在于 ${row.id}`);
  let forkedId: string;
  try {
    forkedId = (await deps.forkAtMessage(row.id, target.clientId)).id;
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
      : {
          sessionId: forkedId,
          title: null,
          workingDir: row.workingDir,
          workspaceKind: row.workspaceKind,
          status: 'active',
        },
    // 在 user 消息上分叉时 fork 只复制该消息之前的历史;GUI 会把这条消息放进新会话的作曲器,
    // MCP 路径没有作曲器,把正文随结果返回,由调用方决定是否作为新会话的首条消息发送。
    ...(target.role === 'user' && target.text ? { draftText: target.text } : {}),
  };
}
