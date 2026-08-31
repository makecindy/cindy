import type {
  RemoteSchedule,
  RemoteScheduleRun,
  RemoteScheduleRunStatus,
  RemoteScheduleStatus,
  RemoteTimestamp,
} from './scheduleTypes';
import {
  presentationDate,
  presentationText,
  presentationTime,
  type PresentationLocalizer,
} from './presentationLocalization.js';

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
  localizer?: PresentationLocalizer,
): ScheduleSummary {
  const lastText = formatLastRun(schedule.lastFiredAt, now, localizer);
  const nextText = schedule.status === 'active'
    ? formatNextRun(schedule.nextFireAt, now, localizer)
    : null;
  let subtitle: string;
  if (schedule.status === 'paused') {
    subtitle = presentationText(localizer, 'devices.automations.presentation.schedule.paused', '已暂停');
  } else if (schedule.manual) {
    subtitle = lastText
      ?? presentationText(localizer, 'devices.automations.presentation.schedule.manual', '手动触发');
  } else if (schedule.recurring === false) {
    subtitle = lastText
      ?? presentationText(localizer, 'devices.automations.presentation.schedule.once', '单次任务');
  } else if (lastText && nextText) {
    subtitle = `${lastText} · ${nextText}`;
  } else {
    subtitle = lastText
      ?? nextText
      ?? presentationText(localizer, 'devices.automations.presentation.schedule.waitingFirstRun', '等待首次执行');
  }

  return {
    title: schedule.name || schedule.id,
    subtitle,
    detail: [
      describeScheduleTiming(schedule, localizer),
      describeRunSessionLabel(schedule, localizer),
      humanizeAgentKind(schedule.agentKind),
      describeDestination(schedule, localizer),
    ].filter(Boolean).join(' · '),
    runSessionDetail: describeRunSessionDetail(schedule, localizer),
    runSessionLabel: describeRunSessionLabel(schedule, localizer),
    status: schedule.status,
    statusLabel: scheduleStatusLabel(schedule.status, localizer),
    unreadCount: countUnreadRuns(runs, now),
  };
}

export function summarizeRun(
  run: RemoteScheduleRun,
  now = Date.now(),
  localizer?: PresentationLocalizer,
): RunSummary {
  const fired = formatTimestamp(run.firedAt, localizer);
  const finished = run.finishedAt ? formatTimestamp(run.finishedAt, localizer) : null;
  const subtitle = finished ? `${fired} - ${finished}` : fired;
  const error = run.errorMsg?.trim();
  const result = run.resultText?.trim();
  const sessionDetail = run.sessionId?.trim()
    ? presentationText(localizer, 'devices.automations.presentation.run.session', `任务 ${shortSessionId(run.sessionId)}`, {
        id: shortSessionId(run.sessionId),
      })
    : null;
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
    deleteLabel: canDelete
      ? presentationText(localizer, 'devices.automations.presentation.run.delete', '删除')
      : null,
    title: runStatusLabel(run.status, localizer),
    subtitle,
    detail: error || previewText(result) || null,
    markReadLabel: canMarkRead
      ? presentationText(localizer, 'devices.automations.presentation.run.markRead', '已读')
      : null,
    meta: [
      describeRunTiming(run, now, localizer),
      sessionDetail ?? (canRestart
        ? presentationText(localizer, 'devices.automations.presentation.run.canRestart', '可重新执行')
        : presentationText(localizer, 'devices.automations.presentation.run.noSession', '未创建任务')),
    ].filter(Boolean).join(' · '),
    openSessionLabel: sessionDetail
      ? presentationText(localizer, 'devices.automations.presentation.run.open', '打开')
      : null,
    restartLabel: canRestart
      ? presentationText(localizer, 'devices.automations.presentation.run.restart', '重跑')
      : null,
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
  localizer?: PresentationLocalizer,
): SchedulePauseConfirmation | null {
  const count = normalizeScheduleInflightCount(inflightCount);
  if (count <= 0) return null;
  return {
    title: presentationText(localizer, 'devices.automations.presentation.pause.title', `暂停 ${schedule.name || schedule.id}`, {
      name: schedule.name || schedule.id,
    }),
    detail: presentationText(localizer, 'devices.automations.presentation.pause.detail', `这条自动化当前有 ${count} 次执行正在进行。暂停会立即阻止后续触发,并停止这些正在进行的执行。`, {
      count,
    }),
    preview: presentationText(localizer, 'devices.automations.presentation.pause.preview', `正在执行: ${count} 次`, {
      count,
    }),
  };
}

export function scheduleStatusLabel(
  status: RemoteScheduleStatus,
  localizer?: PresentationLocalizer,
): string {
  const key = `devices.automations.presentation.schedule.status.${status}`;
  switch (status) {
    case 'active':
      return presentationText(localizer, key, '运行中');
    case 'paused':
      return presentationText(localizer, key, '已暂停');
    case 'expired':
      return presentationText(localizer, key, '已完成');
  }
}

export function runStatusLabel(
  status: RemoteScheduleRunStatus,
  localizer?: PresentationLocalizer,
): string {
  const key = `devices.automations.presentation.run.status.${status}`;
  switch (status) {
    case 'running':
      return presentationText(localizer, key, '执行中');
    case 'success':
      return presentationText(localizer, key, '成功');
    case 'failed':
      return presentationText(localizer, key, '失败');
    case 'aborted':
      return presentationText(localizer, key, '已中止');
    case 'interrupted':
      return presentationText(localizer, key, '被中断');
    case 'skipped':
      return presentationText(localizer, key, '已跳过');
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

function describeScheduleTiming(
  schedule: RemoteSchedule,
  localizer?: PresentationLocalizer,
): string {
  if (schedule.manual) {
    return presentationText(localizer, 'devices.automations.presentation.schedule.manual', '手动触发');
  }
  if (typeof schedule.intervalMs === 'number' && schedule.intervalMs > 0) {
    const duration = formatDuration(schedule.intervalMs, localizer);
    return presentationText(localizer, 'devices.automations.presentation.schedule.every', `每 ${duration}`, {
      duration,
    });
  }
  if (schedule.recurring === false) {
    return presentationText(localizer, 'devices.automations.presentation.schedule.once', '单次任务');
  }
  return schedule.cronExpr
    ? `cron ${schedule.cronExpr}`
    : presentationText(localizer, 'devices.automations.presentation.schedule.recurring', '周期任务');
}

function describeDestination(
  schedule: RemoteSchedule,
  localizer?: PresentationLocalizer,
): string {
  if (schedule.workspaceKind === 'dialogue') {
    return presentationText(localizer, 'devices.automations.presentation.schedule.dialogueWorkspace', '对话工作区');
  }
  if (!schedule.workingDir) {
    return presentationText(localizer, 'devices.automations.presentation.schedule.noDirectory', '未设置目录');
  }
  const parts = schedule.workingDir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? schedule.workingDir;
}

function describeRunSessionLabel(
  schedule: Pick<RemoteSchedule, 'persistentSession' | 'targetSessionId'>,
  localizer?: PresentationLocalizer,
): string {
  if (schedule.persistentSession) {
    return presentationText(localizer, 'devices.automations.presentation.schedule.session.persistent', '持续任务');
  }
  if (schedule.targetSessionId?.trim()) {
    return presentationText(localizer, 'devices.automations.presentation.schedule.session.bound', '绑定任务');
  }
  return presentationText(localizer, 'devices.automations.presentation.schedule.session.fresh', '新任务');
}

function describeRunSessionDetail(
  schedule: Pick<RemoteSchedule, 'persistentSession' | 'targetSessionId'>,
  localizer?: PresentationLocalizer,
): string | null {
  if (schedule.persistentSession && schedule.targetSessionId?.trim()) {
    const id = shortSessionId(schedule.targetSessionId);
    return presentationText(localizer, 'devices.automations.presentation.schedule.session.persistentWithId', `持续任务 ${id}`, {
      id,
    });
  }
  if (schedule.persistentSession) {
    return presentationText(localizer, 'devices.automations.presentation.schedule.session.persistentDetail', '首次触发后持续复用同一任务');
  }
  if (schedule.targetSessionId?.trim()) {
    const id = shortSessionId(schedule.targetSessionId);
    return presentationText(localizer, 'devices.automations.presentation.schedule.session.boundWithId', `绑定到 ${id}`, {
      id,
    });
  }
  return null;
}

function shortSessionId(sessionId: string): string {
  return sessionId.trim().slice(0, 8);
}

function describeRunTiming(
  run: Pick<RemoteScheduleRun, 'firedAt' | 'finishedAt' | 'status'>,
  now: number,
  localizer?: PresentationLocalizer,
): string {
  const firedAt = toMillis(run.firedAt);
  if (!firedAt) {
    return run.status === 'running'
      ? presentationText(localizer, 'devices.automations.presentation.run.status.running', '执行中')
      : presentationText(localizer, 'devices.automations.presentation.run.durationUnknown', '耗时未知');
  }
  if (run.status === 'running') {
    const duration = formatRunDuration(now - firedAt, localizer);
    return presentationText(localizer, 'devices.automations.presentation.run.runningFor', `已运行 ${duration}`, {
      duration,
    });
  }
  const finishedAt = toMillis(run.finishedAt);
  if (!finishedAt) {
    return presentationText(localizer, 'devices.automations.presentation.run.durationUnknown', '耗时未知');
  }
  const duration = formatRunDuration(finishedAt - firedAt, localizer);
  return presentationText(localizer, 'devices.automations.presentation.run.duration', `耗时 ${duration}`, {
    duration,
  });
}

function formatRunDuration(ms: number, localizer?: PresentationLocalizer): string {
  const diff = Math.max(0, ms);
  if (diff < 1000) return `${Math.round(diff)} ms`;
  if (diff < 60_000) {
    const count = (diff / 1000).toFixed(1);
    return presentationText(localizer, 'devices.automations.presentation.duration.seconds', `${count} 秒`, {
      count,
    });
  }
  const minutes = Math.floor(diff / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);
  return seconds > 0
    ? presentationText(localizer, 'devices.automations.presentation.duration.minutesSeconds', `${minutes} 分 ${seconds} 秒`, {
        minutes,
        seconds,
      })
    : presentationText(localizer, 'devices.automations.presentation.duration.minutes', `${minutes} 分钟`, {
        count: minutes,
      });
}

function humanizeAgentKind(agentKind: RemoteSchedule['agentKind']): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'pi') return 'Pi';
  return 'Claude';
}

function formatLastRun(
  value: RemoteTimestamp,
  now: number,
  localizer?: PresentationLocalizer,
): string | null {
  const ts = toMillis(value);
  if (!ts) return null;
  const relative = formatRelativePast(ts, now, localizer);
  return presentationText(localizer, 'devices.automations.presentation.schedule.lastRun', `上次 ${relative}`, {
    relative,
  });
}

function formatNextRun(
  value: RemoteTimestamp,
  now: number,
  localizer?: PresentationLocalizer,
): string | null {
  const ts = toMillis(value);
  if (!ts) return null;
  const diff = ts - now;
  if (diff <= 0) {
    return presentationText(localizer, 'devices.automations.presentation.schedule.imminent', '即将执行');
  }
  const duration = formatDuration(diff, localizer);
  return presentationText(localizer, 'devices.automations.presentation.schedule.nextRun', `${duration}后`, {
    duration,
  });
}

function formatRelativePast(
  timestamp: number,
  now: number,
  localizer?: PresentationLocalizer,
): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) {
    return presentationText(localizer, 'devices.automations.presentation.relative.justNow', '刚刚');
  }
  if (diff < 3_600_000) {
    const count = Math.floor(diff / 60_000);
    return presentationText(localizer, 'devices.automations.presentation.relative.minutesAgo', `${count} 分钟前`, {
      count,
    });
  }
  if (diff < 86_400_000) {
    const count = Math.floor(diff / 3_600_000);
    return presentationText(localizer, 'devices.automations.presentation.relative.hoursAgo', `${count} 小时前`, {
      count,
    });
  }
  if (diff < 7 * 86_400_000) {
    const count = Math.floor(diff / 86_400_000);
    return presentationText(localizer, 'devices.automations.presentation.relative.daysAgo', `${count} 天前`, {
      count,
    });
  }
  return formatTimestamp(timestamp, localizer);
}

function formatDuration(ms: number, localizer?: PresentationLocalizer): string {
  if (ms < 3_600_000) {
    const count = Math.max(1, Math.round(ms / 60_000));
    return presentationText(localizer, 'devices.automations.presentation.duration.minutes', `${count} 分钟`, {
      count,
    });
  }
  if (ms < 86_400_000) {
    const count = Math.round(ms / 3_600_000);
    return presentationText(localizer, 'devices.automations.presentation.duration.hours', `${count} 小时`, {
      count,
    });
  }
  const count = Math.round(ms / 86_400_000);
  return presentationText(localizer, 'devices.automations.presentation.duration.days', `${count} 天`, {
    count,
  });
}

function formatTimestamp(value: RemoteTimestamp, localizer?: PresentationLocalizer): string {
  const ts = toMillis(value);
  if (!ts) {
    return presentationText(localizer, 'devices.automations.presentation.run.unknownTime', '未知时间');
  }
  const date = new Date(ts);
  if (localizer) return `${presentationDate(localizer, date)} ${presentationTime(localizer, date)}`;
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
