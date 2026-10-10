import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { sessions, messages, taskTags, sessionTaskTags } from '../schema';
import { selectSessionListRows } from '../sessionQueries';
import type { DbClient } from '../client/DbClient';

it('pages the actual list query across tied timestamps without skipping or repeating rows', async () => {
  const sqlite = new Database(':memory:');
  try {
    // Derive columns from production schema; no account DB or migrations are touched.
    for (const table of [sessions, messages, taskTags, sessionTaskTags]) {
      sqlite.exec(
        `CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
          .map((column) => `"${column.name}" ${column.getSQLType()}`)
          .join(',')})`,
      );
    }
    const db = drizzle(sqlite) as unknown as DbClient['drizzle'];
    const insert = sqlite.prepare(
      'INSERT INTO sessions (id,status,updated_at,list_preview,list_message_count) VALUES (?,?,?, ?,0)',
    );
    for (let n = 0; n < 507; n++)
      insert.run(`s${String(n).padStart(4, '0')}`, 'archived', Math.floor(n / 3), 'cached preview');
    insert.run('active', 'active', 200, 'active');
    insert.run('deleted', 'deleted', 200, 'deleted');
    const ids: string[] = [];
    let before: { id: string; updatedAt: number } | undefined;
    for (;;) {
      const rows = await selectSessionListRows(db, eq(sessions.status, 'archived'), 200, before);
      ids.push(...rows.map((row) => row.session.id));
      const tail = rows.at(-1)?.session;
      if (rows.length < 200 || !tail) break;
      before = { id: tail.id, updatedAt: tail.updatedAt };
    }
    expect(ids).toHaveLength(507);
    expect(new Set(ids).size).toBe(507);
    expect(ids).toEqual(
      Array.from({ length: 507 }, (_, n) => `s${String(506 - n).padStart(4, '0')}`),
    );
    expect(sqlite.prepare('SELECT status FROM sessions WHERE id=?').get('s0000')).toEqual({
      status: 'archived',
    });
  } finally {
    sqlite.close();
  }
});
