import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** ASCII whitespace stripped when checking whether a schedule specifies a model override. */
const SQLITE_ASCII_WHITESPACE = ' \t\n\r';

export interface BoundSchedulePluginRouteShape {
  executionMode?: string | null;
  source?: string | null;
  modelAgentKind?: string | null;
  model?: string | null;
  providerId?: string | null;
  effort?: string | null;
}

export interface BoundSchedulePluginRouteSqlColumns {
  executionMode: SQLWrapper;
  source: SQLWrapper;
  modelAgentKind: SQLWrapper;
  model: SQLWrapper;
  providerId: SQLWrapper;
  effort: SQLWrapper;
}

/**
 * Matches `boundPluginEngineRefusal` in `scheduler-host/runner.ts`:
 * an agent automation bound to a local plugin-engine task runs on the task's
 * own engine and model; only a bot routine or an explicit model/provider/effort
 * choice conflicts with a local plugin-engine target. Script automations only
 * bind for lifecycle ownership and do not run LLM turns on the target.
 */
export function scheduleRequiresNonPluginBoundTarget(
  schedule: BoundSchedulePluginRouteShape,
): boolean {
  if (schedule.executionMode === 'script') return false;
  return (
    schedule.source === 'bot' ||
    Boolean(schedule.modelAgentKind?.trim()) ||
    Boolean(schedule.model?.trim()) ||
    Boolean(schedule.providerId?.trim()) ||
    Boolean(schedule.effort?.trim())
  );
}

/**
 * Strictly boolean SQL predicate (never NULL) matching the schedule-side
 * refusal criteria of `boundPluginEngineRefusal` for a local plugin-engine task.
 */
export function boundScheduleRefusesLocalPluginEngineSql(
  cols: Pick<BoundSchedulePluginRouteSqlColumns, 'source' | 'modelAgentKind' | 'model' | 'providerId' | 'effort'>,
): SQL {
  return sql`(
    coalesce(${cols.source}, 'user') = 'bot'
    OR trim(coalesce(${cols.modelAgentKind}, ''), ${SQLITE_ASCII_WHITESPACE}) != ''
    OR trim(coalesce(${cols.model}, ''), ${SQLITE_ASCII_WHITESPACE}) != ''
    OR trim(coalesce(${cols.providerId}, ''), ${SQLITE_ASCII_WHITESPACE}) != ''
    OR trim(coalesce(${cols.effort}, ''), ${SQLITE_ASCII_WHITESPACE}) != ''
  )`;
}

/**
 * Strictly boolean SQL predicate (never NULL) for whether a bound schedule row
 * conflicts with a local plugin-engine target.
 */
export function boundScheduleBlocksPluginEngineSql(
  cols: BoundSchedulePluginRouteSqlColumns,
): SQL {
  return sql`(
    coalesce(${cols.executionMode}, 'agent') != 'script'
    AND ${boundScheduleRefusesLocalPluginEngineSql(cols)}
  )`;
}
