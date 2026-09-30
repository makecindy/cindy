/**
 * Orca 协同(Lead / Worker 团队)的跨端纯逻辑:桌面「创建 Worker」面板与手机协同面板共用。
 *
 * 团队真身始终在被控端 main 编排;这里只放两端都要逐字一致的判据 —— Worker 标签派生、
 * 预设角色、新建任务的首个 Worker 任务拼接,以及被控端 wire 记录的防御性解析。
 */

/** 创建 Worker 面板的预设角色(与桌面 CreateWorkerPopover 同一份)。 */
export const ORCA_PREDEFINED_WORKER_ROLES = ['developer', 'designer', 'reviewer', 'tester', 'merger'] as const;

/** 自定义角色名的长度上限(被控端 `maker:worker:create` 同口径校验)。 */
export const ORCA_WORKER_ROLE_MAX_LENGTH = 32;

export type OrcaWorkerAgentKind = 'claude-code' | 'codex' | 'pi';
export type OrcaWorkerPermissionMode = 'auto' | 'bypassPermissions';
export type OrcaWorkerStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * 「创建 Worker」的首次默认值(没有记忆时):桌面 workerCreationPrefs 与手机同一份。
 * 之后每次创建都记住 Agent、该 Agent 的模型 / 推理强度 / Fast 与权限,下次带出。
 */
export const DEFAULT_ORCA_WORKER_AGENT: OrcaWorkerAgentKind = 'codex';
export const DEFAULT_ORCA_WORKER_EFFORT = 'high';
export const DEFAULT_ORCA_WORKER_MODELS: Readonly<Record<OrcaWorkerAgentKind, string>> = {
  codex: 'codex/gpt-5.5',
  'claude-code': 'claude-opus-4-7',
  // 与被控端 orcaWorkerCreationService 的 pi 默认一致。
  pi: 'claude-sonnet-4-6',
};

/**
 * 按角色派生 Worker label(被控端要求 /^[a-z0-9_-]+$/i、≤32、团队内唯一)。
 * 重名时追加 `-2`、`-3`…;极端情况下用时间戳后缀兜底。
 */
export function createWorkerLabel(role: string, existingLabels: readonly string[]): string {
  const base = trimHyphens(
    role
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-'),
  ).slice(0, 24) || 'worker';
  const existing = new Set(existingLabels.map((label) => label.toLowerCase()));
  if (!existing.has(base)) return base;

  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }

  return `${base.slice(0, 27)}-${Date.now().toString(36).slice(-4)}`;
}

/** 去掉首尾连字符(线性扫描,不用可回溯的正则)。 */
function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

export function shouldShowWorkerLabel(role: string, label: string | null | undefined): label is string {
  return typeof label === 'string' && label.length > 0 && label !== role;
}

/**
 * New-task flows create the Worker before the Lead's first input is sent. Older controlled
 * devices cannot defer assignment until that input is queryable, so preserve the pending text
 * inline for that mixed-version path. New peers use the Worker-scoped Lead history bridge.
 *
 * pendingLeadInput is context only: without an explicit Worker task it cannot start new work.
 */
export function buildDraftWorkerInitialTask(
  initialTask: string | undefined,
  pendingLeadInput: string | undefined,
): string | undefined {
  const task = initialTask?.trim();
  if (!task) return undefined;

  const pending = pendingLeadInput?.trim();
  if (!pending) return task;

  return [
    task,
    '',
    'Pending Lead input:',
    'The Lead has not sent this input yet, so it is not available in Lead session history. Use it only as context for the Worker task above; do not treat it as a replacement task.',
    pending,
  ].join('\n');
}

/** 被控端 `local-db:orca-workflows:list-workers-by-lead` 单条记录的控制端投影。 */
export interface OrcaTeamWorker {
  workerId: string;
  sessionId: string;
  role: string;
  label: string | null;
  status: OrcaWorkerStatus;
  focused: boolean;
  agentKind: OrcaWorkerAgentKind;
  model: string | null;
  effort: string | null;
  title: string | null;
}

/** 被控端 `maker:collaboration-settings:get` 的控制端投影。 */
export interface OrcaCollaborationSettings {
  workerSoftLimit: number;
  workerHardLimit: number;
  workerIdleReleaseMinutes: number;
}

export const DEFAULT_ORCA_COLLABORATION_SETTINGS: OrcaCollaborationSettings = {
  workerSoftLimit: 5,
  workerHardLimit: 8,
  workerIdleReleaseMinutes: 0,
};

/** 没有保存过偏好时的产品默认(与桌面 workerCreationPrefs 一致):Full access。 */
export const DEFAULT_ORCA_WORKER_PERMISSION_MODE: OrcaWorkerPermissionMode = 'bypassPermissions';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function agentKind(value: unknown): OrcaWorkerAgentKind {
  return value === 'codex' || value === 'pi' ? value : 'claude-code';
}

function workerStatus(value: unknown): OrcaWorkerStatus {
  return value === 'running' || value === 'done' || value === 'error' ? value : 'idle';
}

export function parseOrcaPermissionMode(value: unknown): OrcaWorkerPermissionMode | null {
  return value === 'auto' || value === 'bypassPermissions' ? value : null;
}

/** 解析 worker 列表;缺 id / sessionId 的条目直接丢弃(不猜)。保持被控端顺序(新→旧)。 */
export function parseOrcaTeamWorkers(value: unknown): OrcaTeamWorker[] {
  if (!Array.isArray(value)) return [];
  const workers: OrcaTeamWorker[] = [];
  for (const item of value) {
    const row = record(item);
    const workerId = text(row?.id);
    const sessionId = text(row?.sessionId);
    if (!row || !workerId || !sessionId) continue;
    const session = record(row.session);
    workers.push({
      workerId,
      sessionId,
      role: text(row.role) ?? 'developer',
      label: text(row.label),
      status: workerStatus(row.status),
      focused: row.focused === true,
      agentKind: agentKind(session?.agentKind),
      model: text(session?.model),
      effort: text(session?.effort),
      title: text(session?.title),
    });
  }
  return workers;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function parseOrcaCollaborationSettings(value: unknown): OrcaCollaborationSettings {
  const row = record(value);
  if (!row) return DEFAULT_ORCA_COLLABORATION_SETTINGS;
  const defaults = DEFAULT_ORCA_COLLABORATION_SETTINGS;
  return {
    workerSoftLimit: positiveInt(row.workerSoftLimit, defaults.workerSoftLimit),
    workerHardLimit: positiveInt(row.workerHardLimit, defaults.workerHardLimit),
    workerIdleReleaseMinutes: positiveInt(row.workerIdleReleaseMinutes, defaults.workerIdleReleaseMinutes),
  };
}

/** 团队记录里的 leadSessionId(`get-by-worker-session` / `get-by-lead` 的返回)。 */
export function readOrcaTeamLeadSessionId(value: unknown): string | null {
  return text(record(value)?.leadSessionId);
}

/**
 * Worker 名额:未归档的 Worker 不论 idle / running / done / error 都占位(与被控端
 * 硬上限判定同口径,归档的 Worker 不出现在列表里)。
 */
export function orcaWorkerSlotState(
  workers: readonly OrcaTeamWorker[],
  settings: Pick<OrcaCollaborationSettings, 'workerSoftLimit' | 'workerHardLimit'>,
): 'ok' | 'soft' | 'hard' {
  if (workers.length >= settings.workerHardLimit) return 'hard';
  if (workers.length >= settings.workerSoftLimit) return 'soft';
  return 'ok';
}

/**
 * 被控端 `maker:plugins:get-state('collab', …)` 结果 → 入口是否可用。
 * dialogue 会话要求被控端回显 `collabWorkspaceKind==='dialogue'`(老被控端不理解
 * dialogue 口径,按不支持处理,与桌面控制端 useCollabProjectPolicy 一致)。
 */
export function readOrcaCollabPolicy(
  value: unknown,
  workspaceKind: 'project' | 'dialogue',
): { enabled: boolean; unsupported: boolean } {
  const row = record(value);
  if (workspaceKind === 'dialogue' && row?.collabWorkspaceKind !== 'dialogue') {
    return { enabled: false, unsupported: true };
  }
  return { enabled: row?.effectiveEnabled === true, unsupported: false };
}
