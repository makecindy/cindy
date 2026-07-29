/**
 * workflowProgressModel —— workflow 进度双数据源 → 渲染模型的合并层(纯函数)。
 *
 * 双源:
 * - entries:`agent_task_update` 事件流上的 workflowProgress(实时、进程内存,重载后丢失);
 * - fileProgress:main 侧 wf 记录文件 reader 的结果(重载后仍可读;远程会话 / 老被控端
 *   降级为 null)。
 *
 * 合并约束(本层唯一职责,UI 层不再做任何数据修正):
 * - entries 在场 → 主结构一律来自 entries,file 只做补缺(logs、phase detail、任务终态
 *   后缺失的 resultPreview / durationMs / error);
 * - entries 缺失(重载后)→ 整树退回 fileProgress;
 * - 两套 state 词表(事件流 start/progress/done/error;文件 queued/running/done/failed/
 *   stopped/killed)一律原样透传,只在任务已终态而 agent 仍呈非终态时置 'error'
 *   (error 文案留空,由 UI 层用 i18n 兜底,本层不写死文案);
 * - 本层不做 i18n、不做格式化,只输出结构化数据。
 */

import type { WorkflowProgressEntry } from '@cindy/maker-shared/agent-task';

import type { AgentTaskStatus } from '@/lib/makerChatStore';

import type {
  WorkflowAgentProgress,
  WorkflowProgress,
} from '../../../../../shared/workflow-progress';

export interface WorkflowTreeAgentRow {
  /** 渲染 key:agentId 优先,缺失时用条目序号兜底(同一次构建内稳定唯一)。 */
  key: string;
  label: string;
  /** 原样透传的运行状态(两套词表任一;终态修正后可能为 'error')。 */
  state: string;
  model?: string;
  attempt?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;
  durationMs?: number;
  error?: string;
}

export interface WorkflowTreeGroup {
  /** phase 标题;不归属任何 phase 的 agent 收进末尾 title=null 组。 */
  title: string | null;
  /** phase 说明(仅 wf 文件有,按 title 回填)。 */
  detail?: string;
  agents: WorkflowTreeAgentRow[];
}

export interface WorkflowTreeModel {
  aggregate: {
    agentCount?: number;
    status: string;
    totalTokens?: number;
    totalToolCalls?: number;
    durationMs?: number;
  };
  /** 脚本 log() 叙述行(仅 wf 文件有;无文件时为空数组)。 */
  logs: string[];
  groups: WorkflowTreeGroup[];
}

/** 任务级终态(AgentTaskStatus 词表)。 */
const TERMINAL_TASK_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  'completed',
  'failed',
  'stopped',
]);

/**
 * 任务终态后必须修正为 'error' 的 agent state(两套词表里的"仍在进行/等待"状态)。
 * 终态任务不可能再推进这些行;不修正会永远转圈。
 */
const CORRECTABLE_AGENT_STATES: ReadonlySet<string> = new Set([
  'start',
  'progress',
  'running',
  'queued',
  'pending',
]);

/** wf 文件顶层 status 的终态词表:命中时文件结论优先于 taskStatus。 */
const TERMINAL_FILE_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'stopped',
  'killed',
  'done',
  'error',
]);

/**
 * wf 文件快照是否已收口(顶层 status 命中终态词表)。任务终态而文件仍非终态 =
 * 终局数据尚未刷完盘,调用方(详情视图)据此安排有界重试。
 */
export function isTerminalWorkflowFileStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_FILE_STATUSES.has(status);
}

/**
 * wf 文件顶层 status → 任务状态词表(仅终态;running/queued 等非终态返回 null,
 * 调用方保持现状不覆盖)。面板历史行状态修正与聊天 workflow 卡共用 ——
 * 「启动回执存在就断言 completed」对 failed/stopped 是假绿,文件终态才是权威。
 */
export function fileStatusToTaskStatus(
  status: string | undefined,
): 'completed' | 'failed' | 'stopped' | null {
  if (status === 'done' || status === 'completed') return 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'stopped' || status === 'killed') return 'stopped';
  return null;
}

export function buildWorkflowTreeModel(input: {
  entries?: readonly WorkflowProgressEntry[];
  fileProgress?: WorkflowProgress | null;
  taskStatus: AgentTaskStatus;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
}): WorkflowTreeModel | null {
  const { entries, fileProgress, taskStatus, usage } = input;
  const hasEntries = Array.isArray(entries) && entries.length > 0;
  const file = fileProgress ?? null;
  // 两源都空 → 没有任何可展示的进度,交给调用方回退到 workflow 级卡片信息。
  if (!hasEntries && !file) return null;

  // 终态判定与 aggregate.status 同源:device-link 掉线可能丢终态任务通知
  // (taskStatus 停在 running),此时文件终态一样要触发回填与终态修正 ——
  // 否则头部显示 done 而行还在转圈。
  const isTerminal =
    TERMINAL_TASK_STATUSES.has(taskStatus) || isTerminalWorkflowFileStatus(file?.status);
  const groups = hasEntries
    ? groupsFromEntries(entries, file, isTerminal)
    : groupsFromFile(file!);

  if (isTerminal) {
    for (const group of groups) {
      for (const row of group.agents) {
        if (CORRECTABLE_AGENT_STATES.has(row.state)) {
          // error 字段留空:兜底文案由 UI 层 i18n 提供,本层不写死。
          row.state = 'error';
        }
      }
    }
  }

  const agentRowCount = groups.reduce((n, g) => n + g.agents.length, 0);
  const fileStatus = file?.status;
  return {
    aggregate: {
      // 两源取大:运行期文件快照可能滞后(agentCount 还是 0 而实时行已 spawn),
      // 不得让陈旧文件值盖过可见行数;终态时文件计数 ≥ 行数(条目截断),取大同样对。
      agentCount:
        file?.agentCount !== undefined
          ? Math.max(file.agentCount, agentRowCount)
          : agentRowCount,
      // 文件已有终态结论时以文件为准(词表更细,如 killed);否则跟随任务状态。
      status:
        fileStatus !== undefined && TERMINAL_FILE_STATUSES.has(fileStatus)
          ? fileStatus
          : taskStatus,
      totalTokens: file?.totalTokens ?? usage?.totalTokens,
      totalToolCalls: file?.totalToolCalls ?? usage?.toolUses,
      durationMs: file?.durationMs ?? usage?.durationMs,
    },
    logs: file?.logs ?? [],
    groups,
  };
}

/**
 * entries 主结构:workflow_phase 条目出现顺序定 phase 顺序(同名只保留首个),
 * workflow_agent 按 phaseTitle 归组;不属于任何 phase 的进末尾 title=null 组。
 * 分组口径:没有 agent 的 phase 不产出分组。
 */
function groupsFromEntries(
  entries: readonly WorkflowProgressEntry[],
  file: WorkflowProgress | null,
  backfillTerminal: boolean,
): WorkflowTreeGroup[] {
  const detailByTitle = collectPhaseDetails(file);
  const byPhase = new Map<string, WorkflowTreeAgentRow[]>();
  const titleByPhaseIndex = new Map<number, string>();
  for (const entry of entries) {
    if (entry.type !== 'workflow_phase' || !entry.title) continue;
    if (!byPhase.has(entry.title)) byPhase.set(entry.title, []);
    if (typeof entry.index === 'number' && !titleByPhaseIndex.has(entry.index)) {
      titleByPhaseIndex.set(entry.index, entry.title);
    }
  }
  const orphans: WorkflowTreeAgentRow[] = [];
  // 回填索引一次性预建:条目上限 2000,逐行线性扫 file.agents 是 O(n²),大编队
  // 打开详情会卡帧。
  const fileAgentIndex = backfillTerminal && file ? indexFileAgents(file) : null;
  let agentOrdinal = 0;
  for (const entry of entries) {
    if (entry.type !== 'workflow_agent') continue;
    const row = rowFromEntry(entry, agentOrdinal);
    agentOrdinal += 1;
    // 归属解析:phaseTitle 直取;只带 phaseIndex 的条目(CLI 两种形态都真实存在)
    // 经 workflow_phase 的 index→title 映射解析,不得整组坠入孤儿区。
    const phaseTitle =
      entry.phaseTitle ??
      (typeof entry.phaseIndex === 'number' ? titleByPhaseIndex.get(entry.phaseIndex) : undefined);
    // 事件流收尾帧可能缺 resultPreview/durationMs/error(节流或提前断流);任务终态时
    // 从文件回填(agentId 精确优先、label+phaseTitle 兜底);只补缺,绝不覆盖 entries 已有值。
    if (fileAgentIndex) backfillRowFromFile(row, entry.agentId, phaseTitle, fileAgentIndex);
    if (phaseTitle && byPhase.has(phaseTitle)) {
      byPhase.get(phaseTitle)!.push(row);
    } else {
      orphans.push(row);
    }
  }
  return assembleGroups(byPhase, orphans, detailByTitle);
}

/** 文件 agent 的有效 phase 标题:phaseTitle 直取;只带 phaseIndex 的排队行
 *  (与事件流同形态)经顶层 phases[] 的 index→title 反查,不坠入孤儿区。 */
function resolveFilePhaseTitle(
  agent: WorkflowAgentProgress,
  titleByIndex: ReadonlyMap<number, string>,
): string | undefined {
  return (
    agent.phaseTitle ??
    (typeof agent.phaseIndex === 'number' ? titleByIndex.get(agent.phaseIndex) : undefined)
  );
}

function collectFilePhaseTitlesByIndex(file: WorkflowProgress): Map<number, string> {
  const titleByIndex = new Map<number, string>();
  for (const phase of file.phases) {
    if (!titleByIndex.has(phase.index)) titleByIndex.set(phase.index, phase.title);
  }
  return titleByIndex;
}

/** entries 缺失(重载后)整树退回 wf 文件;文件 state 词表原样保留。 */
function groupsFromFile(file: WorkflowProgress): WorkflowTreeGroup[] {
  const detailByTitle = collectPhaseDetails(file);
  const titleByIndex = collectFilePhaseTitlesByIndex(file);
  const byPhase = new Map<string, WorkflowTreeAgentRow[]>();
  for (const phase of file.phases) {
    if (!byPhase.has(phase.title)) byPhase.set(phase.title, []);
  }
  const orphans: WorkflowTreeAgentRow[] = [];
  file.agents.forEach((agent, index) => {
    const row = rowFromFileAgent(agent, index);
    const phaseTitle = resolveFilePhaseTitle(agent, titleByIndex);
    if (phaseTitle && byPhase.has(phaseTitle)) {
      byPhase.get(phaseTitle)!.push(row);
    } else {
      orphans.push(row);
    }
  });
  return assembleGroups(byPhase, orphans, detailByTitle);
}

/** phase detail 只存在于 wf 文件顶层 phases[],按 title 建索引(同名取首个)。 */
function collectPhaseDetails(file: WorkflowProgress | null): Map<string, string> {
  const detailByTitle = new Map<string, string>();
  if (!file) return detailByTitle;
  for (const phase of file.phases) {
    if (phase.detail && !detailByTitle.has(phase.title)) {
      detailByTitle.set(phase.title, phase.detail);
    }
  }
  return detailByTitle;
}

function assembleGroups(
  byPhase: ReadonlyMap<string, WorkflowTreeAgentRow[]>,
  orphans: WorkflowTreeAgentRow[],
  detailByTitle: ReadonlyMap<string, string>,
): WorkflowTreeGroup[] {
  const out: WorkflowTreeGroup[] = [];
  for (const [title, agents] of byPhase) {
    if (agents.length === 0) continue;
    const detail = detailByTitle.get(title);
    out.push({ title, ...(detail !== undefined ? { detail } : {}), agents });
  }
  if (orphans.length > 0) out.push({ title: null, agents: orphans });
  return out;
}

/**
 * 事件条目 → agent 行。字段直接取条目;durationMs 事件流不携带,只能靠终态回填。
 * state 缺失按 'queued' 处理(条目尚未开跑时事件可能不带 state)。
 */
function rowFromEntry(entry: WorkflowProgressEntry, ordinal: number): WorkflowTreeAgentRow {
  return {
    key: entry.agentId ?? `entry-${ordinal}`,
    label: entry.label ?? entry.agentId ?? `#${entry.index}`,
    state: entry.state ?? 'queued',
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
    ...(entry.lastToolName !== undefined ? { lastToolName: entry.lastToolName } : {}),
    ...(entry.lastToolSummary !== undefined ? { lastToolSummary: entry.lastToolSummary } : {}),
    ...(entry.resultPreview !== undefined ? { resultPreview: entry.resultPreview } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  };
}

function rowFromFileAgent(agent: WorkflowAgentProgress, index: number): WorkflowTreeAgentRow {
  return {
    key: agent.agentId || `file-${index}`,
    label: agent.label,
    state: agent.state,
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.attempt !== undefined ? { attempt: agent.attempt } : {}),
    ...(agent.lastToolName !== undefined ? { lastToolName: agent.lastToolName } : {}),
    ...(agent.lastToolSummary !== undefined ? { lastToolSummary: agent.lastToolSummary } : {}),
    ...(agent.resultPreview !== undefined ? { resultPreview: agent.resultPreview } : {}),
    ...(agent.durationMs !== undefined ? { durationMs: agent.durationMs } : {}),
    ...(agent.error !== undefined ? { error: agent.error } : {}),
  };
}

/** label+phaseTitle → 文件 agent 的回填索引 key(reader 已把空串归 undefined,
 *  '\0' 分隔不会与 label 内容撞车)。 */
function fileAgentKey(label: string, phaseTitle: string | undefined): string {
  return `${label}\u0000${phaseTitle ?? ''}`;
}

/** 回填索引:agentId 精确匹配优先(两源 agentId 同出 CLI runtime,天然同源);
 *  label+phaseTitle 兜底撞名取首个,与原线性 find 的命中语义一致。 */
interface FileAgentIndex {
  byAgentId: Map<string, WorkflowAgentProgress>;
  byLabelPhase: Map<string, WorkflowAgentProgress>;
}

function indexFileAgents(file: WorkflowProgress): FileAgentIndex {
  const byAgentId = new Map<string, WorkflowAgentProgress>();
  const byLabelPhase = new Map<string, WorkflowAgentProgress>();
  // label 键用**解析后的**有效 title(phaseIndex 反查),与事件行解析口径对齐 ——
  // 否则文件里只带 phaseIndex 的行 key 落空串,永远匹配不上事件行。
  const titleByIndex = collectFilePhaseTitlesByIndex(file);
  for (const agent of file.agents) {
    if (agent.agentId && !byAgentId.has(agent.agentId)) byAgentId.set(agent.agentId, agent);
    const key = fileAgentKey(agent.label, resolveFilePhaseTitle(agent, titleByIndex));
    if (!byLabelPhase.has(key)) byLabelPhase.set(key, agent);
  }
  return { byAgentId, byLabelPhase };
}

/**
 * 终态补缺:按 label+phaseTitle 匹配文件 agent(撞名取首个),只填 entries 缺失的
 * 字段。唯一例外是 state:事件流断在非终态(节流丢了收尾帧)而文件已有终态结论时,
 * 采纳文件终态 —— 否则后续的整树终态修正会把实际成功的 agent 误标成 error。
 */
function backfillRowFromFile(
  row: WorkflowTreeAgentRow,
  agentId: string | undefined,
  phaseTitle: string | undefined,
  fileAgentIndex: FileAgentIndex,
): void {
  // agentId 命中即精确行;同 phase 撞 label 的多 agent(parallel 同 prompt 编队)
  // 靠它区分,label 键只服务缺 agentId 的降级形态。
  const match =
    (agentId ? fileAgentIndex.byAgentId.get(agentId) : undefined) ??
    fileAgentIndex.byLabelPhase.get(fileAgentKey(row.label, phaseTitle));
  if (!match) return;
  if (
    CORRECTABLE_AGENT_STATES.has(row.state) &&
    typeof match.state === 'string' &&
    match.state.length > 0 &&
    !CORRECTABLE_AGENT_STATES.has(match.state)
  ) {
    row.state = match.state;
  }
  if (row.resultPreview === undefined && match.resultPreview !== undefined) {
    row.resultPreview = match.resultPreview;
  }
  if (row.durationMs === undefined && match.durationMs !== undefined) {
    row.durationMs = match.durationMs;
  }
  if (row.error === undefined && match.error !== undefined) {
    row.error = match.error;
  }
}

// ── agent 状态的视觉归一(方块条 / 计数共用) ─────────────────────────────────

/** 方块条四色视觉态。 */
export type WorkflowAgentVisualState = 'done' | 'running' | 'failed' | 'queued';

/**
 * 把两套状态词表(事件流 start/progress/done/error;wf 文件 queued/running/done/
 * failed/stopped/killed)归一成方块条四色。未知词按 queued(中性灰)处理 ——
 * 词表无契约,宁可少染色不可误染色;'start' 对齐官方 CLI 语义(已入队未跑,灰)。
 */
export function workflowAgentVisualState(state: string | undefined): WorkflowAgentVisualState {
  switch (state) {
    case 'done':
    case 'completed':
      return 'done';
    case 'running':
    case 'progress':
      return 'running';
    case 'error':
    case 'failed':
    case 'stopped':
    case 'killed':
      return 'failed';
    default:
      return 'queued';
  }
}
