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
  GetSessionBranchesResult,
  OpenSessionInNewWindowResult,
  SessionBranchItem,
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
  /** secondary-windows.openSessionInNewWindow(本机桌面端窗口)。 */
  openInNewWindow(sessionId: string): void;
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
