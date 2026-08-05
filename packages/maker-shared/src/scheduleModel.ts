import type {
  RemoteSchedule,
  RemoteScheduleRun,
  RemoteScheduleRunStatus,
  RemoteScheduleStatus,
  RemoteTimestamp,
} from './scheduleTypes';

export interface ScheduleSummary {
  title: string;
  subtitle: string;
  detail: string;
  runSessionDetail: string | null;
  runSessionLabel: string;
  statusLabel: string;
  status: RemoteScheduleStatus;
  unreadCount: number;
}

export interface RunSummary {
  canDelete: boolean;
  canMarkRead: boolean;
  canOpenSession: boolean;
  canRestart: boolean;
  deleteLabel: string | null;
  title: string;
  subtitle: string;
  detail: string | null;
  markReadLabel: string | null;
  meta: string;
  openSessionLabel: string | null;
  restartLabel: string | null;
  sessionDetail: string | null;
  status: RemoteScheduleRunStatus;
  unread: boolean;
}

export interface AutomationOverview {
  activeCount: number;
  pausedCount: number;
  runningRunCount: number;
  totalCount: number;
  unreadRunCount: number;
}

export interface SchedulePauseConfirmation {
  detail: string;
  preview: string;
  title: string;
}

const STATUS_RANK: Record<RemoteScheduleStatus, number> = {
  active: 0,
  expired: 0,
  paused: 1,
};
const LEGACY_SESSION_RUN_ID_PREFIX = 'legacy-session:';

export function normalizeScheduleList(value: unknown): RemoteSchedule[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const id = readString(item, 'id');
      if (!id) return null;
      return {
        ...item,
        id,
        name: readString(item, 'name') ?? id,
        status: normalizeScheduleStatus(item.status),
      } as RemoteSchedule;
    })
    .filter((item): item is RemoteSchedule => !!item);
}

export function normalizeScheduleRuns(value: unknown): RemoteScheduleRun[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const id = readString(item, 'id');
      const scheduleId = readString(item, 'scheduleId');
      if (!id || !scheduleId) return null;
      return {
        ...item,
        id,
        scheduleId,
        status: normalizeRunStatus(item.status),
      } as RemoteScheduleRun;
    })
    .filter((item): item is RemoteScheduleRun => !!item);
}

export function sortSchedulesForMobile(list: readonly RemoteSchedule[]): RemoteSchedule[] {
  return [...list].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    const last = toMillis(b.lastFiredAt) - toMillis(a.lastFiredAt);
    if (last !== 0) return last;
    return toMillis(b.updatedAt) - toMillis(a.updatedAt);
  });
}

export function displayRunsForMobile(list: readonly RemoteScheduleRun[]): RemoteScheduleRun[] {
  const seenSessionIds = new Set<string>();
  const sorted = [...list].sort((a, b) => toMillis(b.firedAt) - toMillis(a.firedAt));
  const out: RemoteScheduleRun[] = [];
  for (const run of sorted) {
    if (!run.sessionId) {
      out.push(run);
      continue;
    }
    if (seenSessionIds.has(run.sessionId)) continue;
    seenSessionIds.add(run.sessionId);
    out.push(run);
  }
  return out;
}

export function countUnreadRuns(list: readonly RemoteScheduleRun[], now = Date.now()): number {
  return list.filter((run) => isUnreadRun(run, now)).length;
}

export function summarizeAutomationOverview(
  schedules: readonly RemoteSchedule[],
  runsBySchedule: ReadonlyMap<string, readonly RemoteScheduleRun[]>,
  now = Date.now(),
): AutomationOverview {
  let activeCount = 0;
  let pausedCount = 0;
  let runningRunCount = 0;
  let unreadRunCount = 0;
  for (const schedule of schedules) {
    if (schedule.status === 'active') activeCount += 1;
    if (schedule.status === 'paused') pausedCount += 1;
    const runs = runsBySchedule.get(schedule.id) ?? [];
    runningRunCount += runs.filter((run) => run.status === 'running').length;
    unreadRunCount += countUnreadRuns(runs, now);
  }
  return {
    activeCount,
    pausedCount,
    runningRunCount,
    totalCount: schedules.length,
    unreadRunCount,
  };
}

export function summarizeSchedule(
  schedule: RemoteSchedule,
  runs: readonly RemoteScheduleRun[] = [],
  now = Date.now(),
): ScheduleSummary {
  const lastText = formatLastRun(schedule.lastFiredAt, now);
  const nextText = schedule.status === 'active' ? formatNextRun(schedule.nextFireAt, now) : null;
  let subtitle: string;
  if (schedule.status === 'paused') {
    subtitle = '已暂停';
  } else if (schedule.manual) {
    subtitle = lastText ?? '手动触发';
  } else if (schedule.recurring === false) {
    subtitle = lastText ?? '单次任务';
  } else if (lastText && nextText) {
    subtitle = `${lastText} · ${nextText}`;
  } else {
    subtitle = lastText ?? nextText ?? '等待首次执行';
  }

  return {
    title: schedule.name || schedule.id,
    subtitle,
    detail: [
      describeScheduleTiming(schedule),
      describeRunSessionLabel(schedule),
      humanizeAgentKind(schedule.agentKind),
      describeDestination(schedule),
    ].filter(Boolean).join(' · '),
    runSessionDetail: describeRunSessionDetail(schedule),
    runSessionLabel: describeRunSessionLabel(schedule),
    status: schedule.status,
    statusLabel: scheduleStatusLabel(schedule.status),
    unreadCount: countUnreadRuns(runs, now),
  };
}

export function summarizeRun(run: RemoteScheduleRun, now = Date.now()): RunSummary {
  const fired = formatTimestamp(run.firedAt);
  const finished = run.finishedAt ? formatTimestamp(run.finishedAt) : null;
  const subtitle = finished ? `${fired} - ${finished}` : fired;
  const error = run.errorMsg?.trim();
  const result = run.resultText?.trim();
  const sessionDetail = run.sessionId?.trim() ? `会话 ${shortSessionId(run.sessionId)}` : null;
  const isLegacySessionRun = run.id.startsWith(LEGACY_SESSION_RUN_ID_PREFIX);
  const unread = isUnreadRun(run, now);
  const canDelete = !isLegacySessionRun && run.status !== 'running';
  const canMarkRead = !isLegacySessionRun && unread;
  const canOpenSession = !!sessionDetail;
  const canRestart = !isLegacySessionRun
    && !sessionDetail
    && (run.status === 'interrupted' || run.status === 'aborted');
  return {
    canDelete,
    canMarkRead,
    canOpenSession,
    canRestart,
    deleteLabel: canDelete ? '删除' : null,
    title: runStatusLabel(run.status),
    subtitle,
    detail: error || previewText(result) || null,
    markReadLabel: canMarkRead ? '已读' : null,
    meta: [
      describeRunTiming(run, now),
      sessionDetail ?? (canRestart ? '可重新执行' : '未创建会话'),
    ].filter(Boolean).join(' · '),
    openSessionLabel: sessionDetail ? '打开' : null,
    restartLabel: canRestart ? '重跑' : null,
    sessionDetail,
    status: run.status,
    unread,
  };
}

export function normalizeScheduleInflightCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

export function buildSchedulePauseConfirmation(
  schedule: Pick<RemoteSchedule, 'id' | 'name'>,
  inflightCount: unknown,
): SchedulePauseConfirmation | null {
  const count = normalizeScheduleInflightCount(inflightCount);
  if (count <= 0) return null;
  return {
    title: `暂停 ${schedule.name || schedule.id}`,
    detail: `这条自动化当前有 ${count} 次执行正在进行。暂停会立即阻止后续触发,并停止这些正在进行的执行。`,
    preview: `正在执行: ${count} 次`,
  };
}

export function scheduleStatusLabel(status: RemoteScheduleStatus): string {
  switch (status) {
    case 'active':
      return '运行中';
    case 'paused':
      return '已暂停';
    case 'expired':
      return '已完成';
  }
}

export function runStatusLabel(status: RemoteScheduleRunStatus): string {
  switch (status) {
    case 'running':
      return '执行中';
    case 'success':
      return '成功';
    case 'failed':
      return '失败';
    case 'aborted':
      return '已中止';
    case 'interrupted':
      return '被中断';
    case 'skipped':
      return '已跳过';
  }
}

export function toMillis(value: RemoteTimestamp): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeScheduleStatus(value: unknown): RemoteScheduleStatus {
  if (value === 'paused' || value === 'expired') return value;
  return 'active';
}

function normalizeRunStatus(value: unknown): RemoteScheduleRunStatus {
  if (
    value === 'running' ||
    value === 'success' ||
    value === 'failed' ||
    value === 'aborted' ||
    value === 'interrupted' ||
    value === 'skipped'
  ) {
    return value;
  }
  return 'failed';
}

function describeScheduleTiming(schedule: RemoteSchedule): string {
  if (schedule.manual) return '手动触发';
  if (typeof schedule.intervalMs === 'number' && schedule.intervalMs > 0) {
    return `每 ${formatDuration(schedule.intervalMs)}`;
  }
  if (schedule.recurring === false) return '单次任务';
  return schedule.cronExpr ? `cron ${schedule.cronExpr}` : '周期任务';
}

function describeDestination(schedule: RemoteSchedule): string {
  if (schedule.workspaceKind === 'dialogue') return '对话工作区';
  if (!schedule.workingDir) return '未设置目录';
  const parts = schedule.workingDir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? schedule.workingDir;
}

function describeRunSessionLabel(
  schedule: Pick<RemoteSchedule, 'persistentSession' | 'targetSessionId'>,
): string {
  if (schedule.persistentSession) return '持续会话';
  if (schedule.targetSessionId?.trim()) return '绑定会话';
  return '新会话';
}

function describeRunSessionDetail(
  schedule: Pick<RemoteSchedule, 'persistentSession' | 'targetSessionId'>,
): string | null {
  if (schedule.persistentSession && schedule.targetSessionId?.trim()) {
    return `持续会话 ${shortSessionId(schedule.targetSessionId)}`;
  }
  if (schedule.persistentSession) return '首次触发后持续复用同一会话';
  if (schedule.targetSessionId?.trim()) return `绑定到 ${shortSessionId(schedule.targetSessionId)}`;
  return null;
}

function shortSessionId(sessionId: string): string {
  return sessionId.trim().slice(0, 8);
}

function describeRunTiming(run: Pick<RemoteScheduleRun, 'firedAt' | 'finishedAt' | 'status'>, now: number): string {
  const firedAt = toMillis(run.firedAt);
  if (!firedAt) return run.status === 'running' ? '执行中' : '耗时未知';
  if (run.status === 'running') return `已运行 ${formatRunDuration(now - firedAt)}`;
  const finishedAt = toMillis(run.finishedAt);
  if (!finishedAt) return '耗时未知';
  return `耗时 ${formatRunDuration(finishedAt - firedAt)}`;
}

function formatRunDuration(ms: number): string {
  const diff = Math.max(0, ms);
  if (diff < 1000) return `${Math.round(diff)} ms`;
  if (diff < 60_000) return `${(diff / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(diff / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

function humanizeAgentKind(agentKind: RemoteSchedule['agentKind']): string {
  if (agentKind === 'codex') return 'Codex';
  return 'Claude';
}

function formatLastRun(value: RemoteTimestamp, now: number): string | null {
  const ts = toMillis(value);
  if (!ts) return null;
  return `上次 ${formatRelativePast(ts, now)}`;
}

function formatNextRun(value: RemoteTimestamp, now: number): string | null {
  const ts = toMillis(value);
  if (!ts) return null;
  const diff = ts - now;
  if (diff <= 0) return '即将执行';
  return `${formatDuration(diff)}后`;
}

function formatRelativePast(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTimestamp(timestamp);
}

function formatDuration(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时`;
  return `${Math.round(ms / 86_400_000)} 天`;
}

function formatTimestamp(value: RemoteTimestamp): string {
  const ts = toMillis(value);
  if (!ts) return '未知时间';
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function isUnreadRun(run: RemoteScheduleRun, now = Date.now()): boolean {
  if (run.status === 'running') return false;
  const firedAt = toMillis(run.firedAt);
  if (!firedAt || firedAt > now) return false;
  return !toMillis(run.readAt);
}

function previewText(value: string | undefined): string | null {
  if (!value) return null;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
