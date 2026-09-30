/**
 * 伙伴工作台的权限边界与工具服务(纯逻辑,依赖全部注入,便于单测)。
 *
 * 产品裁决(2026-10-01):伙伴可以查看、继续、停止「主人明确交给它的项目」里的任务。
 * 授权来自主人在工作台里点「交给伙伴」的那一次,范围只限记在该伙伴
 * `workbench.json` 里的项目,主人随时可以移除;其它任务仍不可触达。
 *
 * 每次调用都在 main 里确定性校验:
 *  1. 调用方 session → 伙伴:只认本机、在用的伙伴主任务(canonical);
 *  2. 目标任务:存在、未删除未归档、本机、不是任何伙伴的隐藏任务(主任务、群专线、
 *     历史等 bot_session_links 行,或 source=bot)、不是后台任务(它们有自己的
 *     message/stop_session_task 合同)、是普通来源的任务,并且工作目录属于该伙伴
 *     已接手的某个项目。
 * 任一条不满足就返回明确的错误码,不做任何投递。
 */
import {
  boundWorkbenchSummary,
  countWorkbenchStates,
  deriveWorkbenchAutomationState,
  deriveWorkbenchSessionState,
  findWorkbenchProject,
  isWorkbenchTaskSource,
  workbenchStateRank,
  type WorkbenchDelegationStatus,
  type WorkbenchTaskState,
} from '../../shared/botWorkbench.js';

type Failure = { ok: false; errorCode: string; message: string };

/** 工具一次最多带回的任务数;多出来的只报总数,伙伴需要时让主人去工作台看全部。 */
export const WORKBENCH_TOOL_MAX_TASKS = 40;
export const WORKBENCH_TOOL_MAX_MESSAGE_CHARS = 4_000;

export type WorkbenchCallerResult = { ok: true; botId: string } | Failure;

/** 授权判定所需的目标任务事实,由宿主从数据库读出。 */
export interface WorkbenchTargetFacts {
  id: string;
  status: string;
  source: string | null;
  remoteHostId: string | null;
  workingDir: string | null;
  orcaRole: string | null;
  /** 该 session 在 bot_session_links 里有记录(伙伴主任务、群专线、历史等)。 */
  botLinked: boolean;
  /** 该 session 是某个伙伴后台任务(bot_delegations.child_session_id)的执行任务。 */
  delegationChild: boolean;
}

export type WorkbenchTargetDecision = { ok: true; projectDir: string } | Failure;

export function authorizeWorkbenchTarget(
  target: WorkbenchTargetFacts | null,
  projectDirs: readonly string[],
  caseInsensitive: boolean,
): WorkbenchTargetDecision {
  if (!target || target.status === 'deleted') {
    return { ok: false, errorCode: 'TASK_NOT_FOUND', message: '找不到这件任务,它可能已被删除' };
  }
  if (target.botLinked || target.source === 'bot') {
    return { ok: false, errorCode: 'TASK_NOT_ACCESSIBLE', message: '这是伙伴自己的任务,不能通过工作台操作' };
  }
  if (target.remoteHostId) {
    return { ok: false, errorCode: 'TASK_REMOTE', message: '远端任务不在工作台的范围内' };
  }
  if (target.status !== 'active') {
    return { ok: false, errorCode: 'TASK_ARCHIVED', message: '这件任务已归档,请让主人先恢复它' };
  }
  if (target.delegationChild) {
    return {
      ok: false,
      errorCode: 'TASK_IS_BACKGROUND_TASK',
      message: '这是伙伴开的后台任务,请用 message_session_task / stop_session_task',
    };
  }
  if (!isWorkbenchTaskSource(target.source) || target.orcaRole === 'worker') {
    return { ok: false, errorCode: 'TASK_NOT_SUPPORTED', message: '这类任务不在工作台的范围内' };
  }
  const projectDir = findWorkbenchProject(target.workingDir, projectDirs, caseInsensitive);
  if (!projectDir) {
    return { ok: false, errorCode: 'TASK_OUTSIDE_WORKBENCH', message: '这件任务不在主人交给你的项目里' };
  }
  return { ok: true, projectDir };
}

/** 项目里一件候选任务的原始事实(未推导状态)。 */
export interface WorkbenchTaskRow {
  id: string;
  title: string;
  workingDir: string | null;
  agentKind: string | null;
  summary: string | null;
  lastActiveAt: number | null;
}

export interface WorkbenchScheduleRow {
  id: string;
  name: string;
  status: string;
  source?: string;
  workspaceKind?: string;
  workingDir?: string | null;
  nextFireAt?: number | null;
}

export interface BotWorkbenchAccessDeps {
  resolveCaller(callerSessionId: string): Promise<WorkbenchCallerResult>;
  readProjectDirs(botId: string): Promise<string[]>;
  projectExists?(dir: string): Promise<boolean>;
  readTarget(taskId: string): Promise<WorkbenchTargetFacts | null>;
  /**
   * 已接手项目里的候选任务,按最近活动倒序;不含伙伴隐藏任务与从未发过消息的草稿。
   * `alwaysInclude` 里的任务(伙伴刚开、还在排队的后台任务)即使还没有消息也要列出。
   */
  listProjectTasks(projectDirs: readonly string[], alwaysInclude: ReadonlySet<string>): Promise<WorkbenchTaskRow[]>;
  /** 该伙伴自己的后台任务:执行任务 id → 状态。 */
  listDelegations(botId: string): Promise<Map<string, WorkbenchDelegationStatus>>;
  readActivityPhase(sessionId: string): Promise<string | null>;
  listSchedules(): Promise<WorkbenchScheduleRow[]>;
  sendToSession(params: {
    targetSessionId: string;
    message: string;
    dispatcherSessionId: string;
  }): Promise<
    | { ok: true; wakeKind: string; queuedMessageId?: string }
    | Failure
  >;
  stopSessionTurn(params: {
    targetSessionId: string;
  }): Promise<
    | { ok: true; status: 'no-active-turn' | 'waiting-for-safe-point' | 'requested' | 'unconfirmed' }
    | Failure
  >;
  caseInsensitive: boolean;
  /** 账号切换守卫:返回 false 时中止,不做任何投递。 */
  isOwnerScopeCurrent?(): boolean;
}

function projectName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

const scopeChanged: Failure = { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号已切换,请重试' };

export function createBotWorkbenchAccess(deps: BotWorkbenchAccessDeps) {
  const scopeCurrent = () => deps.isOwnerScopeCurrent?.() ?? true;

  const authorize = async (callerSessionId: string, taskId: string) => {
    const caller = await deps.resolveCaller(callerSessionId);
    if (!caller.ok) return caller;
    const [projectDirs, target] = await Promise.all([
      deps.readProjectDirs(caller.botId),
      deps.readTarget(taskId),
    ]);
    const decision = authorizeWorkbenchTarget(target, projectDirs, deps.caseInsensitive);
    if (!decision.ok) return decision;
    if (!scopeCurrent()) return scopeChanged;
    return { ok: true as const, botId: caller.botId, projectDir: decision.projectDir };
  };

  return {
    async get(params: { callerSessionId: string }) {
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      const projectDirs = await deps.readProjectDirs(caller.botId);
      const delegations = await deps.listDelegations(caller.botId);
      const [rows, schedules, exists] = await Promise.all([
        projectDirs.length
          ? deps.listProjectTasks(projectDirs, new Set(delegations.keys()))
          : Promise.resolve([]),
        projectDirs.length ? deps.listSchedules() : Promise.resolve([]),
        Promise.all(projectDirs.map((dir) => deps.projectExists?.(dir) ?? Promise.resolve(true))),
      ]);
      const owned = rows.filter((row) => findWorkbenchProject(row.workingDir, projectDirs, deps.caseInsensitive));
      const shown = owned.slice(0, WORKBENCH_TOOL_MAX_TASKS);
      const tasks = await Promise.all(
        shown.map(async (row) => {
          const delegationStatus = delegations.get(row.id) ?? null;
          const state = deriveWorkbenchSessionState({
            activityPhase: await deps.readActivityPhase(row.id),
            delegationStatus,
          });
          const project = findWorkbenchProject(row.workingDir, projectDirs, deps.caseInsensitive)!;
          return {
            id: row.id,
            title: row.title,
            project: projectName(project),
            state,
            kind: delegationStatus ? ('delegated' as const) : ('existing' as const),
            summary: boundWorkbenchSummary(row.summary),
            lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt).toISOString() : null,
            rank: workbenchStateRank(state),
          };
        }),
      );
      tasks.sort((a, b) => a.rank - b.rank);
      const automations = [
        ...schedules.flatMap((schedule) => {
          if (schedule.source === 'bot' || schedule.workspaceKind === 'dialogue') return [];
          const project = findWorkbenchProject(schedule.workingDir, projectDirs, deps.caseInsensitive);
          if (!project) return [];
          return [{
            id: schedule.id,
            name: schedule.name,
            kind: 'automation' as const,
            state: deriveWorkbenchAutomationState({ enabled: schedule.status === 'active' }),
            project: projectName(project),
            nextRunAt: schedule.nextFireAt ? new Date(schedule.nextFireAt).toISOString() : null,
            lastResult: null,
          }];
        }),
      ];
      const states: WorkbenchTaskState[] = [
        ...tasks.map((task) => task.state),
        ...automations.map((automation) => automation.state),
      ];
      if (!scopeCurrent()) return scopeChanged;
      return {
        ok: true as const,
        workbench: {
          projects: projectDirs.map((dir, index) => ({ name: projectName(dir), path: dir, exists: exists[index] ?? true })),
          tasks: tasks.map(({ rank: _rank, ...task }) => task),
          automations,
          counts: countWorkbenchStates(states),
          truncated: owned.length > shown.length,
          totalTasks: owned.length,
        },
      };
    },

    async continueTask(params: { callerSessionId: string; taskId: string; message: string }) {
      const message = params.message.trim();
      if (!message || message.length > WORKBENCH_TOOL_MAX_MESSAGE_CHARS) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: `消息不能为空,且不超过 ${WORKBENCH_TOOL_MAX_MESSAGE_CHARS} 字` };
      }
      const allowed = await authorize(params.callerSessionId, params.taskId);
      if (!allowed.ok) return allowed;
      const sent = await deps.sendToSession({
        targetSessionId: params.taskId,
        message,
        dispatcherSessionId: params.callerSessionId,
      });
      if (!sent.ok) return sent;
      return {
        ok: true as const,
        taskId: params.taskId,
        delivery: sent.wakeKind === 'queued' ? ('queued' as const) : ('started' as const),
        ...(sent.queuedMessageId ? { queuedMessageId: sent.queuedMessageId } : {}),
      };
    },

    async stopTask(params: { callerSessionId: string; taskId: string }) {
      const allowed = await authorize(params.callerSessionId, params.taskId);
      if (!allowed.ok) return allowed;
      const stopped = await deps.stopSessionTurn({ targetSessionId: params.taskId });
      if (!stopped.ok) return stopped;
      return { ok: true as const, taskId: params.taskId, status: stopped.status };
    },
  };
}

export type BotWorkbenchAccess = ReturnType<typeof createBotWorkbenchAccess>;
