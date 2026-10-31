import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { sessions, messages, taskTags, sessionTaskTags, botSessionLinks, botProfiles } from '../schema';
import { selectSessionListRows, ordinaryTaskListFilter, flattenSessionReadRow } from '../sessionQueries';
import type { DbClient } from '../client/DbClient';

it('pages the actual list query across tied timestamps without skipping or repeating rows', async () => {
  const sqlite = new Database(':memory:');
  try {
    // Derive columns from production schema; no account DB or migrations are touched.
    for (const table of [sessions, messages, taskTags, sessionTaskTags, botSessionLinks]) {
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
    sqlite.prepare('UPDATE sessions SET last_activity_at=? WHERE id=?').run(900, 's0506');
    const first = await selectSessionListRows(db, eq(sessions.status, 'archived'), 1);
    expect(first[0].session.lastActivityAt).toBe(900);
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

// Unit: actual list SQL and attribution projection, including previously hidden existing lanes.
it('lists linked teammate routine/channel tasks, keeping private lanes and hidden owners out', async () => {
  const sqlite = new Database(':memory:');
  try {
    for (const table of [sessions, messages, taskTags, sessionTaskTags, botSessionLinks, botProfiles]) {
      sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
        .map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
    }
    sqlite.exec("INSERT INTO bot_profiles(id,status) VALUES ('owner','active'),('removed','deleting');");
    const insert = sqlite.prepare("INSERT INTO sessions(id,source,status,updated_at,list_preview,list_message_count) VALUES (?, ?, ?,1,'',0)");
    const link = sqlite.prepare('INSERT INTO bot_session_links(bot_id,session_id,role,route_key) VALUES (?,?,?,?)');
    for (const role of ['routine', 'channel', 'canonical', 'group', 'thread']) {
      insert.run(role, 'bot', role === 'routine' ? 'archived' : 'active');
      link.run('owner', role, role, role === 'channel' ? 'im:feishu:chat'
        // 「每次新建任务」的例行任务专线在规则 id 后追加 `:<uuid>`。
        : role === 'routine' ? 'routine:daily-1:3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b' : null);
    }
    insert.run('routine-persistent', 'bot', 'active');
    link.run('owner', 'routine-persistent', 'routine', 'routine:daily-1');
    for (const id of ['unlinked', 'removed', 'hidden']) insert.run(id, 'bot', 'active');
    link.run('removed', 'removed', 'routine', null);
    link.run('owner', 'hidden', 'channel', null);
    sqlite.exec("UPDATE sessions SET hidden_at=1 WHERE id='hidden'");
    insert.run('ordinary', 'desktop', 'active');
    const db = drizzle(sqlite) as unknown as DbClient['drizzle'];
    const rows = await selectSessionListRows(db, ordinaryTaskListFilter(), 100);
    expect(rows.map(row => row.session.id).sort()).toEqual(['channel', 'ordinary', 'routine', 'routine-persistent']);
    expect(flattenSessionReadRow(rows.find(row => row.session.id === 'channel')!).companion)
      .toEqual({ id: 'owner', role: 'channel', channel: 'feishu' });
    // 两种运行方式都投影出同一条规则 id，侧栏据此把同规则的运行收进一个文件夹。
    for (const id of ['routine', 'routine-persistent']) {
      expect(flattenSessionReadRow(rows.find(row => row.session.id === id)!).companion)
        .toEqual({ id: 'owner', role: 'routine', routineId: 'daily-1' });
    }
  } finally { sqlite.close(); }
});
