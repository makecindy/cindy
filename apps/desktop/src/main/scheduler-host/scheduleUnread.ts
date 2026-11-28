import { sql, type SQLWrapper } from 'drizzle-orm';

type RunTable = 'failed' | 'schedule_runs';

/** Older public schedules can have a NULL source. */
export const publicSchedule = sql`schedules.source IS NOT 'bot'`;

export const unreadTerminalRunWhere = () =>
  sql`schedule_runs.read_at IS NULL AND schedule_runs.status IN ('success', 'failed', 'aborted', 'interrupted')`;

/** Old precheck failures can have only the fixed host prefix and no valid hook metadata. */
function precheckSourceSql(alias: RunTable) {
  const row = sql.raw(alias);
  return sql`CASE
    WHEN CASE WHEN json_valid(${row}.pre_run_hook_result)
      THEN json_extract(${row}.pre_run_hook_result, '$.decision') END = 'block' THEN 'hook'
    WHEN substr(${row}.error_msg, 1, 12) = 'pre-run hook' THEN 'legacy'
  END`;
}

/** SQL counterpart of classifyScheduleFailure. Only detailed failure classification needs stderr. */
export function failureKindSql(alias: RunTable) {
  const row = sql.raw(alias);
  return sql<'precheck' | 'rate-limit' | 'execution'>`CASE ${precheckSourceSql(alias)}
    WHEN 'hook' THEN CASE WHEN lower(json_extract(${row}.pre_run_hook_result, '$.stderr')) LIKE '%rate limit%'
      THEN 'rate-limit' ELSE 'precheck' END
    WHEN 'legacy' THEN 'precheck'
    ELSE 'execution' END`;
}

/** A later success recovers any failure of that automation. A healthy check recovers only a precheck. */
export function failureRecoveredSql(alias: RunTable) {
  const row = sql.raw(alias);
  return sql<boolean>`CASE WHEN ${row}.status IN ('failed', 'interrupted') THEN EXISTS (
    SELECT 1 FROM schedule_runs AS recovered
    WHERE recovered.schedule_id = ${row}.schedule_id
      AND recovered.fired_at >= ${row}.fired_at
      AND (recovered.fired_at > ${row}.fired_at
        OR (recovered.fired_at = ${row}.fired_at AND recovered.id > ${row}.id))
      AND (recovered.status = 'success' OR (
        recovered.status IN ('skipped', 'failed')
        AND CASE WHEN json_valid(recovered.pre_run_hook_result)
          THEN json_extract(recovered.pre_run_hook_result, '$.checkSucceeded') = 1 ELSE 0 END
        AND ${precheckSourceSql(alias)} IS NOT NULL
      ))
  ) ELSE 0 END`;
}

const publicRuns = sql`FROM schedule_runs JOIN schedules ON schedules.id = schedule_runs.schedule_id
  WHERE ${publicSchedule}`;

/** Shared sidebar window. Aborted and recovered rows consume slots, including unbound runs. */
export const recentUnreadRunIds = sql`(SELECT schedule_runs.id ${publicRuns} AND ${unreadTerminalRunWhere()}
  ORDER BY schedule_runs.fired_at DESC, schedule_runs.id DESC LIMIT 200)`;

export function latestUnresolvedFailureId(sessionId: SQLWrapper) {
  return sql`(SELECT failed.id FROM schedule_runs AS failed
    WHERE failed.session_id = ${sessionId} AND failed.status IN ('failed', 'interrupted')
      AND NOT ${failureRecoveredSql('failed')}
    ORDER BY failed.fired_at DESC, failed.id DESC LIMIT 1)`;
}

// Only the newest eligible run of each kind can add a dot. If it misses the window,
// every older one does too. The latest mapping and latest unresolved failure always qualify.
function hasSidebarUnread(kind: 'failure' | 'success') {
  const alwaysIncludedId = kind === 'success'
    ? sql`latest.run_id`
    : latestUnresolvedFailureId(sql`latest.session_id`);
  const eligible = kind === 'success'
    ? sql`schedule_runs.status = 'success'`
    : sql`schedule_runs.status IN ('failed', 'interrupted') AND NOT ${failureRecoveredSql('schedule_runs')}`;
  // A zero legacy receipt is falsy in the renderer, but absent from the SQL unread window.
  return sql`EXISTS (SELECT 1 FROM (
    SELECT schedule_runs.id ${publicRuns} AND schedule_runs.session_id = latest.session_id
      AND (schedule_runs.read_at IS NULL OR (schedule_runs.read_at = 0 AND schedule_runs.id = ${alwaysIncludedId}))
      AND ${eligible}
    ORDER BY schedule_runs.fired_at DESC, schedule_runs.id DESC LIMIT 1
  ) AS candidate WHERE CASE WHEN candidate.id = ${alwaysIncludedId} THEN 1
    ELSE candidate.id IN (SELECT id FROM recent) END)`;
}

/** For a batch of known session rows, materialize the native window only on the first historical candidate. */
export const scheduleUnreadSessionStatus = sql<'error' | 'done' | null>`(
  WITH recent(id) AS MATERIALIZED ${recentUnreadRunIds}
  SELECT CASE
    WHEN ${hasSidebarUnread('failure')} THEN 'error'
    WHEN ${hasSidebarUnread('success')} THEN 'done'
  END
  FROM schedule_session_latest_runs AS latest WHERE latest.session_id = sessions.id
)`;
