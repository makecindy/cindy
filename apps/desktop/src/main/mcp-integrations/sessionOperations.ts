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
  ExportSessionResult,
  ForkSessionResult,
  GetSessionBranchesResult,
  OpenSessionInNewWindowResult,
  SessionBranchItem,
  SessionOpErrorCode,
  SessionOpItem,
  SetSessionsPinnedResult,
} from '@cindy/mcps';
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { dirname, isAbsolute } from 'node:path';

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
  pinnedAt: number | null;
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
    hooks?: { beforeWrite?: () => Promise<string | null>; skipIfPinnedUnchanged?: boolean },
  ): Promise<unknown>;
  /** WorktreeManager.getRemovalPreview:托管 worktree 是否存在、是否有未提交改动。 */
  worktreeRemovalPreview(sessionId: string): Promise<{ hasWorktree: boolean; dirty: boolean }>;
  /** 已存在的目录返回其真实路径(解 symlink),否则 null。 */
  resolveDirectory(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  /** session-share 导出编排(exportSessionShare);remote / worker / deleted 由其内部抛带 code 的错误。 */
  exportShare(opts: {
    sessionId: string;
    targetPath: string;
    excludeMedia: boolean;
  }): Promise<SessionShareExportOutcomeLike>;
  /** secondary-windows.openSessionInNewWindow(本机桌面端窗口)。 */
  openInNewWindow(sessionId: string): void;
  /**
   * 在该会话的路由锁内执行 task。fork 用它把「复核源会话未被删除」与 forkAtMessage
   * 放进同一串行区间 —— forkSessionAtMessage 自身不取任何锁,且只校验源行存在
   * (软删除会保留行),不这样做会从已删除任务派生出 active 子任务。
   */
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  /** history 消息 id → fork 所需的 messages.clientId 及该消息的角色与文本;不存在返回 null。 */
  resolveMessageClientId(
    sessionId: string,
    messageId: string,
  ): Promise<{ clientId: string; role: string; text: string; rewound?: boolean } | null>;
  /** maker-orchestration/fork 的 forkSessionAtMessage + 新会话广播。 */
  forkAtMessage(sessionId: string, messageClientId: string): Promise<{ id: string }>;
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
  options: { allowArchived: boolean; checkRuntime?: boolean },
): Promise<string | null> {
  const [fresh] = await deps.loadSessions([sessionId]);
  if (!fresh) return '会话已不存在';
  if (fresh.status === 'deleted') return '会话已在此期间被删除';
  if (!options.allowArchived && fresh.status === 'archived') return '会话已在此期间被归档';
  if (options.checkRuntime !== false && (await isRunning(deps, fresh))) return '会话在写入前重新进入运行中';
  if (options.checkRuntime !== false && deps.isImAttached(fresh.id)) return '会话在写入前被 IM 接管';
  return null;
}

export async function setSessionsPinned(
  deps: SessionOperationsDeps,
  params: { sessionIds: string[]; pinned: boolean },
): Promise<SetSessionsPinnedResult> {
  const loaded = await loadAll(deps, params.sessionIds);
  if (!Array.isArray(loaded)) return loaded;
  // 置顶只写本地 pinnedAt 元数据,SSH 远程会话在 GUI 同样可置顶(patchMeta),这里不拦。
  // 伙伴(Bot)会话与 Orca worker 不在侧栏置顶区展示,拒绝以免写入无人可见的状态。
  for (const row of loaded) {
    if (row.status !== 'active') return err('PRECONDITION_FAILED', `${row.id}: 会话已归档或删除,不能置顶`);
    if (row.source === 'bot') return err('PRECONDITION_FAILED', `${row.id}: 伙伴(Bot)会话不能置顶`);
    if (row.orcaRole === 'worker') return err('PRECONDITION_FAILED', `${row.id}: 协同 worker 会话不能置顶`);
  }
  const changed: SessionOpItem[] = [];
  for (const row of loaded) {
    try {
      // 终态在路由锁内复核;幂等跳过由 SQL 条件写原子判定,覆盖未共用此锁的窗口写入。
      // 锁外预读的 pinnedAt 可能已被另一窗口改变,不能据此决定跳过。
      const updated = await deps.updateSession(row.id, { pinnedAt: params.pinned ? new Date().toISOString() : null }, {
        beforeWrite: () => lateGuard(deps, row.id, { allowArchived: false, checkRuntime: false }),
        skipIfPinnedUnchanged: true,
      });
      if (updated !== false) changed.push(toItem(row));
    } catch (e) {
      // 保留映射后的业务错误码,只有未知异常才是 INTERNAL;已完成的 changed 一并带回。
      const mapped = mapIpcError(e);
      return { ...mapped, message: `${row.id}: ${mapped.message}`, changed } as SetSessionsPinnedResult;
    }
  }
  return { ok: true, changed };
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
        beforeWrite: async () => {
          const reason = await lateGuard(deps, preview.sessionId, { allowArchived: true });
          if (reason) return reason;
          let current: { hasWorktree: boolean; dirty: boolean };
          try {
            current = await deps.worktreeRemovalPreview(preview.sessionId);
          } catch {
            return '无法复核 worktree 状态,请重新 dry_run 并向用户确认';
          }
          if ((current.hasWorktree && current.dirty) !== preview.dirtyWorktree)
            return 'worktree 状态自预览后已变化,请重新 dry_run 并向用户确认';
          return null;
        },
      });
      items.push({ ...preview, status: 'deleted' });
    } catch (e) {
      const mapped = mapIpcError(e);
      return { ...mapped, message: `${preview.sessionId}: ${mapped.message}`, items } as DeleteSessionsResult;
    }
  }
  return { ok: true, items };
}

/**
 * 导出 .cshare 分享包(GUI「导出分享包」同款,但目标路径由调用方给出):必须是绝对路径,
 * 扩展名不符自动补全,父目录须存在,目标文件已存在时拒绝(不覆盖);不加密(密码只经
 * GUI 收集,不进 agent 工具入参)。超限映射为 OVERSIZE 并附体积数据,编排层的 coded error 原样映射。
 */
export async function exportSession(
  deps: SessionOperationsDeps,
  params: { sessionId: string; targetPath: string; excludeMedia: boolean },
  shareFileExt: string,
): Promise<ExportSessionResult> {
  if (!isAbsolute(params.targetPath)) {
    return err('INVALID_ARGS', `target_path 必须是绝对路径: ${params.targetPath}`);
  }
  const targetPath = params.targetPath.endsWith(shareFileExt)
    ? params.targetPath
    : `${params.targetPath}${shareFileExt}`;
  const parent = dirname(targetPath);
  // 导出只要求父目录存在;这里不像 move 那样校验软链身份 —— 写出的是一个新文件,
  // 不会成为日后会话的受信工作区。
  if (!(await deps.resolveDirectory(parent))) {
    return err('INVALID_ARGS', `target_path 所在目录不存在: ${parent}`);
  }
  if (await deps.fileExists(targetPath)) {
    return err('PRECONDITION_FAILED', `目标文件已存在,不覆盖: ${targetPath}`);
  }
  let outcome: SessionShareExportOutcomeLike;
  try {
    outcome = await deps.exportShare({ sessionId: params.sessionId, targetPath, excludeMedia: params.excludeMedia });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : String(e);
    if (code === 'NOT_FOUND' || code === 'PRECONDITION_FAILED') return err(code, message);
    if (code === 'EEXIST') return err('PRECONDITION_FAILED', `目标文件已存在,不覆盖: ${targetPath}`);
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

/** 在新的应用窗口里打开会话(GUI「在新窗口打开」同款);已删除拒绝。 */
export async function openSessionInNewWindow(
  deps: SessionOperationsDeps,
  params: { sessionId: string },
): Promise<OpenSessionInNewWindowResult> {
  const loaded = await loadAll(deps, [params.sessionId]);
  if (!Array.isArray(loaded)) return loaded;
  const [row] = loaded;
  if (row.status === 'deleted') return err('PRECONDITION_FAILED', `${row.id}: 会话已删除`);
  // 伙伴(Bot)会话必须走 /bots/ 或伙伴历史路由(botRouteForOwnedSession);副窗的
  // SecondaryWindowBootGate 只经 resolveSessionRoute 解析 Orca 身份,不认伙伴身份,
  // 放行会把隐藏的伙伴任务开成缺少伙伴身份与门禁的普通任务界面。
  if (row.source === 'bot') {
    return err('PRECONDITION_FAILED', `${row.id}: 伙伴(Bot)会话要从伙伴页面打开,不能开成普通任务窗口`);
  }
  try {
    deps.openInNewWindow(row.id);
  } catch (e) {
    return err('INTERNAL', e instanceof Error ? e.message : String(e));
  }
  return { ok: true, sessionId: row.id, title: row.title };
}

/** 会话分叉家族:沿 parentSessionId 向上找根(链断即根),再 BFS 收集全部未删除的派生会话。 */
/**
 * 分支家族只收侧栏可见的会话 —— GUI 的 SessionBranchTreeDialog 拿到的就是侧栏列表,
 * 伙伴(Bot)会话与 Orca worker 不在其中,所以那里从来不会把它们画成分支。
 *
 * 判据**不能**用 `forkedAtMessageId != null`:`maker-orchestration/fork.ts` 的
 * forkSessionStripEncrypted 会写 parentSessionId 但把 forkedAtMessageId 留空,
 * 那是合法分支;而 botDelegationService 给委派子会话写的 parentSessionId
 * (见 botDelegationService.ts:806)对应的会话 source 是 'bot'。
 */
function isBranchVisible(row: SessionOpsRow): boolean {
  return row.source !== 'bot' && row.orcaRole !== 'worker';
}

export async function getSessionBranches(
  deps: SessionOperationsDeps,
  params: { sessionId: string },
): Promise<GetSessionBranchesResult> {
  const loaded = await loadAll(deps, [params.sessionId]);
  if (!Array.isArray(loaded)) return loaded;
  if (loaded[0].status === 'deleted') return err('PRECONDITION_FAILED', `${loaded[0].id}: 会话已删除`);
  // 入口也要过同一把可见性判据:不然传入伙伴 / worker 会话时,有可见祖先的会被下面的 BFS
  // 过滤掉(成功结果里反而没有请求的那个 id),没有可见父节点的又会自己当根混进家族。
  if (!isBranchVisible(loaded[0])) {
    return err('PRECONDITION_FAILED', `${loaded[0].id}: 伙伴(Bot)会话与协同 worker 不在分叉家族中`);
  }
  // 向上找根(源被删时 parentSessionId 已 SET NULL,链在此断开即视为根)。
  let root = loaded[0];
  const seen = new Set<string>([root.id]);
  while (root.parentSessionId && !seen.has(root.parentSessionId)) {
    const [parent] = await deps.loadSessions([root.parentSessionId]);
    // 源会话已软删除、或父节点是侧栏不可见的会话时链在此断开:GUI 分支树同样不展示。
    if (!parent || parent.status === 'deleted' || !isBranchVisible(parent)) break;
    seen.add(parent.id);
    root = parent;
  }
  // 向下 BFS 收集全部派生会话。
  const family: SessionOpsRow[] = [root];
  let frontier = [root.id];
  const visited = new Set<string>([root.id]);
  while (frontier.length > 0) {
    // 软删除、以及侧栏不可见的会话(伙伴会话 / Orca worker)及其后代整体不进家族。
    const children = (await deps.loadChildren(frontier)).filter(
      (row) => !visited.has(row.id) && row.status !== 'deleted' && isBranchVisible(row),
    );
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

/**
 * 在某条消息处分叉出新会话(GUI Fork 同款):remote / deleted 拒绝,消息 id 先换算成
 * clientId,fork 编排层的错误码按工具契约映射。
 */
export async function forkSession(
  deps: SessionOperationsDeps,
  params: { callerSessionId?: string; sessionId: string; messageId: string },
): Promise<ForkSessionResult> {
  // An IM send may hold the caller's route lock until its tool call returns.
  // Reacquiring it for the same source would deadlock that turn.
  if (params.callerSessionId === params.sessionId)
    return err('PRECONDITION_FAILED', '当前运行中的任务不能分叉自身;请从其他任务发起');
  const loaded = await loadAll(deps, [params.sessionId]);
  if (!Array.isArray(loaded)) return loaded;
  const [row] = loaded;
  if (row.status === 'deleted') return err('PRECONDITION_FAILED', `${row.id}: 会话已删除`);
  if (row.remoteHostId) return err('PRECONDITION_FAILED', `${row.id}: 远程会话不支持在本地 fork`);
  return deps.withSessionLock(row.id, async () => {
    // 锁内重新确认源会话仍未被删除:软删除保留行与消息,forkSessionAtMessage 只查
    // "行是否存在",单靠上面的预检会从已删除任务派生出 active 子任务。
    const [fresh] = await deps.loadSessions([row.id]);
    if (!fresh) return err('NOT_FOUND', `${row.id}: 会话已不存在`);
    if (fresh.status === 'deleted') return err('PRECONDITION_FAILED', `${row.id}: 会话已在此期间被删除`);
    return forkSessionLocked(deps, fresh, params.messageId);
  });
}

async function forkSessionLocked(
  deps: SessionOperationsDeps,
  row: SessionOpsRow,
  messageId: string,
): Promise<ForkSessionResult> {
  const target = await deps.resolveMessageClientId(row.id, messageId);
  if (!target) return err('NOT_FOUND', `消息 ${messageId} 不存在于 ${row.id}`);
  // 已 Rewind 的消息不会被复制进新任务,分叉会静默锚到更早的 turn —— 明确拒绝而不是假成功。
  if (target.rewound) {
    return err('PRECONDITION_FAILED', `消息 ${messageId} 已被 Rewind,不能作为分叉点`);
  }
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
  // fork 已经建好并广播,是不可逆副作用。这次补充读取只为拿标题等展示字段,
  // 失败(瞬时 DB 错误 / owner 切换)不能让整个调用变成 INTERNAL —— 调用方会据此重试,
  // 再建一条重复任务。读不到就退回下面已有的兜底投影。
  const [forked] = await deps.loadSessions([forkedId]).catch(() => []);
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
