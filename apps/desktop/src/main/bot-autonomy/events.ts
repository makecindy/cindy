/**
 * 伙伴自主跟进 · 事件判定（程序级，不经模型）。
 *
 * 从状态表判定 stuck / waiting / errored / usage-limit / finished，发布到例行任务引擎的宿主
 * 内置事件源 `host:sessions`。去重：同一任务同一 (类型, phaseSince) 只发一次（事件 id 天然唯一，
 * 引擎另有 24h 回执去重）；防打转：同一任务同一类事件 24h 内最多
 * `AUTONOMY_THRESHOLDS.maxEventsPerSessionPerDay` 次，超出只记日志。
 */
import type { RoutineEvent, RoutineSource } from '@cindy/maker-scheduler';
import {
  AUTONOMY_EVENT_TYPES,
  AUTONOMY_THRESHOLDS,
  HOST_SESSIONS_SOURCE_ID,
  autonomyEventId,
  type AutonomyEventData,
  type AutonomyEventType,
  type WatchedSession,
} from '../../shared/botAutonomy.js';

const DAY_MS = 24 * 60 * 60_000;

const EVENT_NAMES: Record<AutonomyEventType, string> = {
  stuck: '任务卡住',
  waiting: '任务等你',
  errored: '任务出错',
  'usage-limit': '任务撞上用量上限',
  finished: '任务做完',
  sweep: '还有待处理的任务',
};

/** 与 AutonomyEventData 的键一一对应；引擎只允许按声明过的字段筛选。 */
export const AUTONOMY_EVENT_FIELDS: readonly (keyof AutonomyEventData)[] = [
  'sessionId',
  'deviceId',
  'deviceName',
  'title',
  'phase',
  'minutes',
  'question',
  'error',
  'creatorBotId',
  'followerBotId',
  'occurrence',
  'executionInstanceId',
  'executionGeneration',
];

/** 宿主内置事件源声明；引擎每次创建后由宿主重新登记。 */
export function hostSessionsSource(): RoutineSource {
  return {
    id: HOST_SESSIONS_SOURCE_ID,
    name: 'Cindy 任务',
    status: 'listening',
    events: AUTONOMY_EVENT_TYPES.map((type) => ({
      type,
      name: EVENT_NAMES[type],
      fields: [...AUTONOMY_EVENT_FIELDS],
    })),
  };
}

/** 这一行此刻够不够格发哪类事件（不看去重）。离线电脑的旧状态不发。 */
export function dueEventType(row: WatchedSession, now: number): AutonomyEventType | null {
  // 另一台电脑上的任务由那台电脑上的伙伴跟：这里只进工作台，不发事件。
  if (!row.online || row.deviceId !== null) return null;
  switch (row.phase) {
    case 'running': {
      // 前台工具调用在途（例如一次长构建）期间没有活动事件：用更长的阈值，不把健康的长调用当卡住。
      const threshold = row.toolInFlight ? AUTONOMY_THRESHOLDS.stuckInToolAfterMs : AUTONOMY_THRESHOLDS.stuckAfterMs;
      return now - Math.max(row.lastActivityAt, row.phaseSince) >= threshold ? 'stuck' : null;
    }
    case 'waiting-answer':
    case 'waiting-permission':
      return now - row.phaseSince >= AUTONOMY_THRESHOLDS.waitingAfterMs ? 'waiting' : null;
    case 'errored':
      return 'errored';
    case 'usage-limit':
      return 'usage-limit';
    case 'finished':
      // 自动化运行的任务有自己的结果通知，「做完」不再叫醒伙伴；卡住 / 等你 / 出错照常。
      // 伙伴主任务的一轮回复做完不是「任务做完」：否则别的伙伴每回一句话都会叫醒总调度。
      return row.source === 'routine' || row.canonicalOfBotId || !row.finalDelivery ? null : 'finished';
    default:
      return null;
  }
}

export interface AutonomyEventCandidate {
  id: string;
  type: AutonomyEventType;
  row: WatchedSession;
  /** 24h 内该任务同类事件第几次（含本次）。 */
  occurrence: number;
}

export interface AutonomyEvaluation {
  due: AutonomyEventCandidate[];
  /** 本次第一次撞上 24h 上限的事件（只记日志，不发布）。 */
  capped: AutonomyEventCandidate[];
}

/** 内存账本：重启后清空，靠引擎 24h 回执兜底去重（事件 id 由 phaseSince 决定，跨重启稳定）。 */
export class AutonomyEventLedger {
  private readonly settled = new Map<string, number>();
  private readonly occurrences = new Map<string, number[]>();

  evaluate(rows: Iterable<WatchedSession>, now: number): AutonomyEvaluation {
    this.prune(now);
    const due: AutonomyEventCandidate[] = [];
    const capped: AutonomyEventCandidate[] = [];
    for (const row of rows) {
      const type = dueEventType(row, now);
      if (!type) continue;
      const id = autonomyEventId(type, row.sessionId, row.phaseSince);
      if (this.settled.has(id)) continue;
      const count = this.occurrences.get(occurrenceKey(row.sessionId, type))?.length ?? 0;
      const candidate = { id, type, row, occurrence: count + 1 };
      if (count >= AUTONOMY_THRESHOLDS.maxEventsPerSessionPerDay) {
        this.settled.set(id, now);
        capped.push(candidate);
        continue;
      }
      due.push(candidate);
    }
    return { due, capped };
  }

  /** 已被引擎持久接收（或确认不需要发布）：不再重复判定，并计入 24h 次数。 */
  settle(candidate: AutonomyEventCandidate, now: number, counted = true): void {
    if (this.settled.has(candidate.id)) return;
    this.settled.set(candidate.id, now);
    if (!counted) return;
    const key = occurrenceKey(candidate.row.sessionId, candidate.type);
    this.occurrences.set(key, [...(this.occurrences.get(key) ?? []), now]);
  }

  isSettled(id: string): boolean {
    return this.settled.has(id);
  }

  private prune(now: number): void {
    for (const [id, at] of this.settled) if (now - at >= DAY_MS) this.settled.delete(id);
    for (const [key, times] of this.occurrences) {
      const kept = times.filter((at) => now - at < DAY_MS);
      if (kept.length) this.occurrences.set(key, kept);
      else this.occurrences.delete(key);
    }
  }
}

function occurrenceKey(sessionId: string, type: AutonomyEventType): string {
  return `${type}\n${sessionId}`;
}

export function toRoutineEvent(candidate: AutonomyEventCandidate, now: number): RoutineEvent {
  const { row } = candidate;
  const data: AutonomyEventData = {
    sessionId: row.sessionId,
    deviceId: row.deviceId ?? '',
    deviceName: row.deviceName ?? '',
    title: row.title.slice(0, 200),
    phase: row.phase,
    minutes: Math.max(0, Math.floor((now - (candidate.type === 'stuck'
      ? Math.max(row.lastActivityAt, row.phaseSince)
      : row.phaseSince)) / 60_000)),
    question: row.pendingQuestion ?? '',
    error: row.error ?? '',
    creatorBotId: row.creatorBotId ?? '',
    followerBotId: row.followerBotId ?? '',
    occurrence: candidate.occurrence,
    ...(row.execution ? {
      executionInstanceId: row.execution.instanceId,
      executionGeneration: row.execution.generation,
    } : {}),
  };
  return {
    id: candidate.id,
    type: candidate.type,
    occurredAt: now,
    subject: row.sessionId,
    data: { ...data },
  };
}

/** 条件兜底要看的「待处理」：等你 / 出错 / 用量上限，或已经卡住。 */
export function isPendingForFallback(row: WatchedSession, now: number): boolean {
  if (!row.online || row.deviceId !== null) return false;
  if (row.phase === 'waiting-answer' || row.phase === 'waiting-permission'
    || row.phase === 'errored' || row.phase === 'usage-limit') return true;
  return dueEventType(row, now) === 'stuck';
}

/** 条件兜底事件：按伙伴、按兜底间隔分桶，同一桶只发一次（引擎回执跨重启去重）。 */
export function sweepEventId(botId: string, now: number): string {
  return `sweep:${botId}:${Math.floor(now / AUTONOMY_THRESHOLDS.fallbackIntervalMs)}`;
}

export function toSweepEvent(botId: string, now: number): RoutineEvent {
  const data: AutonomyEventData = {
    sessionId: '',
    deviceId: '',
    deviceName: '',
    title: '',
    phase: '',
    minutes: 0,
    question: '',
    error: '',
    creatorBotId: '',
    followerBotId: botId,
    occurrence: 1,
  };
  return { id: sweepEventId(botId, now), type: 'sweep', occurredAt: now, subject: botId, data: { ...data } };
}
