/**
 * 伙伴工作台的权限边界与工具服务(纯逻辑,依赖全部注入,便于单测)。
 *
 * 产品裁决(2026-10-01):伙伴可以查看、继续「主人明确交给它的项目」里的任务。
 * 授权来自主人「交给伙伴」的那一次(工作台里点选,或主人本人那一轮让伙伴记下),范围只限记在
 * 该伙伴 `workbench.json` 里的项目,主人随时可以移除。停止、插话等动作走通用会话工具,
 * 由宿主按「这一轮是谁触发的」逐次判定(见 botTurnAuthority.ts)。
 *
 * 接手 = 理解,不是搬运:项目是目录。宿主先给每个项目一份有界的素材(文档清单、近期提交与
 * 分支、我的 PR / issue)和近期会话的摘要(起始目的 + 最后几条),伙伴凭这些一次性写下判断
 * (没做完 / 聊过没下文 / 做完),只对拿不准的再读;条目可以是会话,也可以是 PR、issue
 * 或伙伴从素材里摸出来的建议。项目里的 Cindy 任务(含主人自己开的)不论有无判断都带回,
 * 是伙伴随时知道的项目事务。主人点头(或在工作台点「跟进」)的那件才继续。
 *
 * 每次调用都在 main 里确定性校验:
 *  1. 调用方 session → 伙伴:只认本机、在用的伙伴主任务(canonical);
 *  2. Cindy 任务:存在、未删除未归档、本机、不是任何伙伴的隐藏任务、不是后台任务、
 *     是普通来源的任务,并且工作目录属于该伙伴已接手的某个项目;
 *  3. 本机会话(Claude Code / Codex / Pi):这次发现里确有这条,且它的 cwd 落在已接手项目内;
 *  4. PR / issue:仓库必须是某个已接手项目的 GitHub 远端;建议:必须挂在某个已接手项目上;
 *  5. 参考(ref):只接受 https 链接,或已接手项目内的路径。
 * 任一条不满足就返回明确的错误码,不读、不写、不投递。
 */
import {
  boundWorkbenchSummary,
  canonicalWorkbenchTaskId,
  cleanWorkbenchTitle,
  deriveWorkbenchAutomationState,
  deriveWorkbenchSessionState,
  findWorkbenchProject,
  importedSessionOrigin,
  isWorkbenchTaskSource,
  parseWorkbenchTaskId,
  validateWorkbenchRef,
  WORKBENCH_JUDGMENT_NEXT_MAX,
  WORKBENCH_JUDGMENT_TITLE_MAX,
  WORKBENCH_RECENT_WINDOW_MS,
  type WorkbenchDelegationStatus,
  type WorkbenchDigest,
  type WorkbenchTaskJudgment,
  type WorkbenchTaskRef,
  type WorkbenchTaskState,
  type WorkbenchTranscript,
  type WorkbenchVerdict,
} from '../../shared/botWorkbench.js';
import type { WorkbenchProjectBrief } from './botWorkbenchBrief.js';

type Failure = { ok: false; errorCode: string; message: string };

/** 工具一次最多带回的会话候选数;多出来的只报总数。 */
export const WORKBENCH_TOOL_MAX_TASKS = 40;
/**
 * 其中项目里的 Cindy 任务(含主人自己开的)优先占的条数:它们属于伙伴随时知道的项目事务,
 * 不受判断影响;剩下的名额给本机外部会话。
 */
export const WORKBENCH_TOOL_MAX_CINDY_TASKS = 30;
export const WORKBENCH_TOOL_MAX_MESSAGE_CHARS = 4_000;
export const WORKBENCH_TOOL_MAX_BATCH = 30;
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

/** 本机外部会话候选(按项目目录发现,只读)。 */
export interface WorkbenchExternalCandidate {
  source: 'claude' | 'codex' | 'pi';
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  file: string;
  digest: WorkbenchDigest | null;
}

export function authorizeExternalCandidate(
  candidate: Pick<WorkbenchExternalCandidate, 'cwd'> | null,
  projectDirs: readonly string[],
  caseInsensitive: boolean,
): WorkbenchTargetDecision {
  if (!candidate) {
    return { ok: false, errorCode: 'TASK_NOT_FOUND', message: '找不到这条本机会话(只看最近 30 天)' };
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
  /** 已接手项目里近期的本机 Claude Code / Codex / Pi 会话(当前库里已有的除外),带摘要。 */
  listExternalCandidates(
    projectDirs: readonly string[],
  ): Promise<{ sessions: WorkbenchExternalCandidate[]; olderCount: number; overflowCount?: number }>;
  /** 本机会话已经是当前 Cindy 库里的任务时,对应的 Cindy session id。 */
  findImportedSession(source: 'claude' | 'codex' | 'pi', externalId: string): Promise<string | null>;
  /** 只导入这一条外部会话(仅 Claude Code / Codex 支持),返回它的 Cindy session id。 */
  importExternal(source: 'claude' | 'codex', externalId: string): Promise<{ ok: true; sessionId: string } | Failure>;
  /** 在项目目录里开一条伙伴后台任务(start_session_task 的服务端路径)。 */
  startBackgroundTask(params: {
    callerSessionId: string;
    workingDir: string;
    title: string;
    objective: string;
  }): Promise<{ ok: true; sessionId: string } | Failure>;
  readSessionDigest(sessionId: string, updatedAt: number): Promise<WorkbenchDigest>;
  readBrief(projectDir: string): Promise<WorkbenchProjectBrief>;
  /** 该伙伴自己的后台任务:执行任务 id → 状态。 */
  listDelegations(botId: string): Promise<Map<string, WorkbenchDelegationStatus>>;
  readActivityPhase(sessionId: string): Promise<string | null>;
  listRoutines(botId: string): Promise<WorkbenchRoutineRow[]>;
  listSchedules(): Promise<WorkbenchScheduleRow[]>;
  readSessionTranscript(sessionId: string): Promise<WorkbenchTranscript>;
  readExternalTranscript(candidate: WorkbenchExternalCandidate): Promise<WorkbenchTranscript | null>;
  saveJudgment(
    botId: string,
    taskId: string,
    judgment: Omit<WorkbenchTaskJudgment, 'updatedAt'>,
  ): Promise<WorkbenchTaskJudgment>;
  rekeyJudgment(botId: string, fromTaskId: string, toTaskId: string): Promise<void>;
  deleteJudgment(botId: string, taskId: string): Promise<void>;
  notifyChanged(botId: string): void;
  sendToSession(params: {
    targetSessionId: string;
    message: string;
    dispatcherSessionId: string;
  }): Promise<{ ok: true; wakeKind: string; queuedMessageId?: string } | Failure>;
  caseInsensitive: boolean;
  now?(): number;
  /** 账号切换守卫:返回 false 时中止,不做任何写入或投递。 */
  isOwnerScopeCurrent?(): boolean;
}

function projectName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

const scopeChanged: Failure = { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号已切换,请重试' };

/**
 * 项目数不再有产品上限,素材(brief:git、GitHub、文档清单)只给最近交代的前几个项目现算,
 * 其余项目 brief 为 null,伙伴需要时用自己的文件工具看。防止一次 get_workbench 拉几十个仓库。
 */
export const WORKBENCH_BRIEF_PROJECTS_MAX = 8;

type ResolvedTarget =
  | { ok: true; kind: 'session'; taskId: string; sessionId: string; projectDir: string }
  | {
      ok: true;
      kind: 'external';
      taskId: string;
      candidate: WorkbenchExternalCandidate;
      projectDir: string;
    }
  | { ok: true; kind: 'item'; taskId: string; ref: WorkbenchTaskRef; projectDir: string };

const VERDICTS: readonly WorkbenchVerdict[] = ['unfinished', 'idea', 'done'];
const SOURCE_LABEL = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' } as const;

export interface WorkbenchJudgmentInput {
  taskId: string;
  title: string;
  verdict: string;
  next?: string | null;
  ref?: string | null;
  /** 建议(idea:)挂在哪个项目;只交了一个项目时可省略。项目路径或项目名。 */
  project?: string | null;
}

export function createBotWorkbenchAccess(deps: BotWorkbenchAccessDeps) {
  const scopeCurrent = () => deps.isOwnerScopeCurrent?.() ?? true;
  const now = () => deps.now?.() ?? Date.now();

  const resolveSession = async (
    sessionId: string,
    projectDirs: readonly string[],
  ): Promise<ResolvedTarget | Failure> => {
    const decision = authorizeWorkbenchTarget(await deps.readTarget(sessionId), projectDirs, deps.caseInsensitive);
    if (!decision.ok) return decision;
    return { ok: true, kind: 'session', taskId: sessionId, sessionId, projectDir: decision.projectDir };
  };

  // 同一次调用(尤其批量写)里多次解析外部会话时,只扫一次目录。
  let externalsMemo: { key: string; at: number; value: ReturnType<BotWorkbenchAccessDeps['listExternalCandidates']> } | null = null;
  const listExternals = (projectDirs: readonly string[]) => {
    const key = projectDirs.join('\n');
    if (!externalsMemo || externalsMemo.key !== key || now() - externalsMemo.at > 5_000) {
      externalsMemo = { key, at: now(), value: deps.listExternalCandidates(projectDirs) };
    }
    return externalsMemo.value;
  };

  const projectForRepo = async (owner: string, repo: string, projectDirs: readonly string[]) => {
    const wanted = `${owner}/${repo}`.toLowerCase();
    for (const dir of projectDirs) {
      const brief = await deps.readBrief(dir).catch(() => null);
      if (brief?.git?.remotes.some((remote) => remote.toLowerCase() === wanted)) return dir;
    }
    return null;
  };

  const projectByHint = (hint: string | null | undefined, projectDirs: readonly string[]) => {
    if (!hint) return projectDirs.length === 1 ? projectDirs[0] : null;
    return (
      findWorkbenchProject(hint, projectDirs, deps.caseInsensitive)
      ?? projectDirs.find((dir) => projectName(dir).toLowerCase() === hint.trim().toLowerCase())
      ?? null
    );
  };

  const resolveTarget = async (
    taskId: string,
    workbench: { directories: string[]; tasks: Record<string, WorkbenchTaskJudgment> },
    projectHint?: string | null,
  ): Promise<ResolvedTarget | Failure> => {
    const projectDirs = workbench.directories;
    const ref = parseWorkbenchTaskId(taskId);
    if (!ref) return { ok: false, errorCode: 'TASK_NOT_FOUND', message: '任务 id 格式不对' };
    if (ref.kind === 'session') return resolveSession(ref.sessionId, projectDirs);
    const canonical = canonicalWorkbenchTaskId(ref);
    if (ref.kind === 'github') {
      const projectDir = await projectForRepo(ref.owner, ref.repo, projectDirs);
      if (!projectDir) {
        return { ok: false, errorCode: 'TASK_OUTSIDE_WORKBENCH', message: '这个仓库不是主人交给你的项目的 GitHub 远端' };
      }
      return { ok: true, kind: 'item', taskId: canonical, ref, projectDir };
    }
    if (ref.kind === 'idea') {
      const existing = workbench.tasks[canonical]?.project;
      const projectDir = projectByHint(projectHint ?? existing, projectDirs)
        ?? (existing ? findWorkbenchProject(existing, projectDirs, deps.caseInsensitive) : null);
      if (!projectDir) {
        return {
          ok: false,
          errorCode: projectDirs.length > 1 ? 'PROJECT_REQUIRED' : 'TASK_OUTSIDE_WORKBENCH',
          message: projectDirs.length > 1 ? '交了不止一个项目,请用 project 指明这条建议属于哪个项目' : '这条建议不在主人交给你的项目里',
        };
      }
      return { ok: true, kind: 'item', taskId: canonical, ref, projectDir };
    }
    const imported = await deps.findImportedSession(ref.source, ref.externalId);
    if (imported) return resolveSession(imported, projectDirs);
    const { sessions } = await listExternals(projectDirs);
    const candidate = sessions.find((item) => item.source === ref.source && item.id === ref.externalId) ?? null;
    const decision = authorizeExternalCandidate(candidate, projectDirs, deps.caseInsensitive);
    if (!decision.ok) return decision;
    return { ok: true, kind: 'external', taskId: canonical, candidate: candidate!, projectDir: decision.projectDir };
  };

  const authorize = async (callerSessionId: string, taskId: string, projectHint?: string | null) => {
    const caller = await deps.resolveCaller(callerSessionId);
    if (!caller.ok) return caller;
    const workbench = await deps.readState(caller.botId);
    const target = await resolveTarget(taskId, workbench, projectHint);
    if (!target.ok) return target;
    if (!scopeCurrent()) return scopeChanged;
    return { ok: true as const, botId: caller.botId, workbench, target };
  };

  /**
   * 主人可能在这次调用进行中收回了项目:在返回内容或做任何投递 / 停止之前再读一次
   * 已接手的项目,确认目标所在项目仍在。
   */
  const stillGranted = async (botId: string, projectDir: string): Promise<Failure | null> => {
    const { directories } = await deps.readState(botId);
    if (!directories.includes(projectDir)) {
      return { ok: false, errorCode: 'TASK_OUTSIDE_WORKBENCH', message: '主人已收回这个项目' };
    }
    return scopeCurrent() ? null : scopeChanged;
  };

  const readTranscript = async (target: ResolvedTarget): Promise<WorkbenchTranscript | Failure | null> => {
    if (target.kind === 'session') return deps.readSessionTranscript(target.sessionId);
    if (target.kind === 'external') return deps.readExternalTranscript(target.candidate);
    return { ok: false, errorCode: 'TASK_NOT_READABLE', message: 'PR、issue 与建议没有对话记录,请直接看链接或项目文件' };
  };

  const validateJudgment = (
    input: WorkbenchJudgmentInput,
  ): { ok: true; title: string; verdict: WorkbenchVerdict; next: string } | Failure => {
    const title = input.title.replace(/\s+/g, ' ').trim();
    const next = (input.next ?? '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > WORKBENCH_JUDGMENT_TITLE_MAX) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: `title 不能为空,且不超过 ${WORKBENCH_JUDGMENT_TITLE_MAX} 字` };
    }
    if (!VERDICTS.includes(input.verdict as WorkbenchVerdict)) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: 'verdict 只能是 unfinished / idea / done' };
    }
    if (next.length > WORKBENCH_JUDGMENT_NEXT_MAX) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: `next 不超过 ${WORKBENCH_JUDGMENT_NEXT_MAX} 字` };
    }
    if (input.verdict !== 'done' && !next) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: '没做完或聊过没下文的任务需要写一句 next' };
    }
    return { ok: true, title, verdict: input.verdict as WorkbenchVerdict, next };
  };

  const saveOne = async (
    botId: string,
    workbench: { directories: string[]; tasks: Record<string, WorkbenchTaskJudgment> },
    input: WorkbenchJudgmentInput,
  ) => {
    const valid = validateJudgment(input);
    if (!valid.ok) return { taskId: input.taskId, ...valid };
    const target = await resolveTarget(input.taskId, workbench, input.project);
    if (!target.ok) return { taskId: input.taskId, ...target };
    let ref: string | null = null;
    if (input.ref) {
      const checked = validateWorkbenchRef(input.ref, workbench.directories, deps.caseInsensitive);
      if (!checked.ok) {
        return {
          taskId: input.taskId,
          ok: false as const,
          errorCode: 'INVALID_REF',
          message: 'ref 只能是 https 链接,或主人交给你的项目里的路径',
        };
      }
      ref = checked.ref;
    }
    const saved = await deps.saveJudgment(botId, target.taskId, {
      title: valid.title,
      verdict: valid.verdict,
      next: valid.next || null,
      project: target.projectDir,
      ref,
    });
    return { taskId: target.taskId, ok: true as const, judgment: saved };
  };

  /** 在项目目录里开一条伙伴后台任务承接这件事,工作台上的条目随之变成「你交代的」。 */
  const continueAsBackgroundTask = async (
    callerSessionId: string,
    botId: string,
    target: ResolvedTarget,
    judgment: WorkbenchTaskJudgment | undefined,
    message: string,
  ) => {
    const title = judgment?.title
      ?? (target.kind === 'external' ? cleanWorkbenchTitle(target.candidate.title, UNTITLED) : UNTITLED);
    const background: string[] = [];
    if (judgment?.next) background.push(`下一步:${judgment.next}`);
    if (judgment?.ref) background.push(`参考:${judgment.ref}`);
    if (target.kind === 'item' && target.ref.kind === 'github') {
      background.push(`GitHub ${target.ref.type === 'pr' ? 'PR' : 'issue'}:${target.ref.owner}/${target.ref.repo}#${target.ref.number}`);
    }
    if (target.kind === 'external') {
      const digest = target.candidate.digest;
      background.push(`这件事之前在本机 ${SOURCE_LABEL[target.candidate.source]} 会话里做过(转录:${target.candidate.file})。`);
      if (digest?.purpose) background.push(`起始目的:${digest.purpose}`);
      for (const item of digest?.recent ?? []) background.push(`${item.role === 'user' ? '用户' : '助手'}:${item.text}`);
    }
    const objective = [title, message, ...background].join('\n\n').slice(0, 8_000);
    const revoked = await stillGranted(botId, target.projectDir);
    if (revoked) return revoked;
    const started = await deps.startBackgroundTask({ callerSessionId, workingDir: target.projectDir, title, objective });
    if (!started.ok) return started;
    if (judgment) await deps.deleteJudgment(botId, target.taskId);
    deps.notifyChanged(botId);
    return { ok: true as const, taskId: started.sessionId, delivery: 'started' as const, startedFrom: target.taskId };
  };

  return {
    async get(params: { callerSessionId: string }) {
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      const workbench = await deps.readState(caller.botId);
      const projectDirs = workbench.directories;
      const since = now() - WORKBENCH_RECENT_WINDOW_MS;
      const delegations = await deps.listDelegations(caller.botId);
      const [rows, externals, routines, schedules, exists, briefs] = await Promise.all([
        projectDirs.length
          ? deps.listProjectTasks(projectDirs, new Set(delegations.keys()))
          : Promise.resolve([]),
        projectDirs.length ? listExternals(projectDirs) : Promise.resolve({ sessions: [], olderCount: 0, overflowCount: 0 }),
        deps.listRoutines(caller.botId),
        projectDirs.length ? deps.listSchedules() : Promise.resolve([]),
        Promise.all(projectDirs.map((dir) => deps.projectExists?.(dir) ?? Promise.resolve(true))),
        Promise.all(projectDirs.map((dir, index) => (index < WORKBENCH_BRIEF_PROJECTS_MAX
          ? deps.readBrief(dir).catch(() => null)
          : Promise.resolve(null)))),
      ]);
      type Candidate = {
        taskId: string;
        source: 'cindy' | 'claude-code' | 'codex' | 'pi';
        title: string;
        project: string;
        lastActiveMs: number;
        messageCount: number | null;
        row?: WorkbenchTaskRow;
        digest: WorkbenchDigest | null;
      };
      const all: Candidate[] = [];
      let olderCount = externals.olderCount;
      for (const row of rows) {
        const project = findWorkbenchProject(row.workingDir, projectDirs, deps.caseInsensitive);
        if (!project) continue;
        const lastActiveMs = row.lastActiveAt ?? 0;
        // 只看近期;伙伴自己的后台任务不管多久都列出。
        if (lastActiveMs < since && !delegations.has(row.id)) {
          olderCount += 1;
          continue;
        }
        all.push({
          taskId: row.id,
          source: importedSessionOrigin(row.id, row.agentKind) ?? 'cindy',
          title: cleanWorkbenchTitle(row.title, UNTITLED),
          project: projectName(project),
          lastActiveMs,
          messageCount: row.messageCount ?? null,
          row,
          digest: null,
        });
      }
      for (const external of externals.sessions) {
        const project = findWorkbenchProject(external.cwd, projectDirs, deps.caseInsensitive);
        if (!project) continue;
        all.push({
          taskId: `${external.source}:${external.id}`,
          source: external.source === 'claude' ? 'claude-code' : external.source,
          title: cleanWorkbenchTitle(external.title, UNTITLED),
          project: projectName(project),
          lastActiveMs: external.updatedAt,
          messageCount: null,
          digest: external.digest,
        });
      }
      all.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
      const cindy = all.filter((candidate) => candidate.row).slice(0, WORKBENCH_TOOL_MAX_CINDY_TASKS);
      const external = all
        .filter((candidate) => !candidate.row)
        .slice(0, WORKBENCH_TOOL_MAX_TASKS - cindy.length);
      const shown = [...cindy, ...external].sort((a, b) => b.lastActiveMs - a.lastActiveMs);
      const tasks = await Promise.all(
        shown.map(async (candidate) => {
          const delegationStatus = candidate.row ? (delegations.get(candidate.row.id) ?? null) : null;
          const state: WorkbenchTaskState | null = candidate.row
            ? deriveWorkbenchSessionState({
                activityPhase: await deps.readActivityPhase(candidate.row.id),
                delegationStatus,
              })
            : null;
          const digest = candidate.row
            ? await deps.readSessionDigest(candidate.row.id, candidate.lastActiveMs).catch(() => null)
            : candidate.digest;
          const judgment = workbench.tasks[candidate.taskId] ?? null;
          return {
            taskId: candidate.taskId,
            source: candidate.source,
            imported: Boolean(candidate.row),
            title: candidate.title,
            project: candidate.project,
            state,
            kind: delegationStatus ? ('delegated' as const) : ('existing' as const),
            lastActiveAt: candidate.lastActiveMs ? new Date(candidate.lastActiveMs).toISOString() : null,
            messageCount: candidate.messageCount,
            digest,
            judgment: judgment
              ? { title: judgment.title, verdict: judgment.verdict, next: judgment.next, updatedAt: judgment.updatedAt }
              : null,
          };
        }),
      );
      // PR / issue / 建议:伙伴之前写过的判断原样带回,便于它整理。
      const items = Object.entries(workbench.tasks).flatMap(([taskId, judgment]) => {
        const ref = parseWorkbenchTaskId(taskId);
        if (!ref || (ref.kind !== 'github' && ref.kind !== 'idea')) return [];
        const project = findWorkbenchProject(judgment.project, projectDirs, deps.caseInsensitive);
        if (!project) return [];
        return [{
          taskId,
          project: projectName(project),
          judgment: {
            title: judgment.title,
            verdict: judgment.verdict,
            next: judgment.next,
            ref: judgment.ref ?? null,
            updatedAt: judgment.updatedAt,
          },
        }];
      });
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
          projects: projectDirs.map((dir, index) => ({
            name: projectName(dir),
            path: dir,
            exists: exists[index] ?? true,
            brief: briefs[index],
          })),
          tasks,
          items,
          automations,
          counts,
          truncated: all.length > shown.length || (externals.overflowCount ?? 0) > 0,
          totalTasks: all.length + (externals.overflowCount ?? 0),
          olderCount,
        },
      };
    },

    async read(params: { callerSessionId: string; taskId: string }) {
      const allowed = await authorize(params.callerSessionId, params.taskId);
      if (!allowed.ok) return allowed;
      const transcript = await readTranscript(allowed.target);
      if (!transcript) return { ok: false as const, errorCode: 'TRANSCRIPT_UNAVAILABLE', message: '读不到这条会话的记录' };
      if ('ok' in transcript) return transcript;
      const revoked = await stillGranted(allowed.botId, allowed.target.projectDir);
      if (revoked) return revoked;
      return { ok: true as const, taskId: allowed.target.taskId, transcript };
    },

    async set(params: { callerSessionId: string } & WorkbenchJudgmentInput) {
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      const valid = validateJudgment(params);
      if (!valid.ok) return valid;
      const workbench = await deps.readState(caller.botId);
      if (!scopeCurrent()) return scopeChanged;
      const result = await saveOne(caller.botId, workbench, params);
      if (!result.ok) return { ok: false as const, errorCode: result.errorCode, message: result.message };
      deps.notifyChanged(caller.botId);
      return { ok: true as const, taskId: result.taskId, judgment: result.judgment };
    },

    /** 批量写判断:逐条校验,一条失败不影响其它条;最后只广播一次。 */
    async setMany(params: { callerSessionId: string; items: WorkbenchJudgmentInput[] }) {
      if (params.items.length === 0 || params.items.length > WORKBENCH_TOOL_MAX_BATCH) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: `一次写 1–${WORKBENCH_TOOL_MAX_BATCH} 条` };
      }
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      if (!scopeCurrent()) return scopeChanged;
      const results = [];
      for (const item of params.items) {
        const workbench = await deps.readState(caller.botId);
        results.push(await saveOne(caller.botId, workbench, item));
      }
      if (results.some((result) => result.ok)) deps.notifyChanged(caller.botId);
      return {
        ok: true as const,
        saved: results.filter((result) => result.ok).length,
        results: results.map((result) =>
          result.ok
            ? { taskId: result.taskId, ok: true as const }
            : { taskId: result.taskId, ok: false as const, errorCode: result.errorCode, message: result.message },
        ),
      };
    },

    async continueTask(params: { callerSessionId: string; taskId: string; message: string }) {
      const message = params.message.trim();
      if (!message || message.length > WORKBENCH_TOOL_MAX_MESSAGE_CHARS) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: `消息不能为空,且不超过 ${WORKBENCH_TOOL_MAX_MESSAGE_CHARS} 字` };
      }
      const allowed = await authorize(params.callerSessionId, params.taskId);
      if (!allowed.ok) return allowed;
      const target = allowed.target;
      const judgment = allowed.workbench.tasks[target.taskId];
      if (target.kind === 'item') {
        if (!judgment) {
          return { ok: false as const, errorCode: 'TASK_NOT_FOUND', message: '先用 set_workbench_task 写下这件事,再继续' };
        }
        return continueAsBackgroundTask(params.callerSessionId, allowed.botId, target, judgment, message);
      }
      let sessionId: string;
      let imported = false;
      const revokedBefore = await stillGranted(allowed.botId, target.projectDir);
      if (revokedBefore) return revokedBefore;
      if (target.kind === 'external') {
        // 主人点头的这一件才导入:只导入这一条,判断改挂到新的任务上。Pi 会话没有导入路径,
        // Claude Code / Codex 导入不了时(例如转录在另一个 Cindy profile 里),改为在项目里开一条
        // 伙伴后台任务承接,并带上原会话的摘要。
        const result = target.candidate.source === 'pi'
          ? null
          : await deps.importExternal(target.candidate.source, target.candidate.id);
        if (!result || !result.ok) {
          return continueAsBackgroundTask(params.callerSessionId, allowed.botId, target, judgment, message);
        }
        if (!scopeCurrent()) return scopeChanged;
        await deps.rekeyJudgment(allowed.botId, target.taskId, result.sessionId);
        imported = true;
        deps.notifyChanged(allowed.botId);
        const recheck = await resolveSession(result.sessionId, allowed.workbench.directories);
        if (!recheck.ok) return recheck;
        sessionId = result.sessionId;
      } else {
        sessionId = target.sessionId;
      }
      const revoked = await stillGranted(allowed.botId, target.projectDir);
      if (revoked) return revoked;
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
        ...(imported ? { importedFrom: target.taskId } : {}),
      };
    },

    /**
     * 渲染层详情视图读取同一份有界摘录。调用方是主人自己的界面(受信 renderer),
     * 仍按该伙伴已接手的项目判定范围,不让详情视图成为读任意会话的入口。
     */
    async readForOwner(params: { botId: string; taskId: string }) {
      const workbench = await deps.readState(params.botId);
      const target = await resolveTarget(params.taskId, workbench);
      if (!target.ok) return target;
      const transcript = await readTranscript(target);
      if (!transcript) return { ok: false as const, errorCode: 'TRANSCRIPT_UNAVAILABLE', message: '读不到这条会话的记录' };
      if ('ok' in transcript) return transcript;
      if (!scopeCurrent()) return scopeChanged;
      return { ok: true as const, taskId: target.taskId, transcript };
    },

    /** 工作台用:已接手项目里近期本机会话的 id 与最近活动(判断「正在了解」与排序)。 */
    async listCandidatesForOwner(params: { botId: string }) {
      const workbench = await deps.readState(params.botId);
      if (workbench.directories.length === 0) return { ok: true as const, candidates: [] };
      const { sessions } = await listExternals(workbench.directories);
      if (!scopeCurrent()) return scopeChanged;
      return {
        ok: true as const,
        candidates: sessions.map((item) => ({
          source: item.source,
          id: item.id,
          projectDir: item.cwd,
          updatedAt: new Date(item.updatedAt).toISOString(),
          archived: false,
        })),
      };
    },
  };
}

export type BotWorkbenchAccess = ReturnType<typeof createBotWorkbenchAccess>;
