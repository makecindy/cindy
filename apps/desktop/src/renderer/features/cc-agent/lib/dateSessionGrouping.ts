import type { Session } from '@/lib/ccAgent.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DATE_GROUP_DAYS = 7;

export type DateSessionGroupKind = 'today' | 'yesterday' | 'date' | 'older';
export type DateSessionSortBy = 'recency' | 'time' | 'manual';

export interface DateSessionGroup {
  kind: DateSessionGroupKind;
  /** Local day key for concrete date groups, formatted as YYYY-MM-DD. */
  dayKey: string;
  /** Representative date for labels; omitted for the Older bucket. */
  date: Date | null;
  sessions: Session[];
}

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function sessionActivityMs(session: Session): number {
  // 以 userSendAt（用户最近一次按下发送）为主键排序：agent 回复 / /clear 等
  // 只 bump updatedAt 的路径不再重排列表。userSendAt == null 时回落到 updatedAt，
  // 兼容 touchUserSendInDb 失败的 scheduler fire 与从未发送过的草稿会话（历史存量）。
  return session.userSendAt != null ? toMs(session.userSendAt) : toMs(session.updatedAt);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function classifyActivityDate(activity: Date, now: Date): Pick<DateSessionGroup, 'kind' | 'dayKey' | 'date'> {
  const todayStart = startOfLocalDay(now);
  const activityStart = startOfLocalDay(activity);
  const diffDays = Math.floor((todayStart.getTime() - activityStart.getTime()) / DAY_MS);

  if (diffDays <= 0) {
    return { kind: 'today', dayKey: localDayKey(todayStart), date: todayStart };
  }
  if (diffDays === 1) {
    return { kind: 'yesterday', dayKey: localDayKey(activityStart), date: activityStart };
  }
  if (diffDays < RECENT_DATE_GROUP_DAYS) {
    return { kind: 'date', dayKey: localDayKey(activityStart), date: activityStart };
  }
  return { kind: 'older', dayKey: 'older', date: null };
}

/**
 * Group sidebar sessions by recent local activity date.
 *
 * Sessions are sorted by sessionActivityMs（userSendAt ?? updatedAt）——以用户最近
 * 一次按下发送为主键，userSendAt 为空的会话（scheduler fire / 草稿）回落到 updatedAt。
 */
export function groupSessionsByActivityDate(
  sessions: readonly Session[],
  now: Date = new Date(),
  sortBy: DateSessionSortBy = 'recency',
): DateSessionGroup[] {
  if (sessions.length === 0) return [];

  const groups = new Map<string, DateSessionGroup>();
  const sorted = sessions
    .slice()
    .sort((a, b) =>
      sortBy === 'time'
        ? sessionActivityMs(a) - sessionActivityMs(b)
        : sessionActivityMs(b) - sessionActivityMs(a),
    );

  for (const session of sorted) {
    const activityMs = sessionActivityMs(session);
    const activity = activityMs > 0 ? new Date(activityMs) : new Date(0);
    const meta = classifyActivityDate(activity, now);
    const key = meta.kind === 'date' ? meta.dayKey : meta.kind;
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(key, { ...meta, sessions: [session] });
    }
  }

  return Array.from(groups.values());
}
