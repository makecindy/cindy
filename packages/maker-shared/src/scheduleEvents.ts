export type SchedulerEvent =
  | { type: 'fired'; scheduleId: string; runId: string }
  | { type: 'completed'; scheduleId: string; runId: string; sessionId: string }
  | { type: 'failed'; scheduleId: string; runId: string; error: string; sessionId?: string; silenced?: boolean }
  | { type: 'deferred'; scheduleId: string; runId: string }
  /** 前置检查脚本(preRunHook)exit 2 拦截:run 记 'skipped' 生而已读;sessionId 为留痕会话 id,可为空串。新主机会附带排期时间戳与检查恢复标记。 */
  | {
      type: 'skipped';
      scheduleId: string;
      runId: string;
      sessionId: string;
      lastFiredAt?: number;
      lastFinishedAt?: number;
      nextFireAt?: number;
      preRunCheckSucceeded?: boolean;
    }
  | { type: 'session-bound'; scheduleId: string; runId: string; sessionId: string }
  /**
   * skippedRunId 标识宿主为兼容旧客户端(只认 changed 刷新下次时间)在 skipped 之后有界合并补发的事件;
   * 旧端忽略未知字段照常重拉,已原位应用同次 skipped 补丁的现代端可据此去重。
   */
  | { type: 'changed'; scheduleId: string; skippedRunId?: string }
  | { type: 'read'; scheduleId: string }
  | { type: 'all-read' }
  | { type: 'ready' }
  /**
   * In-flight 数量或并发闸门等待队列变化的运行诊断(desktop engine 高频广播)。与 desktop
   * renderer 一致,不驱动任何列表 / run / 未读刷新;投影不需要 snapshot,因此不校验也不保留。
   */
  | { type: 'runtime-state' }
  /**
   * 静默运行的提醒开关(silenced:本轮不提醒 / notified:agent 主动要求提醒)。只影响宿主侧
   * 完成提醒,run 状态与未读由随后的 completed 收口;投影不驱动任何刷新。
   */
  | { type: 'silenced' | 'notified'; scheduleId: string; runId: string };

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
    case 'deferred':
    case 'silenced':
    case 'notified': {
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
      const silenced = value.silenced === true;
      return {
        type,
        scheduleId,
        runId,
        error: readString(value.error) ?? '',
        ...(sessionId ? { sessionId } : {}),
        ...(silenced ? { silenced: true } : {}),
      };
    }
    case 'skipped': {
      // sessionId 与 completed 不同**允许空串**:desktop engine 在留痕会话创建失败或
      // 普通前置检查空跳时 emit sessionId=''(fail-soft),不能因此把整个事件打成 unknown。
      // 新主机可选附带排期时间戳与 preRunCheckSucceeded,旧主机缺省仍合法。
      const scheduleId = readString(value.scheduleId);
      const runId = readString(value.runId);
      if (!scheduleId || !runId) return unknownEvent(type);
      const lastFiredAt = readFiniteNumber(value.lastFiredAt);
      const lastFinishedAt = readFiniteNumber(value.lastFinishedAt);
      const nextFireAt = readFiniteNumber(value.nextFireAt);
      const preRunCheckSucceeded = value.preRunCheckSucceeded === true;
      return {
        type,
        scheduleId,
        runId,
        sessionId: readString(value.sessionId) ?? '',
        ...(lastFiredAt !== undefined ? { lastFiredAt } : {}),
        ...(lastFinishedAt !== undefined ? { lastFinishedAt } : {}),
        ...(nextFireAt !== undefined ? { nextFireAt } : {}),
        ...(preRunCheckSucceeded ? { preRunCheckSucceeded: true } : {}),
      };
    }
    case 'changed': {
      const scheduleId = readString(value.scheduleId);
      if (!scheduleId) return unknownEvent(type);
      const skippedRunId = readString(value.skippedRunId);
      return skippedRunId ? { type, scheduleId, skippedRunId } : { type, scheduleId };
    }
    case 'read': {
      const scheduleId = readString(value.scheduleId);
      return scheduleId ? { type, scheduleId } : unknownEvent(type);
    }
    case 'all-read':
    case 'ready':
    case 'runtime-state':
      return { type };
    default:
      return unknownEvent(type);
  }
}

export function isPatchableSkippedScheduleEvent(
  event: NormalizedSchedulerEvent,
): event is Extract<SchedulerEvent, { type: 'skipped' }> & {
  lastFinishedAt: number;
  nextFireAt: number;
} {
  return (
    event.type === 'skipped' &&
    event.sessionId === '' &&
    event.lastFinishedAt !== undefined &&
    event.nextFireAt !== undefined
  );
}

export function projectScheduleEvent(value: unknown): ScheduleEventProjection {
  return projectNormalizedScheduleEvent(normalizeSchedulerEvent(value));
}

export function projectNormalizedScheduleEvent(event: NormalizedSchedulerEvent): ScheduleEventProjection {
  switch (event.type) {
    case 'ready':
      // 宿主冷启 / 切账号后会把残留 running 标成 interrupted、重算 nextFireAt,侧栏索引一并重拉。
      return projection(event, {
        runRefresh: { mode: 'none' },
        scheduleList: true,
        sessionIndex: true,
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
      // 认领时宿主清空 nextFireAt 并插入 running run:索引里的运行态与下次运行时间都变了。
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: true,
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
    case 'skipped': {
      // 携带完整完成/下次时间戳且无留痕会话的周期空跳由现代端原位补丁收口(不额外重拉索引或会话表);
      // 故障恢复或冷启首检由宿主紧跟广播真实 changed(无 skippedRunId)并在持有旧失败快照的客户端升级刷新;
      // 旧主机无时间戳或有留痕 sessionId 时保留 sessionIndex=true 兼容重拉。
      const patchable = isPatchableSkippedScheduleEvent(event);
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: !patchable,
        unreadSummary: !patchable && event.preRunCheckSucceeded === true,
      }, 'none', runPatch(event.scheduleId, event.runId, event.sessionId || null, 'terminal'));
    }
    case 'failed': {
      const silenced = event.silenced === true;
      return projection(event, {
        runRefresh: { mode: 'schedule', scheduleId: event.scheduleId },
        scheduleList: false,
        sessionIndex: true,
        unreadSummary: !silenced,
      }, silenced ? 'none' : 'may-increase', runPatch(event.scheduleId, event.runId, event.sessionId ?? null, 'terminal'));
    }
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
    case 'silenced':
    case 'notified':
    case 'runtime-state':
      // 纯运行诊断:不能落进 unknown 的全量刷新,否则每次 in-flight 变化都让消费方重拉
      // schedule index / 列表 / runs。
      return projection(event, {
        runRefresh: { mode: 'none' },
        scheduleList: false,
        sessionIndex: false,
        unreadSummary: false,
      }, 'none', runPatch(null, null, null, 'unknown'));
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

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
