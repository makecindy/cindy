/**
 * 伙伴工作台的权限边界与工具服务(纯逻辑,依赖全部注入,便于单测)。
 *
 * 产品裁决(2026-10-01):伙伴可以查看、继续、停止「主人明确交给它的项目」里的任务。
 * 授权来自主人在工作台里点「交给伙伴」的那一次,范围只限记在该伙伴
 * `workbench.json` 里的项目,主人随时可以移除;其它任务仍不可触达。
 *
 * 接手 = 理解,不是搬运:伙伴先读候选(项目里的 Cindy 任务 + 还没导入的本机
 * Claude Code / Codex 会话),写下判断(没做完 / 聊过没下文 / 做完),主人点头的
 * 那件才导入并继续。
 *
 * 每次调用都在 main 里确定性校验:
 *  1. 调用方 session → 伙伴:只认本机、在用的伙伴主任务(canonical);
 *  2. Cindy 任务:存在、未删除未归档、本机、不是任何伙伴的隐藏任务、不是后台任务、
 *     是普通来源的任务,并且工作目录属于该伙伴已接手的某个项目;
 *  3. 外部会话:扫描里确有这条、未归档、是项目会话,且它的 cwd 落在已接手项目内。
 * 任一条不满足就返回明确的错误码,不读、不写、不投递。
 */
import {
  boundWorkbenchSummary,
  cleanWorkbenchTitle,
  deriveWorkbenchAutomationState,
  deriveWorkbenchSessionState,
  externalWorkbenchTaskId,
  findWorkbenchProject,
  importedSessionOrigin,
  isWorkbenchTaskSource,
  parseWorkbenchTaskId,
  WORKBENCH_JUDGMENT_NEXT_MAX,
  WORKBENCH_JUDGMENT_TITLE_MAX,
  type WorkbenchDelegationStatus,
  type WorkbenchTaskJudgment,
  type WorkbenchTaskState,
  type WorkbenchTranscript,
  type WorkbenchVerdict,
} from '../../shared/botWorkbench.js';

type Failure = { ok: false; errorCode: string; message: string };

/** 工具一次最多带回的候选数;多出来的只报总数。 */
export const WORKBENCH_TOOL_MAX_TASKS = 30;
export const WORKBENCH_TOOL_MAX_MESSAGE_CHARS = 4_000;
const UNTITLED = '未命名任务';

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

/** 本机外部会话候选(来自导入扫描,只读)。 */
export interface WorkbenchExternalCandidate {
  source: 'claude' | 'codex';
  id: string;
  title: string;
  cwd: string;
  workspaceKind: 'project' | 'dialogue';
  updatedAt: number;
  archived: boolean;
}

export function authorizeExternalCandidate(
  candidate: WorkbenchExternalCandidate | null,
  projectDirs: readonly string[],
  caseInsensitive: boolean,
): WorkbenchTargetDecision {
  if (!candidate) {
    return { ok: false, errorCode: 'TASK_NOT_FOUND', message: '找不到这条本机会话' };
  }
  if (candidate.archived) {
    return { ok: false, errorCode: 'TASK_ARCHIVED', message: '这条本机会话已归档' };
  }
  if (candidate.workspaceKind !== 'project') {
    return { ok: false, errorCode: 'TASK_NOT_SUPPORTED', message: '没有项目的本机会话不在工作台的范围内' };
  }
  const projectDir = findWorkbenchProject(candidate.cwd, projectDirs, caseInsensitive);
  if (!projectDir) {
    return { ok: false, errorCode: 'TASK_OUTSIDE_WORKBENCH', message: '这条本机会话不在主人交给你的项目里' };
  }
  return { ok: true, projectDir };
}

/** 项目里一件 Cindy 候选任务的原始事实(未推导状态)。 */
export interface WorkbenchTaskRow {
  id: string;
  title: string;
  workingDir: string | null;
  agentKind: string | null;
  summary: string | null;
  lastActiveAt: number | null;
  messageCount?: number | null;
}

export interface WorkbenchRoutineRow {
  id: string;
  name: string;
  enabled: boolean;
  activity?: 'queued' | 'running';
  lastResult: string | null;
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
  readState(botId: string): Promise<{ directories: string[]; tasks: Record<string, WorkbenchTaskJudgment> }>;
  projectExists?(dir: string): Promise<boolean>;
  readTarget(sessionId: string): Promise<WorkbenchTargetFacts | null>;
  /**
   * 已接手项目里的 Cindy 候选任务,按最近活动倒序;不含伙伴隐藏任务与从未发过消息的草稿。
   * `alwaysInclude` 里的任务(伙伴刚开、还在排队的后台任务)即使还没有消息也要列出。
   */
  listProjectTasks(projectDirs: readonly string[], alwaysInclude: ReadonlySet<string>): Promise<WorkbenchTaskRow[]>;
  /** 本机还没导入的 Claude Code / Codex 会话(只读扫描,带缓存)。 */
  listExternalCandidates(): Promise<WorkbenchExternalCandidate[]>;
  /** 外部会话已被导入时,对应的 Cindy session id。 */
  findImportedSession(source: 'claude' | 'codex', externalId: string): Promise<string | null>;
  /** 只导入这一条外部会话,返回它的 Cindy session id。 */
  importExternal(source: 'claude' | 'codex', externalId: string): Promise<{ ok: true; sessionId: string } | Failure>;
  /** 该伙伴自己的后台任务:执行任务 id → 状态。 */
  listDelegations(botId: string): Promise<Map<string, WorkbenchDelegationStatus>>;
  readActivityPhase(sessionId: string): Promise<string | null>;
  listRoutines(botId: string): Promise<WorkbenchRoutineRow[]>;
  listSchedules(): Promise<WorkbenchScheduleRow[]>;
  readSessionTranscript(sessionId: string): Promise<WorkbenchTranscript>;
  readExternalTranscript(source: 'claude' | 'codex', externalId: string): Promise<WorkbenchTranscript | null>;
  saveJudgment(
    botId: string,
    taskId: string,
    judgment: Omit<WorkbenchTaskJudgment, 'updatedAt'>,
  ): Promise<WorkbenchTaskJudgment>;
  rekeyJudgment(botId: string, fromTaskId: string, toTaskId: string): Promise<void>;
  notifyChanged(botId: string): void;
  sendToSession(params: {
    targetSessionId: string;
    message: string;
    dispatcherSessionId: string;
  }): Promise<{ ok: true; wakeKind: string; queuedMessageId?: string } | Failure>;
  stopSessionTurn(params: {
    targetSessionId: string;
  }): Promise<
    | { ok: true; status: 'no-active-turn' | 'waiting-for-safe-point' | 'requested' | 'unconfirmed' }
    | Failure
  >;
  caseInsensitive: boolean;
  /** 账号切换守卫:返回 false 时中止,不做任何写入或投递。 */
  isOwnerScopeCurrent?(): boolean;
}

function projectName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

const scopeChanged: Failure = { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号已切换,请重试' };

type ResolvedTarget =
  | { ok: true; kind: 'session'; taskId: string; sessionId: string; projectDir: string }
  | {
      ok: true;
      kind: 'external';
      taskId: string;
      source: 'claude' | 'codex';
      externalId: string;
      projectDir: string;
    };

const VERDICTS: readonly WorkbenchVerdict[] = ['unfinished', 'idea', 'done'];

export function createBotWorkbenchAccess(deps: BotWorkbenchAccessDeps) {
  const scopeCurrent = () => deps.isOwnerScopeCurrent?.() ?? true;

  const resolveSession = async (
    sessionId: string,
    projectDirs: readonly string[],
  ): Promise<ResolvedTarget | Failure> => {
    const decision = authorizeWorkbenchTarget(await deps.readTarget(sessionId), projectDirs, deps.caseInsensitive);
    if (!decision.ok) return decision;
    return { ok: true, kind: 'session', taskId: sessionId, sessionId, projectDir: decision.projectDir };
  };

  const resolveTarget = async (
    taskId: string,
    projectDirs: readonly string[],
  ): Promise<ResolvedTarget | Failure> => {
    const ref = parseWorkbenchTaskId(taskId);
    if (!ref) return { ok: false, errorCode: 'TASK_NOT_FOUND', message: '任务 id 无效' };
    if (ref.kind === 'session') return resolveSession(ref.sessionId, projectDirs);
    const candidates = await deps.listExternalCandidates();
    const candidate = candidates.find((item) => item.source === ref.source && item.id === ref.externalId) ?? null;
    if (!candidate) {
      // 已经导入过的外部会话从扫描里消失,改按导入后的 Cindy 任务校验。
      const imported = await deps.findImportedSession(ref.source, ref.externalId);
      if (imported) return resolveSession(imported, projectDirs);
    }
    const decision = authorizeExternalCandidate(candidate, projectDirs, deps.caseInsensitive);
    if (!decision.ok) return decision;
    return {
      ok: true,
      kind: 'external',
      taskId: externalWorkbenchTaskId(ref.source, ref.externalId),
      source: ref.source,
      externalId: ref.externalId,
      projectDir: decision.projectDir,
    };
  };

  const authorize = async (callerSessionId: string, taskId: string) => {
    const caller = await deps.resolveCaller(callerSessionId);
    if (!caller.ok) return caller;
    const workbench = await deps.readState(caller.botId);
    const target = await resolveTarget(taskId, workbench.directories);
    if (!target.ok) return target;
    if (!scopeCurrent()) return scopeChanged;
    return { ok: true as const, botId: caller.botId, workbench, target };
  };

  const readTranscript = async (target: ResolvedTarget) =>
    target.kind === 'session'
      ? deps.readSessionTranscript(target.sessionId)
      : deps.readExternalTranscript(target.source, target.externalId);

  return {
    async get(params: { callerSessionId: string }) {
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      const workbench = await deps.readState(caller.botId);
      const projectDirs = workbench.directories;
      const delegations = await deps.listDelegations(caller.botId);
      const [rows, externals, routines, schedules, exists] = await Promise.all([
        projectDirs.length
          ? deps.listProjectTasks(projectDirs, new Set(delegations.keys()))
          : Promise.resolve([]),
        projectDirs.length ? deps.listExternalCandidates() : Promise.resolve([]),
        deps.listRoutines(caller.botId),
        projectDirs.length ? deps.listSchedules() : Promise.resolve([]),
        Promise.all(projectDirs.map((dir) => deps.projectExists?.(dir) ?? Promise.resolve(true))),
      ]);
      type Candidate = {
        taskId: string;
        source: 'cindy' | 'claude-code' | 'codex';
        title: string;
        project: string;
        lastActiveMs: number;
        messageCount: number | null;
        row?: WorkbenchTaskRow;
      };
      const all: Candidate[] = [];
      for (const row of rows) {
        const project = findWorkbenchProject(row.workingDir, projectDirs, deps.caseInsensitive);
        if (!project) continue;
        all.push({
          taskId: row.id,
          source: importedSessionOrigin(row.id, row.agentKind) ?? 'cindy',
          title: cleanWorkbenchTitle(row.title, UNTITLED),
          project: projectName(project),
          lastActiveMs: row.lastActiveAt ?? 0,
          messageCount: row.messageCount ?? null,
          row,
        });
      }
      for (const external of externals) {
        if (!authorizeExternalCandidate(external, projectDirs, deps.caseInsensitive).ok) continue;
        const project = findWorkbenchProject(external.cwd, projectDirs, deps.caseInsensitive)!;
        all.push({
          taskId: externalWorkbenchTaskId(external.source, external.id),
          source: external.source === 'claude' ? 'claude-code' : 'codex',
          title: cleanWorkbenchTitle(external.title, UNTITLED),
          project: projectName(project),
          lastActiveMs: external.updatedAt,
          messageCount: null,
        });
      }
      all.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
      const shown = all.slice(0, WORKBENCH_TOOL_MAX_TASKS);
      const tasks = await Promise.all(
        shown.map(async (candidate) => {
          const delegationStatus = candidate.row ? (delegations.get(candidate.row.id) ?? null) : null;
          const state: WorkbenchTaskState | null = candidate.row
            ? deriveWorkbenchSessionState({
                activityPhase: await deps.readActivityPhase(candidate.row.id),
                delegationStatus,
              })
            : null;
          const judgment = workbench.tasks[candidate.taskId] ?? null;
          return {
            taskId: candidate.taskId,
            source: candidate.source,
            imported: Boolean(candidate.row),
            title: candidate.title,
            project: candidate.project,
            state,
            kind: delegationStatus ? ('delegated' as const) : ('existing' as const),
            summary: boundWorkbenchSummary(candidate.row?.summary),
            lastActiveAt: candidate.lastActiveMs ? new Date(candidate.lastActiveMs).toISOString() : null,
            messageCount: candidate.messageCount,
            judgment: judgment
              ? { title: judgment.title, verdict: judgment.verdict, next: judgment.next, updatedAt: judgment.updatedAt }
              : null,
          };
        }),
      );
      const automations = [
        ...routines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          kind: 'routine' as const,
          state: deriveWorkbenchAutomationState({
            enabled: routine.enabled,
            running: routine.activity === 'running',
            queued: routine.activity === 'queued',
          }),
          project: null,
          nextRunAt: null,
          lastResult: boundWorkbenchSummary(routine.lastResult),
        })),
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
      const counts = { unfinished: 0, idea: 0, done: 0, unjudged: 0 };
      for (const task of tasks) {
        if (task.judgment) counts[task.judgment.verdict] += 1;
        else if (task.kind !== 'delegated') counts.unjudged += 1;
      }
      if (!scopeCurrent()) return scopeChanged;
      return {
        ok: true as const,
        workbench: {
          projects: projectDirs.map((dir, index) => ({ name: projectName(dir), path: dir, exists: exists[index] ?? true })),
          tasks,
          automations,
          counts,
          truncated: all.length > shown.length,
          totalTasks: all.length,
        },
      };
    },

    async read(params: { callerSessionId: string; taskId: string }) {
      const allowed = await authorize(params.callerSessionId, params.taskId);
      if (!allowed.ok) return allowed;
      const transcript = await readTranscript(allowed.target);
      if (!transcript) return { ok: false as const, errorCode: 'TRANSCRIPT_UNAVAILABLE', message: '读不到这条会话的记录' };
      return { ok: true as const, taskId: allowed.target.taskId, transcript };
    },

    async set(params: {
      callerSessionId: string;
      taskId: string;
      title: string;
      verdict: string;
      next?: string | null;
    }) {
      const title = params.title.replace(/\s+/g, ' ').trim();
      const next = (params.next ?? '').replace(/\s+/g, ' ').trim();
      if (!title || title.length > WORKBENCH_JUDGMENT_TITLE_MAX) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: `title 不能为空,且不超过 ${WORKBENCH_JUDGMENT_TITLE_MAX} 字` };
      }
      if (!VERDICTS.includes(params.verdict as WorkbenchVerdict)) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: 'verdict 只能是 unfinished / idea / done' };
      }
      if (next.length > WORKBENCH_JUDGMENT_NEXT_MAX) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: `next 不超过 ${WORKBENCH_JUDGMENT_NEXT_MAX} 字` };
      }
      if (params.verdict !== 'done' && !next) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: '没做完或聊过没下文的任务需要写一句 next' };
      }
      const allowed = await authorize(params.callerSessionId, params.taskId);
      if (!allowed.ok) return allowed;
      const saved = await deps.saveJudgment(allowed.botId, allowed.target.taskId, {
        title,
        verdict: params.verdict as WorkbenchVerdict,
        next: next || null,
        project: allowed.target.projectDir,
      });
      deps.notifyChanged(allowed.botId);
      return { ok: true as const, taskId: allowed.target.taskId, judgment: saved };
    },

    async continueTask(params: { callerSessionId: string; taskId: string; message: string }) {
      const message = params.message.trim();
      if (!message || message.length > WORKBENCH_TOOL_MAX_MESSAGE_CHARS) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: `消息不能为空,且不超过 ${WORKBENCH_TOOL_MAX_MESSAGE_CHARS} 字` };
      }
      const allowed = await authorize(params.callerSessionId, params.taskId);
      if (!allowed.ok) return allowed;
      let sessionId: string;
      let imported = false;
      if (allowed.target.kind === 'external') {
        // 主人点头的这一件才导入:只导入这一条,判断改挂到新的任务上。
        const result = await deps.importExternal(allowed.target.source, allowed.target.externalId);
        if (!result.ok) return result;
        if (!scopeCurrent()) return scopeChanged;
        await deps.rekeyJudgment(allowed.botId, allowed.target.taskId, result.sessionId);
        imported = true;
        deps.notifyChanged(allowed.botId);
        const recheck = await resolveSession(result.sessionId, allowed.workbench.directories);
        if (!recheck.ok) return recheck;
        sessionId = result.sessionId;
      } else {
        sessionId = allowed.target.sessionId;
      }
      const sent = await deps.sendToSession({
        targetSessionId: sessionId,
        message,
        dispatcherSessionId: params.callerSessionId,
      });
      if (!sent.ok) return sent;
      return {
        ok: true as const,
        taskId: sessionId,
        delivery: sent.wakeKind === 'queued' ? ('queued' as const) : ('started' as const),
        ...(sent.queuedMessageId ? { queuedMessageId: sent.queuedMessageId } : {}),
        ...(imported ? { importedFrom: allowed.target.taskId } : {}),
      };
    },

    async stopTask(params: { callerSessionId: string; taskId: string }) {
      const allowed = await authorize(params.callerSessionId, params.taskId);
      if (!allowed.ok) return allowed;
      if (allowed.target.kind !== 'session') {
        return { ok: false as const, errorCode: 'TASK_NOT_RUNNING', message: '这条本机会话还没接过来,没有在跑' };
      }
      const stopped = await deps.stopSessionTurn({ targetSessionId: allowed.target.sessionId });
      if (!stopped.ok) return stopped;
      return { ok: true as const, taskId: allowed.target.sessionId, status: stopped.status };
    },

    /**
     * 渲染层详情视图读取同一份有界摘录。调用方是主人自己的界面(受信 renderer),
     * 仍按该伙伴已接手的项目判定范围,不让详情视图成为读任意会话的入口。
     */
    async readForOwner(params: { botId: string; taskId: string }) {
      const workbench = await deps.readState(params.botId);
      const target = await resolveTarget(params.taskId, workbench.directories);
      if (!target.ok) return target;
      const transcript = await readTranscript(target);
      if (!transcript) return { ok: false as const, errorCode: 'TRANSCRIPT_UNAVAILABLE', message: '读不到这条会话的记录' };
      if (!scopeCurrent()) return scopeChanged;
      return { ok: true as const, taskId: target.taskId, transcript };
    },
  };
}

export type BotWorkbenchAccess = ReturnType<typeof createBotWorkbenchAccess>;
