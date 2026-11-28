import type Database from 'better-sqlite3';

/**
 * The retired V1 routine engine could open one teammate task per run ("new task each time",
 * `route_key = 'routine:<routine>:<uuid>'`). Before it learned to discard them (2026-10-30), a run its
 * pre-run check stopped left such a task behind with nothing in it; those were later archived into the
 * teammate's history. Delete only those: a single-run task, archived, with no message (rewound ones
 * included), that the caller's V1 run records prove never reached the model (`neverDispatchedSessionIds`,
 * read by botV1Routines.ts), and that no value anywhere else in the database refers to (read from the live
 * schema, so a table added later is checked too). A reused task (`routine:<routine>`) is always kept.
 * One transaction, safe to repeat: a second run finds nothing.
 */
/** Routine ids are `[A-Za-z0-9_-]` only, so this never matches a reused task's key. */
const SINGLE_RUN_ROUTE_KEY = /^routine:[A-Za-z0-9_-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CANDIDATES_SQL = `SELECT l.session_id AS id, l.route_key AS routeKey, l.bot_id AS botId FROM bot_session_links l
  JOIN sessions s ON s.id = l.session_id
  WHERE l.role = 'history' AND l.route_key GLOB 'routine:?*' AND l.archived_at IS NOT NULL
    AND s.source = 'bot' AND s.status = 'archived'
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = l.session_id)`;

/** In `messages`, the columns that are, or may be, a task id (a false match only keeps more). */
const TASK_REFERENCE_COLUMN = /session|task_id|lead/i;

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Every column of every ordinary table is compared, so references without a foreign key or a telling
 * name (such as `media_refs.ref_id`) count too. Not compared: the candidates' own rows (`sessions.id`,
 * their `bot_session_links`), search and vector indexes (virtual tables and their shadow tables, derived
 * from other rows), and in `messages`, which can be very large, the columns that cannot name a task.
 */
function referenceColumns(db: Database.Database): Array<{ table: string; columns: string[] }> {
  // `type = 'table'` leaves out views, virtual tables and the shadow tables behind them.
  const tables = db.prepare(`SELECT name FROM pragma_table_list
    WHERE schema = 'main' AND type = 'table' AND name NOT GLOB 'sqlite_*'`).pluck().all() as string[];
  const found: Array<{ table: string; columns: string[] }> = [];
  for (const table of tables) {
    let columns = (db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[]);
    if (table === 'messages') {
      const keys = (db.prepare('SELECT "from" FROM pragma_foreign_key_list(?) WHERE "table" = \'sessions\'')
        .pluck().all(table) as string[]);
      columns = columns.filter((column) => TASK_REFERENCE_COLUMN.test(column) || keys.includes(column));
    }
    if (table === 'sessions') columns = columns.filter((column) => column !== 'id');
    if (table === 'bot_session_links') columns = columns.filter((column) => column !== 'id' && column !== 'session_id');
    if (columns.length > 0) found.push({ table, columns });
  }
  return found;
}

export function botsPruneEmptyLegacyRoutineHistory(db: Database.Database, args: unknown): { removed: number; botIds: string[] } {
  const evidence = (args as { neverDispatchedSessionIds?: unknown } | null)?.neverDispatchedSessionIds;
  if (!Array.isArray(evidence)) throw new Error('neverDispatchedSessionIds must be an array');
  const neverDispatched = new Set(evidence.filter((id): id is string => typeof id === 'string'));
  return db.transaction(() => {
    const rows = (db.prepare(CANDIDATES_SQL).all() as Array<{ id: string; routeKey: string; botId: string }>)
      .filter(({ id, routeKey }) => SINGLE_RUN_ROUTE_KEY.test(routeKey) && neverDispatched.has(id));
    const candidates = rows.map(({ id }) => id);
    if (candidates.length === 0) return { removed: 0, botIds: [] };
    const pending = new Set(candidates);
    const referenced = new Set<string>();
    const ids = JSON.stringify(candidates);
    // One scan per table, and only when there is something to delete.
    for (const { table, columns } of referenceColumns(db)) {
      const rows = db.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)}
        WHERE ${columns.map((column) => `${quote(column)} IN (SELECT value FROM json_each(@ids))`).join(' OR ')}`)
        .raw().all({ ids }) as unknown[][];
      for (const row of rows) {
        for (const value of row) if (typeof value === 'string' && pending.has(value)) referenced.add(value);
      }
    }
    // The delete repeats the whole condition on the row itself, not only the earlier read.
    const removeSession = db.prepare(`DELETE FROM sessions WHERE id = @id AND source = 'bot' AND status = 'archived'
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = @id)
      AND EXISTS (SELECT 1 FROM bot_session_links l WHERE l.session_id = @id AND l.role = 'history'
        AND l.route_key GLOB 'routine:?*' AND l.archived_at IS NOT NULL)`);
    // The link cascades with its task; delete it explicitly too so no link can outlive it.
    const removeLink = db.prepare('DELETE FROM bot_session_links WHERE session_id = ?');
    let removed = 0;
    const botIds = new Set<string>();
    for (const { id, botId } of rows) {
      if (referenced.has(id) || removeSession.run({ id }).changes !== 1) continue;
      removeLink.run(id);
      removed += 1;
      botIds.add(botId);
    }
    return { removed, botIds: [...botIds] };
  })();
}
