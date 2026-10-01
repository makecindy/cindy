/**
 * 伙伴工作台的渲染层投影(纯函数)。
 *
 * 输入全是渲染层已经有的数据:任务列表缓存、伙伴档案(用来排除伙伴自己的隐藏任务)、
 * 伙伴的后台任务、灵动岛同源的活动快照、侧栏同源的待关注标记、自动化与例行任务。
 * 输出两样东西:
 *  - 空状态的项目清单:复用任务列表的项目分组(`groupSessions`),合并本机 Claude Code /
 *    Codex 的可导入候选与项目里的自动化;
 *  - 已接手项目的任务格:每格的状态用 `shared/botWorkbench.ts` 与主进程同一套规则推导。
 */
import { hasPendingSessionInterruption } from '@cindy/maker-shared/session-activity';

import type { Session } from '@/lib/ccAgent.types';
import { groupSessions } from '@/features/cc-agent/lib/projectGrouping';
import {
  boundWorkbenchSummary,
  deriveWorkbenchAutomationState,
  deriveWorkbenchSessionState,
  findWorkbenchProject,
  importedSessionOrigin,
  isWorkbenchTaskSource,
  workbenchProjectKey,
  workbenchStateRank,
  type WorkbenchDelegationStatus,
  type WorkbenchTaskOrigin,
  type WorkbenchTaskState,
} from '../../../shared/botWorkbench';

/** 活动快照里工作台用得到的字段(灵动岛 / 侧栏同源)。 */
export interface WorkbenchActivity {
  phase: string;
  startedAtMs?: number | null;
  currentActionSummary?: string | null;
  compactDetail?: string | null;
}

export interface WorkbenchDelegationInput {
  childSessionId: string | null;
  status: WorkbenchDelegationStatus;
  resultSummary: string | null;
  lastError: string | null;
  createdAt: number;
  acceptedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface WorkbenchScheduleInput {
  id: string;
  name: string;
  status: string;
  source?: string;
  workspaceKind?: string;
  workingDir?: string;
  manual?: boolean;
  cronExpr?: string;
  intervalMs?: number;
  nextFireAt?: number;
  lastFinishedAt?: number;
  updatedAt?: number;
}

export interface WorkbenchRoutineInput {
  id: string;
  name: string;
  enabled: boolean;
  activity?: 'queued' | 'running';
  triggers: Array<{ kind: string; expression?: string; intervalMs?: number; at?: number }>;
  updatedAt: number;
  lastRun?: { status: string; finishedAt?: number; createdAt: number; resultText?: string; error?: string } | null;
}

export interface ExternalSessionCandidate {
  source: 'claude' | 'codex';
  id: string;
  projectDir: string | null;
  updatedAt: string;
  archived: boolean;
}

/** 格子底部那一行说的是什么;具体文案由界面按语言拼。 */
export type WorkbenchTileLine =
  | { kind: 'action'; text: string }
  | { kind: 'waiting' }
  | { kind: 'queued' }
  | { kind: 'interrupted' }
  | { kind: 'errored' }
  | { kind: 'failed'; text: string | null }
  | { kind: 'summary'; text: string }
  | { kind: 'next'; at: number }
  | { kind: 'manual' }
  | { kind: 'paused' }
  | { kind: 'disabled' }
  | { kind: 'last-run'; ok: boolean; text: string | null }
  | { kind: 'never-run' }
  | { kind: 'none' };

export type WorkbenchTile =
  | {
      type: 'session';
      key: string;
      id: string;
      title: string;
      state: WorkbenchTaskState;
      origin: WorkbenchTaskOrigin;
      /** 在做时用来显示用时。 */
      startedAtMs: number | null;
      lastActiveMs: number;
      line: WorkbenchTileLine;
    }
  | {
      type: 'schedule';
      key: string;
      id: string;
      title: string;
      state: WorkbenchTaskState;
      schedule: Pick<WorkbenchScheduleInput, 'manual' | 'cronExpr' | 'intervalMs'>;
      startedAtMs: null;
      lastActiveMs: number;
      line: WorkbenchTileLine;
    }
  | {
      type: 'routine';
      key: string;
      id: string;
      title: string;
      state: WorkbenchTaskState;
      triggers: WorkbenchRoutineInput['triggers'];
      startedAtMs: null;
      lastActiveMs: number;
      line: WorkbenchTileLine;
    };

function toMs(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** 伙伴档案里投影出的全部伙伴 session(主任务、群专线、历史、伙伴间委派)。 */
export function collectBotHiddenSessionIds(
  profiles: ReadonlyArray<{ sessions: ReadonlyArray<{ id: string }> }>,
): Set<string> {
  const out = new Set<string>();
  for (const profile of profiles) for (const session of profile.sessions) if (session.id) out.add(session.id);
  return out;
}

/**
 * 能进工作台的本机任务:未归档删除、本机、普通来源、不是 Orca worker、不是伙伴的
 * 隐藏任务。草稿(从没发过消息)不算,伙伴刚开、还在排队的后台任务例外。
 */
export function isWorkbenchCandidateSession(
  session: Session,
  hiddenIds: ReadonlySet<string>,
  delegationChildIds: ReadonlySet<string> = new Set(),
): boolean {
  if (session.status !== 'active') return false;
  if (session.remoteHostId || session.deviceLinkDeviceId) return false;
  if (hiddenIds.has(session.id) || session.source === 'bot') return false;
  if (!isWorkbenchTaskSource(session.source) || session.orcaRole === 'worker') return false;
  if (!session.workingDir) return false;
  if (delegationChildIds.has(session.id)) return true;
  return session.userSendAt != null || (session._count?.messages ?? 0) > 0;
}

export interface WorkbenchProjectOption {
  /** 项目目录(用于记录与比较)。 */
  dir: string;
  name: string;
  taskCount: number;
  automationCount: number;
  /** 还没导入的本机 Claude Code / Codex 任务。 */
  claudeCount: number;
  codexCount: number;
  latestActivityMs: number;
  /** 目录下有 `.git`(主进程扫描时 stat 得出;未知时为 false)。 */
  isGitRepo: boolean;
}

/**
 * 空状态的项目清单:本机已有项目(任务列表同一套项目分组)+ 只在 Claude Code / Codex 里
 * 出现过的目录;每行给出任务数、自动化数与待导入数。已导入的外部任务由扫描方去重。
 */
export function buildWorkbenchProjectOptions(input: {
  sessions: readonly Session[];
  hiddenIds: ReadonlySet<string>;
  schedules: readonly WorkbenchScheduleInput[];
  candidates: readonly ExternalSessionCandidate[];
  /** 主进程扫描给出的 git 仓库目录。 */
  gitRepoDirs?: readonly string[];
  localPlatform: string;
  caseInsensitive: boolean;
  excludeDirs?: readonly string[];
}): WorkbenchProjectOption[] {
  const eligible = input.sessions.filter(
    (session) => session.workspaceKind !== 'dialogue' && isWorkbenchCandidateSession(session, input.hiddenIds),
  );
  const grouped = groupSessions(eligible, {
    includePinnedInProjects: true,
    localPlatform: input.localPlatform,
  });
  const byKey = new Map<string, WorkbenchProjectOption>();
  for (const project of grouped.projects) {
    if (project.scope !== 'local') continue;
    const key = workbenchProjectKey(project.workingDir, input.caseInsensitive);
    if (!key) continue;
    byKey.set(key, {
      dir: project.workingDir,
      name: project.displayName,
      taskCount: project.sessions.length,
      automationCount: 0,
      claudeCount: 0,
      codexCount: 0,
      latestActivityMs: toMs(project.latestActivityAt),
      isGitRepo: false,
    });
  }
  const ensure = (dir: string, key: string) => {
    let option = byKey.get(key);
    if (!option) {
      option = {
        dir,
        name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
        taskCount: 0,
        automationCount: 0,
        claudeCount: 0,
        codexCount: 0,
        latestActivityMs: 0,
        isGitRepo: false,
      };
      byKey.set(key, option);
    }
    return option;
  };
  for (const schedule of input.schedules) {
    if (schedule.source === 'bot' || schedule.workspaceKind === 'dialogue' || !schedule.workingDir) continue;
    const key = workbenchProjectKey(schedule.workingDir, input.caseInsensitive);
    if (!key) continue;
    const option = byKey.get(key);
    // 只有自动化、没有任何任务的目录不单独成行:自动化挂在已有项目上才有意义。
    if (option) option.automationCount += 1;
  }
  for (const candidate of input.candidates) {
    if (candidate.archived || !candidate.projectDir) continue;
    const key = workbenchProjectKey(candidate.projectDir, input.caseInsensitive);
    if (!key) continue;
    const option = ensure(candidate.projectDir, key);
    if (candidate.source === 'claude') option.claudeCount += 1;
    else option.codexCount += 1;
    option.latestActivityMs = Math.max(option.latestActivityMs, toMs(candidate.updatedAt));
  }
  for (const dir of input.gitRepoDirs ?? []) {
    const key = workbenchProjectKey(dir, input.caseInsensitive);
    const option = key ? byKey.get(key) : undefined;
    if (option) option.isGitRepo = true;
  }
  const excluded = new Set(
    (input.excludeDirs ?? [])
      .map((dir) => workbenchProjectKey(dir, input.caseInsensitive))
      .filter((key): key is string => Boolean(key)),
  );
  return [...byKey.entries()]
    .filter(([key, option]) => !excluded.has(key) && option.taskCount + option.claudeCount + option.codexCount > 0)
    .map(([, option]) => option)
    .sort((a, b) => b.latestActivityMs - a.latestActivityMs || a.name.localeCompare(b.name));
}

/** 选中的项目下,还没导入的 Claude Code / Codex 候选;按最近更新倒序,最多 `limit` 条。 */
export function pickImportCandidates(
  candidates: readonly ExternalSessionCandidate[],
  projectDir: string,
  caseInsensitive: boolean,
  limit: number,
): { picked: ExternalSessionCandidate[]; total: number } {
  const key = workbenchProjectKey(projectDir, caseInsensitive);
  const matching = candidates
    .filter((candidate) => !candidate.archived && candidate.projectDir)
    .filter((candidate) => workbenchProjectKey(candidate.projectDir, caseInsensitive) === key)
    .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
  return { picked: matching.slice(0, limit), total: matching.length };
}

function sessionLine(
  state: WorkbenchTaskState,
  session: Session,
  activity: WorkbenchActivity | null,
  delegation: WorkbenchDelegationInput | null,
  interrupted: boolean,
): WorkbenchTileLine {
  if (state === 'running') {
    const text = boundWorkbenchSummary(activity?.currentActionSummary ?? activity?.compactDetail);
    return text ? { kind: 'action', text } : { kind: 'none' };
  }
  if (state === 'waiting') return { kind: 'waiting' };
  if (state === 'queued') return { kind: 'queued' };
  if (state === 'stopped') {
    if (delegation && ['failed', 'timed-out', 'cancelled'].includes(delegation.status)) {
      return { kind: 'failed', text: boundWorkbenchSummary(delegation.resultSummary) };
    }
    return interrupted ? { kind: 'interrupted' } : { kind: 'errored' };
  }
  const text = boundWorkbenchSummary(delegation?.resultSummary ?? session.summary ?? session.preview);
  return text ? { kind: 'summary', text } : { kind: 'none' };
}

/**
 * 已接手项目的任务格:项目里的普通任务、伙伴开的后台任务(含排队)、项目里的自动化、
 * 伙伴自己的例行任务(含导入来的自动化)。排列见 `workbenchStateRank`。
 */
export function buildWorkbenchTiles(input: {
  sessions: readonly Session[];
  hiddenIds: ReadonlySet<string>;
  projectDirs: readonly string[];
  caseInsensitive: boolean;
  delegations: readonly WorkbenchDelegationInput[];
  activity: ReadonlyMap<string, WorkbenchActivity>;
  erroredIds: ReadonlySet<string>;
  schedules: readonly WorkbenchScheduleInput[];
  routines: readonly WorkbenchRoutineInput[];
}): WorkbenchTile[] {
  const delegationByChild = new Map<string, WorkbenchDelegationInput>();
  for (const delegation of [...input.delegations].sort((a, b) => b.createdAt - a.createdAt)) {
    if (delegation.childSessionId && !delegationByChild.has(delegation.childSessionId)) {
      delegationByChild.set(delegation.childSessionId, delegation);
    }
  }
  const delegationChildIds = new Set(delegationByChild.keys());
  const tiles: WorkbenchTile[] = [];

  for (const session of input.sessions) {
    if (!isWorkbenchCandidateSession(session, input.hiddenIds, delegationChildIds)) continue;
    if (!findWorkbenchProject(session.workingDir, input.projectDirs, input.caseInsensitive)) continue;
    const delegation = delegationByChild.get(session.id) ?? null;
    const activity = input.activity.get(session.id) ?? null;
    const interrupted = hasPendingSessionInterruption(session);
    const state = deriveWorkbenchSessionState({
      activityPhase: activity?.phase ?? null,
      interrupted,
      errored: input.erroredIds.has(session.id),
      delegationStatus: delegation?.status ?? null,
    });
    tiles.push({
      type: 'session',
      key: `session:${session.id}`,
      id: session.id,
      title: session.title,
      state,
      origin: delegation ? 'delegated' : (importedSessionOrigin(session.id, session.agentKind) ?? 'existing'),
      startedAtMs: state === 'running'
        ? (activity?.startedAtMs ?? delegation?.acceptedAt ?? null)
        : null,
      lastActiveMs: Math.max(toMs(session.userSendAt), toMs(session.updatedAt), delegation?.updatedAt ?? 0),
      line: sessionLine(state, session, activity, delegation, interrupted),
    });
  }

  for (const schedule of input.schedules) {
    if (schedule.source === 'bot' || schedule.workspaceKind === 'dialogue') continue;
    if (!findWorkbenchProject(schedule.workingDir, input.projectDirs, input.caseInsensitive)) continue;
    const enabled = schedule.status === 'active';
    const state = deriveWorkbenchAutomationState({ enabled });
    tiles.push({
      type: 'schedule',
      key: `schedule:${schedule.id}`,
      id: schedule.id,
      title: schedule.name,
      state,
      schedule: { manual: schedule.manual, cronExpr: schedule.cronExpr, intervalMs: schedule.intervalMs },
      startedAtMs: null,
      lastActiveMs: Math.max(schedule.lastFinishedAt ?? 0, schedule.updatedAt ?? 0),
      line: !enabled
        ? { kind: 'paused' }
        : schedule.manual
          ? { kind: 'manual' }
          : schedule.nextFireAt
            ? { kind: 'next', at: schedule.nextFireAt }
            : { kind: 'none' },
    });
  }

  for (const routine of input.routines) {
    const state = deriveWorkbenchAutomationState({
      enabled: routine.enabled,
      running: routine.activity === 'running',
      queued: routine.activity === 'queued',
    });
    const last = routine.lastRun ?? null;
    tiles.push({
      type: 'routine',
      key: `routine:${routine.id}`,
      id: routine.id,
      title: routine.name,
      state,
      triggers: routine.triggers,
      startedAtMs: null,
      lastActiveMs: Math.max(last?.finishedAt ?? last?.createdAt ?? 0, routine.updatedAt),
      line: state === 'running'
        ? { kind: 'none' }
        : state === 'queued'
          ? { kind: 'queued' }
          : !routine.enabled
            ? { kind: 'disabled' }
            : last
              ? {
                  kind: 'last-run',
                  ok: last.status === 'success' || last.status === 'skipped',
                  text: boundWorkbenchSummary(last.resultText ?? last.error),
                }
              : { kind: 'never-run' },
    });
  }

  return tiles.sort(
    (a, b) => workbenchStateRank(a.state) - workbenchStateRank(b.state) || b.lastActiveMs - a.lastActiveMs,
  );
}

// ─── 空状态项目清单的过滤与分档 ─────────────────────────────────────

/** 主进程给的本机路径(主目录、应用数据目录、系统临时目录);拿不到时为 null。 */
export interface WorkbenchPathHints {
  homeDir: string | null;
  userDataDir: string | null;
  tempDirs: readonly string[];
}

/** 主目录下的工具 / 缓存目录:这些目录里的会话不是用户的项目。 */
const HOME_TOOL_DIRS = [
  'Library/Caches',
  'Library/Application Support/Cindy',
  '.cache',
  '.codex',
  '.claude',
  '.cindy',
  '.cursor',
  '.npm',
  '.Trash',
];
const SYSTEM_TEMP_DIRS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];
/** 主进程路径没送到时的兜底:按常见主目录形态识别。 */
const HOME_DIR_PATTERN = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[a-z]:\/users\/[^/]+)$/i;

function isSameOrUnder(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root.endsWith('/') ? root.slice(0, -1) : root}/`);
}

/** 主目录本身、Cindy 的应用数据目录(含各伙伴 Home 的 workspace)、系统与工具的临时 / 缓存目录。 */
export function isNonProjectDir(
  dir: string,
  hints: WorkbenchPathHints | null,
  caseInsensitive: boolean,
): boolean {
  const key = workbenchProjectKey(dir, caseInsensitive);
  if (!key) return true;
  const norm = (value: string | null | undefined) => workbenchProjectKey(value, caseInsensitive);
  const homes = new Set<string>();
  const hintedHome = norm(hints?.homeDir);
  if (hintedHome) homes.add(hintedHome);
  const inferredHome = /^(\/Users\/[^/]+|\/home\/[^/]+|[a-z]:\/users\/[^/]+)(?:\/|$)/i.exec(key)?.[1];
  if (inferredHome) homes.add(inferredHome);
  if (hintedHome === key || HOME_DIR_PATTERN.test(key)) return true;
  const roots: string[] = [...SYSTEM_TEMP_DIRS.map((root) => norm(root) ?? root)];
  for (const temp of hints?.tempDirs ?? []) {
    const value = norm(temp);
    if (value) roots.push(value);
  }
  const userData = norm(hints?.userDataDir);
  if (userData) roots.push(userData);
  for (const home of homes) {
    for (const sub of HOME_TOOL_DIRS) {
      const value = norm(`${home}/${sub}`);
      if (value) roots.push(value);
    }
  }
  return roots.some((root) => isSameOrUnder(key, root));
}

/**
 * 目录名像自动生成的 id:UUID、长十六进制串、`cli_<hex>`、`<word>-<长数字>`,
 * 或者名字大部分是十六进制与连字符且夹着数字。
 */
export function looksGeneratedDirName(name: string): boolean {
  const base = name.trim().toLowerCase();
  if (!base) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(base)) return true;
  if (/^[0-9a-f]{12,}$/.test(base)) return true;
  if (/^[a-z]+_[0-9a-f]{8,}$/.test(base)) return true;
  if (/^[a-z]+-\d{6,}$/.test(base)) return true;
  const hexish = [...base].filter((char) => /[0-9a-f-]/.test(char)).length;
  const digits = [...base].filter((char) => /\d/.test(char)).length;
  return base.length >= 10 && digits >= 3 && hexish / base.length >= 0.8;
}

export const WORKBENCH_PRIMARY_PROJECTS = 5;
const STALE_SINGLE_SESSION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 项目清单分档(纯函数,确定性):
 * 1. 直接不列:`isNonProjectDir`;
 * 2. 折叠:名字像生成的 id;只有 1 个会话且 14 天没动;
 * 3. 第一档:git 仓库、Cindy 里已有任务或自动化、会话总数 ≥ 3;
 * 4. 其余折叠。第一档按最近活动倒序最多 5 行,多出的并入折叠;折叠同样按最近活动倒序。
 */
export function tierWorkbenchProjectOptions(
  options: readonly WorkbenchProjectOption[],
  input: { hints: WorkbenchPathHints | null; caseInsensitive: boolean; now: number; maxPrimary?: number },
): { primary: WorkbenchProjectOption[]; folded: WorkbenchProjectOption[] } {
  const byRecency = (a: WorkbenchProjectOption, b: WorkbenchProjectOption) =>
    b.latestActivityMs - a.latestActivityMs || a.name.localeCompare(b.name);
  const primary: WorkbenchProjectOption[] = [];
  const folded: WorkbenchProjectOption[] = [];
  for (const option of options) {
    if (isNonProjectDir(option.dir, input.hints, input.caseInsensitive)) continue;
    const total = option.taskCount + option.claudeCount + option.codexCount;
    const name = option.dir.split(/[\\/]/).filter(Boolean).pop() ?? option.name;
    const staleSingle = total <= 1 && input.now - option.latestActivityMs > STALE_SINGLE_SESSION_MS;
    if (looksGeneratedDirName(name) || staleSingle) {
      folded.push(option);
    } else if (option.isGitRepo || option.taskCount > 0 || option.automationCount > 0 || total >= 3) {
      primary.push(option);
    } else {
      folded.push(option);
    }
  }
  primary.sort(byRecency);
  const max = input.maxPrimary ?? WORKBENCH_PRIMARY_PROJECTS;
  return { primary: primary.slice(0, max), folded: [...primary.slice(max), ...folded].sort(byRecency) };
}
