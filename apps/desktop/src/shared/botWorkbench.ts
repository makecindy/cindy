/**
 * 伙伴工作台:主进程与渲染层共用的数据形状与纯推导。
 *
 * 工作台上的每一格都是一件任务(自动化也是任务的一种)。格子的状态只从宿主已有的
 * 真实信号推导——运行中、等待交互、上一轮出错或被打断、后台任务状态、自动化的启停
 * 与运行——不经过模型,也不另存一份状态。主进程(伙伴读取工作台的工具)和渲染层
 * (右侧栏的任务格)共用这里的同一套规则,两边说法一致。
 */
import { normalizeWorkingDirForGrouping } from './workingDir';

/** 主人最多交给一个伙伴几个项目;与存储层的上限同源。 */
export const BOT_WORKBENCH_MAX_DIRECTORIES = 6;

/** 主人交给伙伴的项目目录。目录本身由宿主记录,`exists` 是读取时现查的事实。 */
export interface BotWorkbenchDirectory {
  path: string;
  name: string;
  addedAt: string;
  exists: boolean;
}

export interface BotWorkbench {
  directories: BotWorkbenchDirectory[];
}

/** 一格任务的状态。`automation` 表示一条正常待命的自动化(下次运行 / 上次结果)。 */
export type WorkbenchTaskState = 'running' | 'waiting' | 'queued' | 'stopped' | 'automation' | 'done';

/** 一格任务从哪里来:原有任务、伙伴替主人开的后台任务。 */
export type WorkbenchTaskOrigin = 'existing' | 'delegated';

export type WorkbenchDelegationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

/**
 * 推导一件普通任务状态所需的信号。全部来自宿主已有状态:
 * - `activityPhase`:与侧栏、灵动岛同源的活动快照 phase(running / needs-interaction /
 *   completed / error / idle),没有快照时为 null;
 * - `interrupted`:上一轮开始后没有结束记录(应用退出等打断),见
 *   `hasPendingSessionInterruption`;
 * - `errored`:上一轮以错误结束且主人还没处理(侧栏的红点、主进程的终态错误行);
 * - `delegationStatus`:这件任务是伙伴开的后台任务时,后台任务自己的状态。
 */
export interface WorkbenchSessionSignals {
  activityPhase?: string | null;
  interrupted?: boolean;
  errored?: boolean;
  delegationStatus?: WorkbenchDelegationStatus | null;
}

/**
 * 普通任务的状态。优先级:排队 > 等你 > 在做 > 停着 > 做完。
 *
 * 「停着」只在有可靠信号时给:上一轮被打断、上一轮出错未处理,或伙伴开的后台任务
 * 以失败 / 超时 / 取消收尾。其余没有在跑、也没有在等的任务一律算「做完」——宿主
 * 无法可靠判断一件空闲的任务是否"还差一点",不猜。
 */
export function deriveWorkbenchSessionState(signals: WorkbenchSessionSignals): WorkbenchTaskState {
  const delegation = signals.delegationStatus ?? null;
  const phase = signals.activityPhase ?? null;
  if (delegation === 'queued') return 'queued';
  if (delegation === 'waiting' || phase === 'needs-interaction') return 'waiting';
  if (delegation === 'running' || phase === 'running') return 'running';
  if (
    signals.interrupted === true ||
    signals.errored === true ||
    phase === 'error' ||
    delegation === 'failed' ||
    delegation === 'timed-out' ||
    delegation === 'cancelled'
  ) {
    return 'stopped';
  }
  return 'done';
}

export interface WorkbenchAutomationSignals {
  /** 自动化是否启用(伙伴例行任务的 enabled / 普通自动化的 status === 'active')。 */
  enabled: boolean;
  running?: boolean;
  queued?: boolean;
}

/** 自动化的状态:正在跑 > 排队 > 停用(停着) > 正常待命。 */
export function deriveWorkbenchAutomationState(signals: WorkbenchAutomationSignals): WorkbenchTaskState {
  if (signals.running) return 'running';
  if (signals.queued) return 'queued';
  if (!signals.enabled) return 'stopped';
  return 'automation';
}

/** 汇总行与工具摘要的展示顺序;只列非零项。 */
export const WORKBENCH_STATE_ORDER: readonly WorkbenchTaskState[] = [
  'running',
  'waiting',
  'queued',
  'stopped',
  'automation',
  'done',
];

export function countWorkbenchStates(
  states: Iterable<WorkbenchTaskState>,
): Record<WorkbenchTaskState, number> {
  const counts: Record<WorkbenchTaskState, number> = {
    running: 0,
    waiting: 0,
    queued: 0,
    stopped: 0,
    automation: 0,
    done: 0,
  };
  for (const state of states) counts[state] += 1;
  return counts;
}

/**
 * 任务格的排列:需要主人看一眼或还在推进的(在做 / 等你 / 排队 / 停着)在前,
 * 其次是自动化,做完的在最后;同一档内由调用方按最近活动倒序。
 */
export function workbenchStateRank(state: WorkbenchTaskState): number {
  if (state === 'automation') return 1;
  if (state === 'done') return 2;
  return 0;
}

/**
 * 项目身份键:与任务列表的项目分组同一套归一(worktree 归到主仓库、去尾斜杠),
 * Windows 本机路径忽略大小写。只用于比较,不用于读写文件。
 */
export function workbenchProjectKey(
  dir: string | null | undefined,
  caseInsensitive: boolean,
): string | null {
  const normalized = normalizeWorkingDirForGrouping(dir);
  if (!normalized) return null;
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/** 找出这个工作目录属于哪个已接手的项目;不属于任何一个时返回 null。 */
export function findWorkbenchProject(
  workingDir: string | null | undefined,
  projectDirs: readonly string[],
  caseInsensitive: boolean,
): string | null {
  const key = workbenchProjectKey(workingDir, caseInsensitive);
  if (!key) return null;
  return projectDirs.find((dir) => workbenchProjectKey(dir, caseInsensitive) === key) ?? null;
}

/** Windows 本机路径不区分大小写;与 `projectKeyComparisonKey` 的口径一致。 */
export function isCaseInsensitivePlatform(platform: string | null | undefined): boolean {
  return platform === 'win32';
}

/**
 * 能作为工作台任务的会话来源。只认主人自己在项目里开的任务(含插件为项目建的任务)。自动化的每次运行由自动化那一格代表,
 * IM 渠道、学习、评审、伙伴自身等来源都不是"项目里的任务"。缺失按 desktop 兼容旧行。
 */
export function isWorkbenchTaskSource(source: string | null | undefined): boolean {
  return source == null || source === 'desktop' || source === 'plugin';
}

/** 一句摘要的长度上限:格子底部一行、工具返回给伙伴的摘要都用它。 */
export const WORKBENCH_SUMMARY_MAX_CHARS = 160;

export function boundWorkbenchSummary(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > WORKBENCH_SUMMARY_MAX_CHARS
    ? `${flat.slice(0, WORKBENCH_SUMMARY_MAX_CHARS - 1)}…`
    : flat;
}
