import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, it } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS } from '../../../shared/pluginTasks.js';
import { createPluginTaskStore } from '../pluginTaskStore.js';

it('rejects persisted oversized receipts with SQLite selection, including UTF-16 expansion', async () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, plugin_id TEXT,
      operation TEXT, target_id TEXT, request_key TEXT, fingerprint TEXT, payload TEXT,
      revision INTEGER, created_at INTEGER)`);
    const store = createPluginTaskStore({ drizzle: drizzle(sqlite) } as unknown as DbClient);
    const insert = sqlite.prepare('INSERT INTO plugin_task_requests VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)');
    insert.run('small', 'p', 'create', 'small', 'small', 'h', '{}');
    insert.run('large', 'p', 'create', 'large', 'large', 'h', 'x'.repeat(PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS + 1));
    insert.run('unicode', 'p', 'create', 'unicode', 'unicode', 'h', '😀'.repeat(PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS));
    expect((await store.get('small'))?.payload).toBe('{}');
    expect(await store.get('missing')).toBeUndefined();
    await expect(store.get('large')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(store.get('unicode')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(sqlite.prepare('SELECT count(*) AS n FROM plugin_task_requests').get()).toEqual({ n: 3 });
  } finally { sqlite.close(); }
});

it('omits creation payloads in SQL while preserving pagination, ownership and run receipts', async () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, plugin_id TEXT,
      operation TEXT, target_id TEXT, request_key TEXT, fingerprint TEXT, payload TEXT,
      revision INTEGER, created_at INTEGER)`);
    const db = drizzle(sqlite);
    const store = createPluginTaskStore({ drizzle: db } as unknown as DbClient);
    const insert = sqlite.prepare('INSERT INTO plugin_task_requests VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)');
    const large = JSON.stringify({plan:'x'.repeat(PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS - 11)});
    for (const id of ['a', 'b', 'c']) insert.run(id, 'p', 'create', id, id, 'h', large);
    insert.run('other', 'other-plugin', 'create', 'other', 'other', 'h', large);
    insert.run('run', 'p', 'send', 'b', 'run', 'h', '{"status":"completed"}');
    const page = await store.list('p', 'create', null, '', 2);
    expect(page.map(row => [row.id, row.payload])).toEqual([['a', ''], ['b', '']]);
    expect((await store.list('p', 'create', null, 'b', 2)).map(row => row.id)).toEqual(['c']);
    expect((await store.list('p', 'send', 'b', '', 2))[0]?.payload).toBe('{"status":"completed"}');
    expect(await store.list('p', 'send', 'a', '', 2)).toEqual([]);
    expect((await store.get('a'))?.payload).toBe(large);
  } finally { sqlite.close(); }
});
