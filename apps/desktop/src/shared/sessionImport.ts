/**
 * 任务导入器（session-import）在主进程与界面之间共用的数据形态。
 * 主进程实现见 src/main/session-import/。
 */

export const IMPORT_SOURCE_IDS = [
  'claude',
  'codex',
  'pi',
  'opencode',
  'gemini',
  'cursor',
  'qwen',
  'kimi',
  'factory',
  'workbuddy',
  'deepseek',
] as const;

export type ImportSourceId = (typeof IMPORT_SOURCE_IDS)[number];

/** Cindy 自带、能原样续做的引擎（sessions.agent_kind 值域）。 */
export type NativeHarness = 'cc' | 'codex' | 'pi';

export const SESSION_IMPORT_PROGRESS_CHANNEL = 'session-import:progress';

export function isImportSourceId(value: unknown): value is ImportSourceId {
  return typeof value === 'string' && (IMPORT_SOURCE_IDS as readonly string[]).includes(value);
}

/** 不进入列表的原因。cindy / temp 可由用户选择显示。 */
export type HiddenCategory = 'cindy' | 'temp';

export interface ImportCandidate {
  key: string;
  source: ImportSourceId;
  id: string;
  title: string;
  cwd: string | null;
  /** 分组：项目根（worktree 归到主仓库）或 'dialogue'。 */
  groupKey: string;
  groupName: string;
  /** 显示用路径（家目录缩写成 ~）。 */
  groupPath: string | null;
  dialogue: boolean;
  updatedAt: number;
  archived: boolean;
  sizeBytes: number;
  missingDir: boolean;
  hidden: HiddenCategory | null;
  unsupportedVersion: string | null;
}

export interface ImportScanResult {
  candidates: ImportCandidate[];
  hiddenCounts: { cindy: number; temp: number; internal: number; imported: number };
  /** 本机找到历史的来源及数量（可见候选 + 隐藏候选）。 */
  sources: Array<{ id: ImportSourceId; label: string; count: number }>;
  /** 读取失败的来源（不影响其它来源）。 */
  sourceErrors: Array<{ id: ImportSourceId; message: string }>;
  scannedAt: number;
}

export type ImportItemStatus = 'queued' | 'running' | 'ready' | 'action' | 'failed' | 'cancelled';

export type ImportItemIssue =
  | 'missing-dir'
  | 'read-failed'
  | 'native-unloadable'
  | 'unsupported-version'
  /** 读完一条消息都没有（格式变了或原记录本来就是空的）。 */
  | 'empty'
  | 'not-found'
  | 'disk-full';

export type ImportItemStep = 'copy' | 'messages' | 'verify';

export interface ImportItemView {
  key: string;
  source: ImportSourceId;
  title: string;
  status: ImportItemStatus;
  step: ImportItemStep | null;
  messagesWritten: number;
  /** ready 时：native = 原样续做；handoff = 由 harness 接着做。 */
  mode: 'native' | 'handoff' | null;
  harness: NativeHarness | null;
  issue: ImportItemIssue | null;
  /** 导入后 Cindy 任务 id（ready / action 时可打开）。 */
  sessionId: string | null;
}

export interface ImportJobView {
  requestId: string;
  status: 'running' | 'done' | 'cancelled';
  items: ImportItemView[];
  startedAt: number;
  finishedAt: number | null;
}

/** 一次超过这么多条或这么大时，先确认再导入。 */
export const IMPORT_CONFIRM_COUNT = 50;
export const IMPORT_CONFIRM_BYTES = 1024 * 1024 * 1024;
