export type RemoteScheduleStatus = 'active' | 'paused' | 'expired';
export type RemoteScheduleAgentKind = 'claude-code' | 'codex' | 'pi';
export type RemoteScheduleWorkspaceKind = 'project' | 'dialogue';
export type RemoteScheduleRunStatus = 'running' | 'success' | 'failed' | 'aborted' | 'interrupted' | 'skipped';
export type RemoteScheduleExecutionMode = 'agent' | 'script';

export type RemoteTimestamp = number | string | null | undefined;

export interface RemoteScheduleNotifyConfig {
  desktop?: boolean;
  feishu?: boolean;
  wecomGroup?: boolean;
}

export interface RemoteScheduleWriteInput {
  name: string;
  prompt: string;
  kind: 'cron';
  cronExpr: string;
  timezone: string;
  recurring: boolean;
  manual?: boolean;
  /**
   * Interval 语义间隔(毫秒)。这个类型跨 device-link 的 JSON 边界传输,而
   * JSON.stringify 会丢掉值为 undefined 的 key——所以「清空间隔、退回 cron
   * 壁钟语义」必须用可序列化的 null 表达(desktop 接收端归一化成引擎的
   * 「带 key 的 undefined」)。省略 key 的含义随用途而不同:本类型同时服务
   * create() 与 update() 的 patch(见 mobileMakerTransport 的 schedule 面),
   * create 里省略 = 不设间隔(纯 cron 语义),update 里省略 = 不修改现有值。
   */
  intervalMs?: number | null;
  agentKind: RemoteScheduleAgentKind;
  model?: string;
  providerId?: string;
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
  providerId?: string;
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
  providerId?: string;
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
  costMoney?: RemoteScheduleRunMoney;
  estimatedValueMoney?: RemoteScheduleRunMoney;
  sdkEstimatedValueMoney?: RemoteScheduleRunMoney;
  costAttribution?: 'exact' | 'direct' | 'mixed' | 'zero' | 'unavailable' | 'legacy';
  readAt?: RemoteTimestamp;
}

export interface RemoteScheduleRunMoney {
  amount: number;
  currency: 'CNY' | 'USD';
  approximate: boolean;
  kind: 'actual-cost' | 'value-estimate';
  estimateReasons?: Array<
    'fixed-fx' | 'legacy-usd' | 'subscription-value' | 'reference-price' | 'inferred-currency' | 'sdk-estimate'
  >;
}

export interface ScheduleListFilter {
  status?: RemoteScheduleStatus;
}
