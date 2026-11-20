// Replay the shipped SQL and companion against historical layouts using in-memory SQLite.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

const migrationSql = readFileSync(new URL('../../../../drizzle/0156_schedule_primary_host.sql', import.meta.url), 'utf8');
const migration = createRequire(import.meta.url)('../../../../drizzle/scripts/0156_schedule_primary_host.ts') as {
  run(db: DatabaseSync): void;
};

function replay(db: DatabaseSync): void {
  db.exec(migrationSql);
  migration.run(db);
}

it('leaves a historical database without schedules untouched on replay', () => {
  const db = new DatabaseSync(':memory:');
  try {
    replay(db);
    replay(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schedules'").get()).toBeUndefined();
  } finally { db.close(); }
});

it('adds the column once to an incomplete schedules table and keeps its rows unbound', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE schedules(name TEXT); INSERT INTO schedules VALUES ('整理通讯录')");
    replay(db);
    replay(db);
    expect(db.prepare('SELECT * FROM schedules').all()).toEqual([{ name: '整理通讯录', primary_host_key: null }]);
  } finally { db.close(); }
});

it('adds execution ownership to old Contacts automation without changing its status or binding unrelated jobs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE schedules(name TEXT, prompt TEXT, status TEXT, execution_mode TEXT)');
    const put = db.prepare('INSERT INTO schedules VALUES(?,?,?,?)');
    const prompt = '整理我的通讯录（cindy-contacts 插件）。maintenance begin run_id';
    put.run('自定义名称', prompt, 'paused', 'agent');
    put.run('Tidy up contacts', 'Read cindy-contacts maintenance begin and end with run_id', 'active', null);
    put.run('Other', 'cindy-contacts maintenance begin run_id', 'active', 'agent');
    put.run('整理通讯录', prompt + 'namespace 传「local」。', 'active', 'agent');
    put.run('整理通讯录', prompt, 'paused', 'script');
    put.run('整理通讯录', prompt + '调用这个插件时只传 ghost_id「cindy-contacts」，不要传 namespace。', 'paused', 'agent');
    put.run('整理通讯录', prompt + '调用这个插件时使用 ghost_id「cindy-contacts」，namespace 传 null。', 'active', 'agent');
    replay(db);
    expect(db.prepare('SELECT status, primary_host_key FROM schedules ORDER BY rowid').all()
      .map(r => [r.status, r.primary_host_key])).toEqual([
      ['paused', 'public/cindy-contacts'], ['active', 'public/cindy-contacts'], ['active', null], ['active', null], ['paused', null],
      ['paused', null], ['active', 'public/cindy-contacts'],
    ]);
    db.prepare("UPDATE schedules SET primary_host_key = 'local/cindy-contacts' WHERE name = '自定义名称'").run();
    replay(db);
    expect(db.prepare("SELECT status, primary_host_key FROM schedules WHERE name = '自定义名称'").get())
      .toEqual({ status: 'paused', primary_host_key: 'local/cindy-contacts' });
  } finally { db.close(); }
});
