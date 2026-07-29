/**
 * Workflow 进度树的跨进程类型契约(main reader ↔ IPC ↔ renderer 卡片共用)。
 *
 * 数据来源是 Claude Code 的 workflow 运行记录 `wf_*.json`(见
 * `apps/desktop/src/main/workflow-progress/reader.ts`)。该文件是 SDK 内部产物、无公开
 * 契约,故 reader 全程防御式解析;这里的类型只承诺 reader 成功解析后的稳定形状。
 */

/** 单个子 agent 的进度(workflowProgress[type=workflow_agent])。 */
export interface WorkflowAgentProgress {
  /** 脚本里 agent() 的 label(如 "search:ai-tech");缺失时回退 agentId。 */
  label: string;
  /** 运行时 agent id;排队中尚未分配时缺失(与事件流 workflow_agent 同语义)。 */
  agentId?: string;
  /** 该 agent 实际跑的模型 raw id(如 claude-opus-4-8[1m])。 */
  model?: string;
  /** 运行时原始状态:queued / running / done / failed / stopped 等(原样透传)。 */
  state: string;
  /** 所属 phase 标题。 */
  phaseTitle?: string;
  /** 所属 phase 序号(条目可能只带 index 不带 title,经顶层 phases[] 反查)。 */
  phaseIndex?: number;
  /** 重试次数(≥1)。 */
  attempt?: number;
  /** 最近一次工具调用的工具名(如 "Read")。 */
  lastToolName?: string;
  /** 最近一次工具调用的一行摘要(如文件路径;reader 截断 ≤160)。 */
  lastToolSummary?: string;
  /** 完成后的结果预览(reader 截断 ≤300)。 */
  resultPreview?: string;
  /** 该 agent 的运行时长(毫秒)。 */
  durationMs?: number;
  /** 失败时的错误文本(reader 截断 ≤300)。 */
  error?: string;
}

/** workflow 的一个阶段。 */
export interface WorkflowPhaseProgress {
  index: number;
  title: string;
  /** phase 说明文字(仅存在于记录顶层 phases[],按 title 回填;截断 ≤200)。 */
  detail?: string;
}

/** 一次 workflow 运行的聚合进度树。 */
export interface WorkflowProgress {
  runId: string;
  workflowName?: string;
  /** 运行时原始状态:running / completed / failed 等(原样透传)。 */
  status: string;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  durationMs?: number;
  /** 脚本 log() 的叙述行(保留最后 50 条、每条截断 ≤300;记录文件独有)。 */
  logs?: string[];
  phases: WorkflowPhaseProgress[];
  agents: WorkflowAgentProgress[];
}
