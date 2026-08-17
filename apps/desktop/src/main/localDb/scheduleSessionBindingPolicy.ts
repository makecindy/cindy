import { and, eq, or, sql } from 'drizzle-orm';

import { scheduleSessionBindings, schedules, sessions } from './schema.js';

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
 * A persisted binding is visible when it is generated/legacy history, or when
 * it still points at the schedule's current ordinary target session.
 */
export function validScheduleSessionBindingWhere() {
  return or(
    schedulerGeneratedScheduleSessionBindingWhere(),
    eq(schedules.targetSessionId, scheduleSessionBindings.sessionId),
  );
}
