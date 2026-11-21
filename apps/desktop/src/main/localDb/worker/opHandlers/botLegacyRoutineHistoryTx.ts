import type Database from 'better-sqlite3';

/**
 * The retired V1 routine engine opened one teammate task per run (`route_key = 'routine:…'`). Runs that
 * were archived into the teammate's history without a single message are empty shells: nothing to
 * read or search, yet every teammate profile read still walks their links. Delete only those.
 *
 * A candidate is kept when anything at all points at it: any message (rewound ones included), or any
 * column elsewhere in the database that references a task (found from the live schema, so a table
 * added later is checked too). One transaction, safe to repeat: a second run finds nothing.
 */
const CANDIDATES_SQL = `SELECT l.session_id FROM bot_session_links l
  JOIN sessions s ON s.id = l.session_id
  WHERE l.role = 'history' AND l.route_key GLOB 'routine:?*' AND l.archived_at IS NOT NULL
    AND s.source = 'bot' AND s.status = 'archived'
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = l.session_id)`;

/** Columns that are, or may be, a task id. Names are matched broadly: a false match only keeps more. */
const TASK_REFERENCE_COLUMN = /session|task_id|lead/i;
const CHUNK = 500;

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function taskReferenceColumns(db: Database.Database): Array<{ table: string; column: string }> {
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND (sql IS NULL OR sql NOT LIKE 'CREATE VIRTUAL TABLE%')`)
    .pluck().all() as string[];
  const found: Array<{ table: string; column: string }> = [];
  for (const table of tables) {
    const columns = new Set<string>();
    for (const { name } of db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>) {
      if (TASK_REFERENCE_COLUMN.test(name)) columns.add(name);
    }
    for (const fk of db.prepare('SELECT "table" AS target, "from" AS source FROM pragma_foreign_key_list(?)')
      .all(table) as Array<{ target: string; source: string }>) {
      if (fk.target === 'sessions') columns.add(fk.source);
    }
    for (const column of columns) {
      // The candidate's own link is what this cleanup removes.
      if (table === 'bot_session_links' && column === 'session_id') continue;
      found.push({ table, column });
    }
  }
  return found;
}

export function botsPruneEmptyLegacyRoutineHistory(db: Database.Database): { removed: number } {
  return db.transaction(() => {
    const candidates = db.prepare(CANDIDATES_SQL).pluck().all() as string[];
    if (candidates.length === 0) return { removed: 0 };
    const referenced = new Set<string>();
    for (const { table, column } of taskReferenceColumns(db)) {
      for (let start = 0; start < candidates.length; start += CHUNK) {
        const chunk = candidates.slice(start, start + CHUNK);
        const rows = db.prepare(`SELECT DISTINCT ${quote(column)} FROM ${quote(table)}
          WHERE ${quote(column)} IN (${chunk.map(() => '?').join(', ')})`).pluck().all(...chunk) as unknown[];
        for (const id of rows) if (typeof id === 'string') referenced.add(id);
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
    for (const id of candidates) {
      if (referenced.has(id) || removeSession.run({ id }).changes !== 1) continue;
      removeLink.run(id);
      removed += 1;
    }
    return { removed };
  })();
}
