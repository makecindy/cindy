/**
 * 置顶提示:记录任务的打开时刻,找出最近 7 天常打开、却没置顶的任务,在置顶段
 * 下方提示一次。只给提示,从不自动置顶或重排(core-product-principles §4.1)。
 * ---------------------------------------------------------------------------
 * 计分:窗口内每次打开按距今线性衰减(刚打开 = 1,7 天前 = 0)求和,≥ MIN_SCORE
 * 才提示,一次只提示得分最高的一个。30 分钟内反复切回同一任务只算一次,否则
 * 两个任务来回切就能刷高分。用户点过「不再提示」的任务永不再提示。
 * 历史按窗口裁剪并限量,本机存储不会无限增长。
 */

import type { Session } from '@/lib/ccAgent.types';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PIN_SUGGESTION_WINDOW_MS = 7 * DAY_MS;
export const REOPEN_DEDUP_MS = 30 * 60 * 1000;
export const MIN_PIN_SUGGESTION_SCORE = 4;
const MAX_OPENS_PER_SESSION = 20;
const MAX_TRACKED_SESSIONS = 200;

export interface SessionOpenHistory {
  /** sessionId → 打开时刻(unix ms,升序)。 */
  opens: Readonly<Record<string, readonly number[]>>;
  /** 点过「不再提示」的 sessionId。永久保留(只随用户点击增长),承诺不再提示。 */
  dismissed: readonly string[];
}

export const EMPTY_SESSION_OPEN_HISTORY: SessionOpenHistory = { opens: {}, dismissed: [] };

/** 本机存储的原始值只在这里校验;坏数据整体回落为空历史。 */
export function parseSessionOpenHistory(raw: string | null): SessionOpenHistory {
  if (!raw) return EMPTY_SESSION_OPEN_HISTORY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_SESSION_OPEN_HISTORY;
  }
  if (typeof value !== 'object' || value === null) return EMPTY_SESSION_OPEN_HISTORY;
  const { opens, dismissed } = value as { opens?: unknown; dismissed?: unknown };
  const parsedOpens: Record<string, number[]> = {};
  if (typeof opens === 'object' && opens !== null && !Array.isArray(opens)) {
    for (const [id, times] of Object.entries(opens)) {
      if (!Array.isArray(times)) continue;
      const valid = times.filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
      if (valid.length > 0) parsedOpens[id] = valid.sort((a, b) => a - b);
    }
  }
  const parsedDismissed = Array.isArray(dismissed)
    ? dismissed.filter((id): id is string => typeof id === 'string')
    : [];
  return { opens: parsedOpens, dismissed: parsedDismissed };
}

/** 记一次打开。去重命中时返回原对象,调用方据此跳过写盘。 */
export function recordSessionOpen(
  history: SessionOpenHistory,
  sessionId: string,
  nowMs: number,
): SessionOpenHistory {
  const previous = history.opens[sessionId];
  const last = previous?.[previous.length - 1];
  if (last !== undefined && nowMs - last < REOPEN_DEDUP_MS) return history;

  const cutoff = nowMs - PIN_SUGGESTION_WINDOW_MS;
  const kept: Array<[string, number[]]> = [];
  for (const [id, times] of Object.entries(history.opens)) {
    const recent = times.filter((t) => t > cutoff);
    if (id === sessionId) recent.push(nowMs);
    if (recent.length > 0) kept.push([id, recent.slice(-MAX_OPENS_PER_SESSION)]);
  }
  if (!previous) kept.push([sessionId, [nowMs]]);
  // 超出上限时丢掉最久没打开的任务。
  kept.sort((a, b) => b[1][b[1].length - 1] - a[1][a[1].length - 1]);
  return {
    opens: Object.fromEntries(kept.slice(0, MAX_TRACKED_SESSIONS)),
    dismissed: history.dismissed,
  };
}

export function dismissPinSuggestion(
  history: SessionOpenHistory,
  sessionId: string,
): SessionOpenHistory {
  if (history.dismissed.includes(sessionId)) return history;
  return {
    opens: history.opens,
    dismissed: [...history.dismissed, sessionId],
  };
}

function openScore(times: readonly number[], nowMs: number): number {
  let score = 0;
  for (const t of times) {
    const age = nowMs - t;
    if (age >= 0 && age < PIN_SUGGESTION_WINDOW_MS) score += 1 - age / PIN_SUGGESTION_WINDOW_MS;
  }
  return score;
}

/** 从侧栏当前可见、未置顶的任务里挑出要提示的那一个;没有达标的返回 null。 */
export function pickPinSuggestion(
  history: SessionOpenHistory,
  candidates: Iterable<Session>,
  nowMs: number,
): Session | null {
  const dismissed = new Set(history.dismissed);
  let best: Session | null = null;
  let bestScore = MIN_PIN_SUGGESTION_SCORE;
  for (const session of candidates) {
    if (session.pinnedAt != null || session.status !== 'active' || dismissed.has(session.id)) continue;
    const times = history.opens[session.id];
    if (!times) continue;
    const score = openScore(times, nowMs);
    if (score >= bestScore) {
      best = session;
      bestScore = score;
    }
  }
  return best;
}
