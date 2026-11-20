// Migration tier: replay the shipped SQL on old, enabled/paused/renamed schedules.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

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
    const migration = readFileSync(new URL('../../../../drizzle/0156_schedule_primary_host.sql', import.meta.url), 'utf8');
    db.exec(migration);
    expect(db.prepare('SELECT status, primary_host_key FROM schedules ORDER BY rowid').all()
      .map(r => [r.status, r.primary_host_key])).toEqual([
      ['paused', 'public/cindy-contacts'], ['active', 'public/cindy-contacts'], ['active', null], ['active', null], ['paused', null],
      ['paused', null], ['active', 'public/cindy-contacts'],
    ]);
  } finally { db.close(); }
});
