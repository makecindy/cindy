import { and, eq, or, sql } from 'drizzle-orm';

import { scheduleRuns, scheduleSessionBindings, schedules, sessions } from './schema.js';

export const LEGACY_SCHEDULE_TITLE_PREFIX = '[Schedule] ';

/**
 * Matches only the historical generated-title shape. The comparison is kept
 * case-sensitive by SQLite's substr equality and rejects an empty suffix.
 */
export function strictLegacyScheduleTitleWhere() {
  return and(
    sql`substr(${sessions.title}, 1, ${LEGACY_SCHEDULE_TITLE_PREFIX.length}) = ${LEGACY_SCHEDULE_TITLE_PREFIX}`,
    sql`length(trim(substr(${sessions.title}, ${LEGACY_SCHEDULE_TITLE_PREFIX.length + 1}))) > 0`,
  );
}

/** Associations which remain valid after a schedule is rebound elsewhere. */
export function schedulerGeneratedScheduleSessionBindingWhere() {
  return or(
    eq(sessions.source, 'scheduler'),
    and(
      strictLegacyScheduleTitleWhere(),
      eq(schedules.legacySessionFallback, true),
    ),
  );
}

/**
 * A sidebar-index association remains valid when it is generated/legacy
 * history, or still points at the schedule's current ordinary target session.
 */
function validScheduleSessionWhere(
  sessionId: typeof scheduleSessionBindings.sessionId | typeof scheduleRuns.sessionId,
) {
  return or(
    schedulerGeneratedScheduleSessionBindingWhere(),
    eq(schedules.targetSessionId, sessionId),
  );
}

export function validScheduleSessionBindingWhere() {
  return validScheduleSessionWhere(scheduleSessionBindings.sessionId);
}

export function validScheduleSessionRunWhere() {
  return validScheduleSessionWhere(scheduleRuns.sessionId);
}
