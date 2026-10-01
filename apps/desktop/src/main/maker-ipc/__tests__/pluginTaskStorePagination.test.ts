import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, it } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { createPluginTaskStore } from '../pluginTaskStore.js';
import { createPluginTaskService } from '../pluginTaskService.js';

it.each(['absent', 'raw session', 'revoked', 'changed revision', 'other plugin', 'send'] as const)(
  'rolls back only its uncreated receipt in SQLite: %s', async state => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, plugin_id TEXT,
        operation TEXT, target_id TEXT, request_key TEXT, fingerprint TEXT, payload TEXT,
        revision INTEGER, created_at INTEGER); CREATE TABLE sessions(id TEXT PRIMARY KEY)`);
      const store = createPluginTaskStore({ drizzle: drizzle(sqlite) } as unknown as DbClient);
      const row = { id: 'task', pluginId: 'p', operation: 'create' as const, targetId: '',
        requestKey: 'key', fingerprint: 'hash', payload: '{}', revision: 0, createdAt: 1 };
      await store.insert(row);
      if (state === 'raw session') sqlite.prepare('INSERT INTO sessions VALUES (?)').run(row.id);
      if (state === 'revoked') await store.revokePlugin('p');
      if (state === 'changed revision') await store.save(row);
      if (state === 'other plugin') sqlite.exec("UPDATE plugin_task_requests SET plugin_id='other'");
      if (state === 'send') sqlite.exec("UPDATE plugin_task_requests SET operation='send'");
      await store.discardUncreated(row);
      expect(await store.get(row.id)).toEqual(state === 'absent' ? undefined : expect.any(Object));
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: state === 'raw session' ? 1 : 0 });
    } finally { sqlite.close(); }
  },
);

it('durably revokes only create ownership while retaining plans, run results and request identities', async () => {
  const sqlite=new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, plugin_id TEXT,
      operation TEXT, target_id TEXT, request_key TEXT, fingerprint TEXT, payload TEXT,
      revision INTEGER, created_at INTEGER)`);
    const db={drizzle:drizzle(sqlite)} as unknown as DbClient;
    const store=createPluginTaskStore(db);
    const add=sqlite.prepare('INSERT INTO plugin_task_requests VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)');
    add.run('task','p','create','','original','hash',JSON.stringify({title:'keep',teamPlan:{items:[]}}));
    add.run('broken','p','create','','broken-key','hash','{bad');
    add.run('run','p','send','task','send-key','hash','{"status":"completed"}');
    add.run('other','q','create','','other-key','hash','{}');
    const route={agentKind:'codex' as const,providerId:'test',model:'test',effort:'high',fastMode:false};
    const unused=async():Promise<never>=>{throw Error('unexpected dispatch/control');};
    const service=createPluginTaskService({store,assertCurrent(){},assertAuthorized(){},
      readSession:async taskId=>({taskId,title:'kept',revision:1,status:'active',resolvedConfig:route,permissionMode:'plan'}),
      readPermissionMode:()=> 'plan',resolveRoute:unused,createSession:unused,dispatch:unused,inspect:unused,cancel:unused,
    });
    expect((await service.list('p')).items.map(row=>row.taskId)).toEqual(['task']);
    await store.revokePlugin('p');
    expect((await service.list('p')).items).toEqual([]);
    const restarted=createPluginTaskStore(db);
    const row=await restarted.find('p','create','','original');
    expect(row).toMatchObject({id:'task',requestKey:'original',revision:1});
    expect(JSON.parse(row!.payload)).toEqual({title:'keep',teamPlan:{items:[]},ownershipRevoked:true});
    expect(JSON.parse((await restarted.get('broken'))!.payload)).toEqual({ownershipRevoked:true});
    expect(await restarted.get('run')).toMatchObject({payload:'{"status":"completed"}',revision:0});
    expect(await restarted.get('other')).toMatchObject({payload:'{}',revision:0});
  } finally { sqlite.close(); }
});

it('pages by creation time and ID without losing later records with smaller UUIDs', async () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, plugin_id TEXT,
      operation TEXT, target_id TEXT, request_key TEXT, fingerprint TEXT, payload TEXT,
      revision INTEGER, created_at INTEGER)`);
    const store = createPluginTaskStore({ drizzle: drizzle(sqlite) } as unknown as DbClient);
    const add = sqlite.prepare('INSERT INTO plugin_task_requests VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)');
    for (const operation of ['create', 'send']) {
      const prefix = operation + '-';
      const target = operation === 'send' ? 'task' : null;
      const insert = (id: string, time: number, plugin = 'p') => add.run(prefix + id, plugin, operation, 'task', id, 'h', '{}', time);
      insert('z', 1);insert('y', 1);
      expect((await store.list('p', operation, target, '', 1)).map(r => r.id)).toEqual([prefix + 'y']);
      expect((await store.list('p', operation, target, prefix + 'y', 1)).map(r => r.id)).toEqual([prefix + 'z']);
      insert('a', 2);insert('b', 3, 'other');
      expect((await store.list('p', operation, target, prefix + 'z', 10)).map(r => r.id)).toEqual([prefix + 'a']);
      await expect(store.list('other', operation, target, prefix + 'z', 10)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(store.list('p', operation, 'different', prefix + 'z', 10)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
  } finally { sqlite.close(); }
});
