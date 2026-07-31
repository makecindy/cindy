import type { ScheduleFormState } from './scheduleFormLogic';

export interface UsageLimitScheduleCreateIntent {
  kind: 'usage-limit-recovery';
  requestId: string;
  sessionId: string;
  agentKind: 'claude-code' | 'codex';
  resetAtMs: number | null;
}

export interface UsageLimitScheduleLabels {
  name: string;
  prompt: string;
}

export function usageLimitScheduleNavigationState(intent: UsageLimitScheduleCreateIntent): {
  scheduleCreateIntent: UsageLimitScheduleCreateIntent;
} {
  return { scheduleCreateIntent: intent };
}

export function readUsageLimitScheduleCreateIntent(
  state: unknown,
): UsageLimitScheduleCreateIntent | null {
  if (!state || typeof state !== 'object') return null;
  const candidate = (state as { scheduleCreateIntent?: unknown }).scheduleCreateIntent;
  if (!candidate || typeof candidate !== 'object') return null;
  const value = candidate as Partial<UsageLimitScheduleCreateIntent>;
  if (
    value.kind !== 'usage-limit-recovery' ||
    typeof value.requestId !== 'string' ||
    !value.requestId ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    (value.agentKind !== 'claude-code' && value.agentKind !== 'codex') ||
    (value.resetAtMs !== null &&
      (typeof value.resetAtMs !== 'number' || !Number.isFinite(value.resetAtMs)))
  ) {
    return null;
  }
  return value as UsageLimitScheduleCreateIntent;
}

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function timePartsAt(
  timestamp: number,
  timeZone: string,
): { month: number; day: number; hour: number; minute: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    const parts: Partial<Record<'month' | 'day' | 'hour' | 'minute', number>> = {};
    for (const part of formatter.formatToParts(new Date(timestamp))) {
      if (
        part.type === 'month' ||
        part.type === 'day' ||
        part.type === 'hour' ||
        part.type === 'minute'
      ) {
        const value = Number(part.value);
        if (!Number.isFinite(value)) continue;
        // Keep parity with maker-scheduler's wallClock(): some Intl
        // implementations report midnight as 24 even with hourCycle=h23.
        parts[part.type] = part.type === 'hour' && value === 24 ? 0 : value;
      }
    }
    if (
      parts.month === undefined ||
      parts.day === undefined ||
      parts.hour === undefined ||
      parts.minute === undefined
    ) {
      return null;
    }
    return parts as { month: number; day: number; hour: number; minute: number };
  } catch {
    return null;
  }
}

/** Convert reset + one minute into the existing scheduler's one-shot cron shape. */
export function oneTimeCronAfterUsageReset(
  resetAtMs: number | null,
  timeZone: string,
  nowMs = Date.now(),
): string {
  if (resetAtMs === null || !Number.isFinite(resetAtMs)) return '';
  const runAtMs = resetAtMs + 60_000;
  if (runAtMs <= nowMs) return '';
  const parts = timePartsAt(runAtMs, timeZone);
  if (!parts) return '';
  return `${parts.minute} ${parts.hour} ${parts.day} ${parts.month} *`;
}

export function buildUsageLimitScheduleFormOverrides(
  intent: UsageLimitScheduleCreateIntent,
  labels: UsageLimitScheduleLabels,
  nowMs = Date.now(),
): Partial<ScheduleFormState> {
  const timezone = systemTimeZone();
  return {
    name: labels.name,
    prompt: labels.prompt,
    executionMode: 'agent',
    cronExpr: oneTimeCronAfterUsageReset(intent.resetAtMs, timezone, nowMs),
    intervalMs: undefined,
    timezone,
    recurring: false,
    manual: false,
    agentKind: intent.agentKind,
    model: '',
    providerId: '',
    effort: '',
    fastMode: false,
    workspaceKind: 'dialogue',
    workingDir: '',
    useWorktree: false,
    targetSessionId: intent.sessionId,
    persistentSession: false,
  };
}
