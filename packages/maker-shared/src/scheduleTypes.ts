export type RemoteScheduleStatus = 'active' | 'paused' | 'expired';
export type RemoteScheduleAgentKind = 'claude-code' | 'codex';
export type RemoteScheduleWorkspaceKind = 'project' | 'dialogue';
export type RemoteScheduleRunStatus = 'running' | 'success' | 'failed' | 'aborted' | 'interrupted' | 'skipped';
export type RemoteScheduleExecutionMode = 'agent' | 'script';

export type RemoteTimestamp = number | string | null | undefined;

export interface RemoteScheduleNotifyConfig {
  desktop?: boolean;
  feishu?: boolean;
}

export interface RemoteScheduleWriteInput {
  name: string;
  prompt: string;
  kind: 'cron';
  cronExpr: string;
  timezone: string;
  recurring: boolean;
  manual?: boolean;
  intervalMs?: number;
  agentKind: RemoteScheduleAgentKind;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  workspaceKind?: RemoteScheduleWorkspaceKind;
  workingDir?: string;
  useWorktree: boolean;
  targetSessionId?: string;
  persistentSession?: boolean;
  silentWhenIdle?: boolean;
  notify: RemoteScheduleNotifyConfig;
}

export interface RemoteTemplateParameter {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: string;
  options?: string[];
  placeholder?: string;
}

export interface RemoteScheduleTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  source: 'builtin' | 'user' | 'project';
  prompt?: string;
  cronExpr?: string;
  timezone?: string;
  recurring?: boolean;
  agentKind?: RemoteScheduleAgentKind;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  useWorktree?: boolean;
  persistentSession?: boolean;
  notify?: RemoteScheduleNotifyConfig;
  parameters?: RemoteTemplateParameter[];
  createdAt?: number;
  updatedAt?: number;
}

export interface RemoteScheduleCreateFromTemplateInput {
  templateId: string;
  paramValues?: Record<string, string>;
  overrides?: Partial<RemoteScheduleWriteInput>;
}

export interface RemoteSchedule {
  id: string;
  name: string;
  prompt?: string;
  // 仅运行脚本任务(桌面端高级功能,见 docs/dev-rules/remote-and-mobile-adaptation.md)在移动端只读:mobile 侧
  // 没有编辑 scriptConfig 的 UI,这里只需要知道"这是脚本任务"以豁免 prompt 必填
  // 校验——不在 RemoteScheduleWriteInput 里暴露,避免 mobile 误写这个字段。
  executionMode?: RemoteScheduleExecutionMode;
  source?: 'user' | 'project';
  projectConfigId?: string;
  kind?: 'cron';
  cronExpr?: string;
  timezone?: string;
  recurring?: boolean;
  manual?: boolean;
  intervalMs?: number;
  agentKind?: RemoteScheduleAgentKind;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  workspaceKind?: RemoteScheduleWorkspaceKind;
  workingDir?: string;
  useWorktree?: boolean;
  targetSessionId?: string;
  persistentSession?: boolean;
  silentWhenIdle?: boolean;
  notify?: RemoteScheduleNotifyConfig;
  status: RemoteScheduleStatus;
  createdAt?: RemoteTimestamp;
  updatedAt?: RemoteTimestamp;
  lastFiredAt?: RemoteTimestamp;
  lastFinishedAt?: RemoteTimestamp;
  nextFireAt?: RemoteTimestamp;
  expireAt?: RemoteTimestamp;
}

export interface RemoteScheduleRun {
  id: string;
  scheduleId: string;
  sessionId?: string;
  firedAt?: RemoteTimestamp;
  finishedAt?: RemoteTimestamp;
  status: RemoteScheduleRunStatus;
  errorMsg?: string;
  resultText?: string;
  costUsd?: number;
  estimatedValueUsd?: number;
  costAttribution?: 'exact' | 'direct' | 'mixed' | 'zero' | 'unavailable' | 'legacy';
  readAt?: RemoteTimestamp;
}

export interface ScheduleListFilter {
  status?: RemoteScheduleStatus;
}
