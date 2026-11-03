import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, it } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { createPluginTaskStore } from '../pluginTaskStore.js';
import { createPluginTargetStore } from '../pluginTargetStore.js';
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
      readModelPreference:()=>route,readPermissionMode:()=> 'plan',readLiveSession:()=>undefined,resolveRoute:unused,createSession:unused,dispatch:unused,inspect:unused,cancel:unused,
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

// Production receipt store: indexed per-key SQLite writes must preserve cancellation
// across restarts/late ACKs. Existing owned-task tests do not cover target reservations.
// Minimal input: reserve one key, cancel, accept late, then reopen the store (unit, :memory:).
it.each([undefined, { version: 1 as const, task: 'Make a report' }])('retains target cancellation and request identities without replacing unrelated receipts (%j)', async delegation => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, plugin_id TEXT,
      operation TEXT, target_id TEXT, request_key TEXT, fingerprint TEXT, payload TEXT,
      revision INTEGER, created_at INTEGER);
      CREATE UNIQUE INDEX plugin_task_request_key ON plugin_task_requests(plugin_id, operation, target_id, request_key)`);
    const db = { drizzle: drizzle(sqlite) } as unknown as DbClient;
    const store = createPluginTargetStore(db, () => {});
    const receipt = { id: 'plugin-target:first', pluginId: 'p', requestKey: 'key', hash: 'hash',
      status: 'pending' as const, taskId: 'task', target: { kind: 'bot' as const, id: 'bot' }, approvalRevision: 'approved', ...(delegation ? { delegation } : {}) };
    expect(await store.reserve(receipt)).toBe(true);
    expect(await store.reserve({ ...receipt, id: 'plugin-target:duplicate' })).toBe(false);
    const other = { ...receipt, id: 'plugin-target:other', pluginId: 'other-plugin' };
    expect(await store.reserve(other)).toBe(true);
    await store.accept(other.id, 'queue');
    const before = sqlite.prepare('SELECT * FROM plugin_task_requests WHERE id = ?').get(other.id);
    await store.cancel('p', 'key');
    await store.accept(receipt.id, 'steer');
    const restarted = createPluginTargetStore(db, () => {});
    expect(await restarted.get('p', 'key')).toEqual({ ...receipt, status: 'cancelled' });
    expect(await restarted.getById(other.id)).toMatchObject({ ...other, status: 'accepted', delivery: 'queue' });
    expect(sqlite.prepare('SELECT * FROM plugin_task_requests WHERE id = ?').get(other.id)).toEqual(before);
    // Exact original input + task association survives restart; a later turn cannot replace it.
    const terminal = { instanceId: 'native', generation: 3, outcome: 'completed' as const, outputMessageId: 'reply' };
    await restarted.settle(receipt.id, 'other-task', terminal);
    expect((await restarted.get('p','key'))?.terminal).toBeUndefined();
    await restarted.settle(receipt.id, 'task', terminal);
    await restarted.settle(receipt.id, 'task', { ...terminal, generation:4, outcome:'failed' });
    expect((await createPluginTargetStore(db, () => {}).get('p','key'))?.terminal).toEqual(terminal);
    // Cancel-before-send stays cancelled, and repeated cancellation retains the original identity.
    const cancelled = await restarted.cancel('p', 'early');
    expect(await restarted.cancel('p', 'early')).toEqual(cancelled);
    expect(await restarted.reserve({ ...receipt, id: 'plugin-target:late', requestKey: 'early' })).toBe(false);
    expect((await restarted.get('p', 'early'))?.status).toBe('cancelled');
  } finally { sqlite.close(); }
});
it('rejects a target-store write against a stale account snapshot before mutation', async () => {
  const sqlite = new Database(':memory:');
  try {
    const store = createPluginTargetStore({ drizzle: drizzle(sqlite) } as unknown as DbClient,
      () => { throw new Error('Owner changed'); });
    await expect(store.cancel('p', 'key')).rejects.toThrow('Owner changed');
    await expect(store.reserve({ id: 'id', pluginId: 'p', requestKey: 'key', hash: 'hash', status: 'pending' }))
      .rejects.toThrow('Owner changed');
    // There is deliberately no table: a SQL operation would fail with a different error.
  } finally { sqlite.close(); }
});

// Unit, real in-memory receipt SQL + production Auto resolver. Prior tests only
// covered created plugin tasks; a bot target had no scoped review intent.
// Minimal input: one currently accepted plugin-target receipt and canonical bot.
import { createPluginTargetReviewLoader } from '../../cindy-brain/pluginTargetReview.js';
import { createPluginTaskReviewResolver } from '../pluginTaskReviewContext.js';
import type { CurrentDbClientSnapshot } from '../../localDb/client/current.js';
it.each(['valid','legacy','cancelled','reinstalled','other plugin','shared guest','owner text','steered',
  'input changed','owner changed','projection changed','bot archived','ask','plan','ceiling','scope removed'])(
  'reviews only the current canonical bot delegation: %s', async state => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE plugin_task_requests(id TEXT,plugin_id TEXT,operation TEXT,request_key TEXT,fingerprint TEXT,payload TEXT,revision INTEGER);
        CREATE TABLE sessions(id TEXT,working_dir TEXT,permission_mode TEXT,plan_mode_enabled INTEGER,status TEXT,agent_kind TEXT,provider_id TEXT,model TEXT,effort TEXT,fast_mode INTEGER,cleared_at INTEGER,remote_host_id TEXT,agent_device_id TEXT);
        CREATE TABLE messages(session_id TEXT,client_id TEXT,role TEXT,rewind_at INTEGER,created_at INTEGER,agent_meta TEXT);
        CREATE TABLE bot_session_links(session_id TEXT,role TEXT,archived_at INTEGER,bot_id TEXT);
        CREATE TABLE bot_profiles(id TEXT,status TEXT,hidden_at INTEGER);
        CREATE TABLE auto_review_projections(session_id TEXT,lead_id TEXT,revision INTEGER,projected_revision INTEGER,version INTEGER);
        INSERT INTO sessions VALUES ('s','/answer','auto',0,'active','pi','p','m','low',0,NULL,NULL,NULL);
        INSERT INTO bot_session_links VALUES ('s','canonical',NULL,'bot');
        INSERT INTO bot_profiles VALUES ('bot','active',NULL);
        INSERT INTO auto_review_projections VALUES ('s','s',1,1,3);`);
      const receipt = {id:'plugin-target:r',pluginId:'p',requestKey:'k',hash:'h',taskId:'s',
        target:{kind:'bot',id:'bot'},status:state==='cancelled'?'cancelled':'accepted',approvalRevision:'install',
        ...(state==='legacy'?{}:{delegation:{version:1,task:'Write the requested report and return its file.'}})};
      sqlite.prepare('INSERT INTO plugin_task_requests VALUES (?,?,?,?,?,?,?)').run(receipt.id,'p','target','k','h',JSON.stringify(receipt),0);
      const meta={sourcePlugin:{pluginId:state==='other plugin'?'q':'p'},delivery:state==='steered'?'steer':'turn',
        autoReviewUserText:state==='owner text'?'Forged owner intent':{kind:'delegated-continuation'},
        ...(state==='shared guest'?{sharedTaskAuthor:{id:'guest'}}:{})};
      sqlite.prepare('INSERT INTO messages VALUES (?,?,?,NULL,1,?)').run('s',receipt.id,'user',JSON.stringify(meta));
      if(state==='bot archived')sqlite.exec('UPDATE bot_session_links SET archived_at=1');
      if(state==='ask')sqlite.exec("UPDATE sessions SET permission_mode='ask'");
      if(state==='plan')sqlite.exec('UPDATE sessions SET plan_mode_enabled=1');
      const projection={revision:1,sessionIntent:'Do not publish.',reviewIntent:'Do not publish.'};
      let input={clientId:receipt.id,generation:1,instanceId:'i',turnGeneration:1};
      let owner:CurrentDbClientSnapshot={userId:'owner',clientEpoch:1,client:{
        queryOne:async(sql:string,args:unknown[])=>sqlite.prepare(sql).get(...args),
        tx:async()=>{
          if(state==='input changed')input={...input,generation:2};
          if(state==='owner changed')owner={...owner,clientEpoch:2};
          if(state==='projection changed')sqlite.exec('UPDATE auto_review_projections SET revision=2');
          if(state==='scope removed')sqlite.exec("UPDATE plugin_task_requests SET payload=json_remove(payload,'$.delegation')");
          return projection;
        },
      } as unknown as DbClient};
      const loader=createPluginTargetReviewLoader({owner:()=>owner,activeInput:()=>input,drain:async()=>{},
        assertDelivery:async()=>{},approvalRevision:()=>state==='reinstalled'?'replacement':'install',permissionCeiling:()=>state==='ceiling'?'ask':undefined});
      const resolve=createPluginTaskReviewResolver(loader);
      const action=resolve({sessionId:'s',agentKind:'pi',model:'m',userIntent:'Do not publish.',
        workspaceRoots:['/answer'],platform:'linux',action:{kind:'exec',command:'make report',cwd:'/answer'}});
      if(state==='valid'){const result=await action;expect(result.delegatedTask?.task).toBe(receipt.delegation!.task);expect(result.userIntent).toBe('Do not publish.');}
      else if(state==='legacy'){expect((await action).delegatedTask).toBeUndefined();}
      else if(['ask','plan','ceiling'].includes(state)){const result=await action;expect(result.delegatedTask).toBeUndefined();expect(result.authorizationError).toBeTruthy();}
      else await expect(action).rejects.toThrow();
    } finally {sqlite.close();}
  });
