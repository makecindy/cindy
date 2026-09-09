export type SchedulerEvent =
  | { type: 'fired'; scheduleId: string; runId: string }
  | { type: 'completed'; scheduleId: string; runId: string; sessionId: string }
  | { type: 'failed'; scheduleId: string; runId: string; error: string; sessionId?: string }
  | { type: 'deferred'; scheduleId: string; runId: string }
  /** 前置检查脚本(preRunHook)exit 2 拦截:run 记 'skipped' 生而已读;sessionId 为留痕会话 id,可为空串(留痕失败时)。 */
  | { type: 'skipped'; scheduleId: string; runId: string; sessionId: string }
  | { type: 'session-bound'; scheduleId: string; runId: string; sessionId: string }
  | { type: 'changed'; scheduleId: string }
  | { type: 'read'; scheduleId: string }
  | { type: 'all-read' }
  | { type: 'ready' };

export type SchedulerEventType = SchedulerEvent['type'];
export type NormalizedSchedulerEvent = SchedulerEvent | { type: 'unknown'; rawType: string | null };
export type ScheduleRunRefreshIntent =
  | { mode: 'none' }
  | { mode: 'all' }
  | { mode: 'schedule'; scheduleId: string };
export type ScheduleUnreadImpact = 'none' | 'may-increase' | 'may-clear-schedule' | 'clear-all';
export type ScheduleRunPatchStatus = 'running' | 'terminal' | 'deferred' | 'read' | 'bound' | 'unknown';

export interface ScheduleEventRunPatch {
  scheduleId: string | null;
  runId: string | null;
  sessionId: string | null;
  status: ScheduleRunPatchStatus;
}

export interface ScheduleEventRefreshIntent {
  runRefresh: ScheduleRunRefreshIntent;
  scheduleList: boolean;
  sessionIndex: boolean;
  unreadSummary: boolean;
}

export interface ScheduleEventProjection {
  event: NormalizedSchedulerEvent;
  refresh: ScheduleEventRefreshIntent;
  runPatch: ScheduleEventRunPatch;
  unreadImpact: ScheduleUnreadImpact;
}

export function normalizeSchedulerEvent(value: unknown): NormalizedSchedulerEvent {
  if (!isRecord(value)) return { type: 'unknown', rawType: null };
  const type = readString(value.type);
  switch (type) {
    case 'fired':
    case 'deferred': {
      const scheduleId = readString(value.scheduleId);
      const runId = readString(value.runId);
      return scheduleId && runId ? { type, scheduleId, runId } : unknownEvent(type);
    }
    case 'completed':
    case 'session-bound': {
      const scheduleId = readString(value.scheduleId);
      const runId = readString(value.runId);
      const sessionId = readString(value.sessionId);
      return scheduleId && runId && sessionId ? { type, scheduleId, runId, sessionId } : unknownEvent(type);
    }
    case 'failed': {
      const scheduleId = readString(value.scheduleId);
      const runId = readString(value.runId);
      if (!scheduleId || !runId) return unknownEvent(type);
      const sessionId = readString(value.sessionId);
      return sessionId
        ? { type, scheduleId, runId, error: readString(value.error) ?? '', sessionId }
        : { type, scheduleId, runId, error: readString(value.error) ?? '' };
    }
    case 'skipped': {
      // sessionId 与 completed 不同**允许空串**:desktop engine 在留痕会话创建失败时
      // emit sessionId=''(fail-soft),不能因此把整个事件打成 unknown 触发全量刷新。
      const scheduleId = readString(value.scheduleId);
      const runId = readString(value.runId);
      if (!scheduleId || !runId) return unknownEvent(type);
      return { type, scheduleId, runId, sessionId: readString(value.sessionId) ?? '' };
    }
    case 'changed':
    case 'read': {
      const scheduleId = readString(value.scheduleId);
      return scheduleId ? { type, scheduleId } : unknownEvent(type);
    }
    case 'all-read':
    case 'ready':
      return { type };
    default:
      return unknownEvent(type);
  }
}

export function projectScheduleEvent(value: unknown): ScheduleEventProjection {
  return projectNormalizedScheduleEvent(normalizeSchedulerEvent(value));
}

export function projectNormalizedScheduleEvent(event: NormalizedSchedulerEvent): ScheduleEventProjection {
  switch (event.type) {
    case 'ready':
      return projection(event, {
        runRefresh: { mode: 'none' },
        scheduleList: true,
        sessionIndex: false,
        unreadSummary: false,
      }, 'none', runPatch(null, null, null, 'unknown'));
    case 'changed':
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: true,
        sessionIndex: true,
        unreadSummary: true,
      }, 'none', runPatch(event.scheduleId, null, null, 'unknown'));
    case 'fired':
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: false,
        unreadSummary: false,
      }, 'none', runPatch(event.scheduleId, event.runId, null, 'running'));
    case 'deferred':
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: false,
        unreadSummary: false,
      }, 'none', runPatch(event.scheduleId, event.runId, null, 'deferred'));
    case 'completed':
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: true,
      }, 'may-increase', runPatch(event.scheduleId, event.runId, event.sessionId, 'terminal'));
    case 'skipped':
      // 与 completed 的差别:skipped run 生而已读,不影响未读徽标(unreadSummary=false /
      // unreadImpact='none');留痕会话可能新建,sessionIndex 仍要刷。
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: false,
      }, 'none', runPatch(event.scheduleId, event.runId, event.sessionId || null, 'terminal'));
    case 'failed':
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: true,
      }, 'may-increase', runPatch(event.scheduleId, event.runId, event.sessionId ?? null, 'terminal'));
    case 'session-bound':
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: false,
      }, 'none', runPatch(event.scheduleId, event.runId, event.sessionId, 'bound'));
    case 'read':
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: true,
      }, 'may-clear-schedule', runPatch(event.scheduleId, null, null, 'read'));
    case 'all-read':
      return projection(event, {
        runRefresh: { mode: 'all' },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: true,
      }, 'clear-all', runPatch(null, null, null, 'read'));
    case 'unknown':
      return projection(event, {
        runRefresh: { mode: 'all' },
        scheduleList: true,
        sessionIndex: true,
        unreadSummary: true,
      }, 'none', runPatch(null, null, null, 'unknown'));
  }
}

export function shouldRefreshRunsForSchedule(
  intent: ScheduleRunRefreshIntent,
  selectedScheduleId: string | null | undefined,
): boolean {
  if (!selectedScheduleId) return false;
  if (intent.mode === 'all') return true;
  return intent.mode === 'schedule' && intent.scheduleId === selectedScheduleId;
}

function projection(
  event: NormalizedSchedulerEvent,
  refresh: ScheduleEventRefreshIntent,
  unreadImpact: ScheduleUnreadImpact,
  runPatch: ScheduleEventRunPatch,
): ScheduleEventProjection {
  return { event, refresh, runPatch, unreadImpact };
}

function runPatch(
  scheduleId: string | null,
  runId: string | null,
  sessionId: string | null,
  status: ScheduleRunPatchStatus,
): ScheduleEventRunPatch {
  return { scheduleId, runId, sessionId, status };
}

function unknownEvent(rawType: string | null): NormalizedSchedulerEvent {
  return { type: 'unknown', rawType };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
