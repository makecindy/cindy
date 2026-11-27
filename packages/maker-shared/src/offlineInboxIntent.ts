import { INDEFINITE_SNOOZE_UNTIL, taskSnoozeUntil } from './liveTaskPriority.js';
import { getSessionListActivityAt } from './sessionActivity.js';

export type OfflineInboxIntentKind = 'snooze' | 'complete';

export interface OfflineInboxIntent {
  deviceId: string;
  sessionId: string;
  kind: OfflineInboxIntentKind;
  /** ISO timestamp (including INDEFINITE_SNOOZE_UNTIL) or null (wake). Only present when kind === 'snooze'. */
  snoozedUntil?: string | null;
  /** ISO timestamp when the user queued the action on this controller. */
  createdAt: string;
  /** Host-clock activity timestamp captured from the cached snapshot (`lastActivityAt ?? userSendAt ?? updatedAt`). */
  basedOnActivityAt: string | null;
  /** Host-clock `userSendAt` captured from the cached snapshot. */
  basedOnUserSendAt: string | null;
  /** Optional truncated title snapshot for bounce-back notices on reconnect. */
  sessionTitle?: string;
  /** Optional truncated device name snapshot for bounce-back notices on reconnect. */
  deviceName?: string;
}

export interface OfflineInboxSessionSnapshot {
  status?: string;
  pinnedAt?: string | null;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  archivedAt?: string | null;
  userSendAt?: string | null;
  lastActivityAt?: string | null;
  updatedAt?: string | null;
  title?: string | null;
  deviceLinkDeviceName?: string | null;
  /** Host-authoritative IM attachment flag returned by `local-db:sessions:get`. */
  imAttached?: boolean;
}

export interface OfflineInboxReplayLiveState {
  isRunning?: boolean;
  isAttached?: boolean;
  nowMs?: number;
}

export type OfflineInboxReplayDropReason =
  | 'already-applied'
  | 'session-missing'
  | 'session-archived'
  | 'superseded-by-activity'
  | 'expired';

export type OfflineInboxReplayRejectReason =
  | 'new-activity'
  | 'running'
  | 'attached'
  | 'dirty-worktree'
  | 'preflight-unknown';

export type OfflineInboxReplayDecision =
  | { action: 'apply-snooze'; snoozedUntil: string | null }
  | { action: 'apply-complete' }
  | { action: 'drop'; reason: OfflineInboxReplayDropReason }
  | { action: 'reject'; reason: OfflineInboxReplayRejectReason };

export const MAX_OFFLINE_INBOX_INTENTS = 200;
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 200;

export function offlineInboxIntentKey(deviceId: string, sessionId: string): string {
  return `${deviceId.trim()}\u0000${sessionId.trim()}`;
}

function parseIsoMs(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  return Date.parse(value);
}

function normalizeOptionalIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

function normalizeOptionalLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_CHARS) : undefined;
}

function maxIsoTimestamp(a: string, b: string | null | undefined): string {
  const aMs = parseIsoMs(a);
  const bMs = parseIsoMs(b);
  if (Number.isFinite(bMs) && (!Number.isFinite(aMs) || bMs > aMs)) return b!.trim();
  return a;
}

export function normalizeOfflineInboxIntent(raw: unknown): OfflineInboxIntent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId.trim() : '';
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  if (!deviceId || deviceId.length > MAX_ID_CHARS || !sessionId || sessionId.length > MAX_ID_CHARS) {
    return null;
  }
  const kind = record.kind;
  if (kind !== 'snooze' && kind !== 'complete') return null;
  const createdAt = normalizeOptionalIso(record.createdAt);
  if (!createdAt) return null;
  const basedOnActivityAt = normalizeOptionalIso(record.basedOnActivityAt);
  const basedOnUserSendAt = normalizeOptionalIso(record.basedOnUserSendAt);
  const sessionTitle = normalizeOptionalLabel(record.sessionTitle);
  const deviceName = normalizeOptionalLabel(record.deviceName);
  if (kind === 'snooze') {
    const rawUntil = record.snoozedUntil;
    let snoozedUntil: string | null;
    if (rawUntil === null) {
      snoozedUntil = null;
    } else if (rawUntil === INDEFINITE_SNOOZE_UNTIL) {
      snoozedUntil = INDEFINITE_SNOOZE_UNTIL;
    } else {
      const normalized = normalizeOptionalIso(rawUntil);
      if (!normalized) return null;
      snoozedUntil = normalized;
    }
    return {
      deviceId,
      sessionId,
      kind,
      snoozedUntil,
      createdAt,
      basedOnActivityAt,
      basedOnUserSendAt,
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(deviceName ? { deviceName } : {}),
    };
  }
  return {
    deviceId,
    sessionId,
    kind,
    createdAt,
    basedOnActivityAt,
    basedOnUserSendAt,
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(deviceName ? { deviceName } : {}),
  };
}

export function normalizeOfflineInboxIntents(raw: unknown): OfflineInboxIntent[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, OfflineInboxIntent>();
  for (const item of raw) {
    const intent = normalizeOfflineInboxIntent(item);
    if (!intent) continue;
    const key = offlineInboxIntentKey(intent.deviceId, intent.sessionId);
    const existing = byKey.get(key);
    if (!existing || Date.parse(intent.createdAt) >= Date.parse(existing.createdAt)) {
      byKey.set(key, intent);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_OFFLINE_INBOX_INTENTS);
}

/** Capture host-clock activity anchors from the cached session snapshot at offline action time. */
export function captureSessionActivityAnchor(
  session: Pick<OfflineInboxSessionSnapshot, 'lastActivityAt' | 'userSendAt' | 'updatedAt'>,
): { basedOnActivityAt: string | null; basedOnUserSendAt: string | null } {
  const listActivity = getSessionListActivityAt({
    lastActivityAt: session.lastActivityAt ?? null,
    userSendAt: session.userSendAt ?? null,
    updatedAt: session.updatedAt ?? null,
  });
  return {
    basedOnActivityAt: normalizeOptionalIso(listActivity),
    basedOnUserSendAt: normalizeOptionalIso(session.userSendAt),
  };
}

export function createOfflineCompleteIntent(
  deviceId: string,
  sessionId: string,
  session: OfflineInboxSessionSnapshot,
  nowIso: string = new Date().toISOString(),
): OfflineInboxIntent {
  const { basedOnActivityAt, basedOnUserSendAt } = captureSessionActivityAnchor(session);
  const sessionTitle = normalizeOptionalLabel(session.title);
  const deviceName = normalizeOptionalLabel(session.deviceLinkDeviceName);
  return {
    deviceId: deviceId.trim(),
    sessionId: sessionId.trim(),
    kind: 'complete',
    createdAt: nowIso,
    basedOnActivityAt,
    basedOnUserSendAt,
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(deviceName ? { deviceName } : {}),
  };
}

/**
 * Build an offline snooze/wake intent against the host's last known snapshot.
 * Returns `null` when waking a task whose cached host snapshot was not snoozed
 * (the caller should simply remove any queued offline snooze intent instead of queueing a no-op).
 */
export function resolveOfflineSnoozeIntent(
  deviceId: string,
  sessionId: string,
  rawHostSession: OfflineInboxSessionSnapshot,
  snoozedUntil: string | null,
  nowIso: string = new Date().toISOString(),
): OfflineInboxIntent | null {
  if (snoozedUntil === null && taskSnoozeUntil(rawHostSession) <= 0) {
    return null;
  }
  const { basedOnActivityAt, basedOnUserSendAt } = captureSessionActivityAnchor(rawHostSession);
  const sessionTitle = normalizeOptionalLabel(rawHostSession.title);
  const deviceName = normalizeOptionalLabel(rawHostSession.deviceLinkDeviceName);
  return {
    deviceId: deviceId.trim(),
    sessionId: sessionId.trim(),
    kind: 'snooze',
    snoozedUntil,
    createdAt: nowIso,
    basedOnActivityAt,
    basedOnUserSendAt,
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(deviceName ? { deviceName } : {}),
  };
}

/**
 * Apply an offline inbox intent onto a cached session row in the projection layer.
 * Preserves reference identity when no change is needed.
 */
export function projectSessionWithOfflineInboxIntent<T extends OfflineInboxSessionSnapshot>(
  session: T,
  intent: OfflineInboxIntent | undefined,
): T {
  if (!intent) return session;
  if (intent.kind === 'complete') {
    const archivedAt = session.status === 'archived' && session.archivedAt ? session.archivedAt : intent.createdAt;
    if (
      session.status === 'archived' &&
      session.pinnedAt == null &&
      session.snoozedUntil == null &&
      session.snoozedAt == null &&
      session.archivedAt === archivedAt
    ) {
      return session;
    }
    return {
      ...session,
      status: 'archived',
      pinnedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      archivedAt,
    };
  }
  const until = intent.snoozedUntil ?? null;
  if (until === null) {
    if (session.snoozedUntil == null && session.snoozedAt == null) return session;
    return { ...session, snoozedUntil: null, snoozedAt: null };
  }
  // Protect local projection from controller clocks trailing the remote host clock:
  // taskSnoozeUntil treats `userSendAt > snoozedAt` as woken.
  const snoozedAt = maxIsoTimestamp(intent.createdAt, session.userSendAt);
  if (session.snoozedUntil === until && session.snoozedAt === snoozedAt) return session;
  return { ...session, snoozedUntil: until, snoozedAt };
}

/**
 * Apply an offline snooze/wake intent onto a teammate conversation's `inboxSnooze` snapshot.
 */
export function projectTeammateSnoozeWithOfflineInboxIntent<
  T extends { snoozedUntil: string | null; snoozedAt: string | null; userSendAt: string | null },
>(snooze: T | null, intent: OfflineInboxIntent | undefined): T | null {
  if (!snooze || !intent || intent.kind !== 'snooze') return snooze;
  const until = intent.snoozedUntil ?? null;
  if (until === null) {
    if (snooze.snoozedUntil === null && snooze.snoozedAt === null) return snooze;
    return { ...snooze, snoozedUntil: null, snoozedAt: null };
  }
  const snoozedAt = maxIsoTimestamp(intent.createdAt, snooze.userSendAt);
  if (snooze.snoozedUntil === until && snooze.snoozedAt === snoozedAt) return snooze;
  return { ...snooze, snoozedUntil: until, snoozedAt };
}

/**
 * Evaluate whether a queued offline inbox intent should be replayed, dropped, or rejected
 * once the owning computer reconnects and returns fresh authoritative session state.
 * All activity comparisons stay strictly in the host's clock domain.
 */
export function evaluateOfflineInboxIntentReplay(
  intent: OfflineInboxIntent,
  freshSession: OfflineInboxSessionSnapshot | null,
  liveState: OfflineInboxReplayLiveState = {},
): OfflineInboxReplayDecision {
  if (!freshSession) return { action: 'drop', reason: 'session-missing' };

  const nowMs = liveState.nowMs ?? Date.now();
  const freshAnchor = captureSessionActivityAnchor(freshSession);
  const baseActivityMs = parseIsoMs(intent.basedOnActivityAt);
  const freshActivityMs = parseIsoMs(freshAnchor.basedOnActivityAt);
  const baseUserSendMs = parseIsoMs(intent.basedOnUserSendAt);
  const freshUserSendMs = parseIsoMs(freshAnchor.basedOnUserSendAt);

  if (intent.kind === 'snooze') {
    if (freshSession.status === 'archived' || freshSession.status === 'deleted') {
      return { action: 'drop', reason: 'session-archived' };
    }
    const until = intent.snoozedUntil ?? null;
    if (until !== null) {
      if (until !== INDEFINITE_SNOOZE_UNTIL) {
        const untilMs = parseIsoMs(until);
        if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
          return { action: 'drop', reason: 'expired' };
        }
      }
      // If the host received new user/automation input after our cached snapshot,
      // new input wakes a snoozed task — drop the stale offline snooze.
      const userSendBaselineMs = Number.isFinite(baseUserSendMs) ? baseUserSendMs : baseActivityMs;
      if (
        Number.isFinite(freshUserSendMs) &&
        (!Number.isFinite(userSendBaselineMs) || freshUserSendMs > userSendBaselineMs)
      ) {
        return { action: 'drop', reason: 'superseded-by-activity' };
      }
    }
    if ((freshSession.snoozedUntil ?? null) === until) {
      return { action: 'drop', reason: 'already-applied' };
    }
    return { action: 'apply-snooze', snoozedUntil: until };
  }

  // kind === 'complete'
  if (freshSession.status === 'archived' || freshSession.status === 'deleted') {
    return { action: 'drop', reason: 'already-applied' };
  }
  const hasNewerActivity =
    (Number.isFinite(freshActivityMs) &&
      Number.isFinite(baseActivityMs) &&
      freshActivityMs > baseActivityMs) ||
    (Number.isFinite(freshUserSendMs) &&
      (!Number.isFinite(baseUserSendMs)
        ? !Number.isFinite(baseActivityMs) || freshUserSendMs > baseActivityMs
        : freshUserSendMs > baseUserSendMs));
  if (hasNewerActivity) {
    return { action: 'reject', reason: 'new-activity' };
  }
  if (liveState.isRunning) {
    return { action: 'reject', reason: 'running' };
  }
  if (liveState.isAttached === true || freshSession.imAttached === true) {
    return { action: 'reject', reason: 'attached' };
  }
  if (liveState.isAttached !== false && freshSession.imAttached !== false) {
    return { action: 'reject', reason: 'preflight-unknown' };
  }
  return { action: 'apply-complete' };
}
