import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutoReviewRequest, AutoReviewDecision } from '@cindy/maker-core';
import { withAutoReviewContext } from '../../../../../../packages/maker-core/src/agents/shared/auto-review-decision.js';
import { createPluginTaskReviewResolver, type PluginReviewSnapshot } from '../pluginTaskReviewContext.js';
import { readPluginTaskPlanReceipt } from '../pluginTaskService.js';
import { PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS, PLUGIN_TEAM_PLAN_MAX_JSON_CHARS } from '../../../shared/pluginTasks.js';

const resolvePath = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), realpath: resolvePath,
}));
import ts from 'typescript';
import { readAutoReviewProjectionTransaction, type StoredAutoReviewProjection } from '../../localDb/autoReviewProjection.js';

const sessions = sqliteTable('sessions', {
  id:text('id'),source:text('source'),orcaRole:text('orca_role'),workingDir:text('working_dir'),
  permissionMode:text('permission_mode'),planModeEnabled:integer('plan_mode_enabled',{mode:'boolean'}),
  status:text('status'),agentKind:text('agent_kind'),providerId:text('provider_id'),model:text('model'),
  effort:text('effort'),fastMode:integer('fast_mode',{mode:'boolean'}),
});
const orcaWorkers = sqliteTable('orca_workers',{sessionId:text('session_id'),teamId:text('team_id'),label:text('label')});
const orcaTeams = sqliteTable('orca_teams',{id:text('id'),leadSessionId:text('lead_session_id'),status:text('status')});
const source=readFileSync(new URL('../register.ts',import.meta.url),'utf8');
const start=source.indexOf('  setAutoReviewContextResolver(createPluginTaskReviewResolver(async sessionId => {');
const block=source.slice(start,source.indexOf('\n  }));',start)+7);
const js=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const changes = {
  workerPermission: "UPDATE sessions SET permission_mode='default' WHERE id='worker'",
  workerPlan: "UPDATE sessions SET plan_mode_enabled=1 WHERE id='worker'",
  workerStatus: "UPDATE sessions SET status='archived' WHERE id='worker'",
  directory: "UPDATE sessions SET working_dir='/other' WHERE id='worker'",
  route: "UPDATE sessions SET model='other' WHERE id='worker'",
  leadPermission: "UPDATE sessions SET permission_mode='default' WHERE id='lead'",
  leadPlan: "UPDATE sessions SET plan_mode_enabled=1 WHERE id='lead'",
  leadStatus: "UPDATE sessions SET status='archived' WHERE id='lead'",
  team: "UPDATE orca_teams SET status='archived'",
  label: "UPDATE orca_workers SET label='other'",
  unlink: "DELETE FROM orca_workers",
  receipt: "UPDATE plugin_task_requests SET payload='{}', revision=2",
};

function fixture() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, orca_role TEXT, working_dir TEXT, permission_mode TEXT, plan_mode_enabled INTEGER, status TEXT, agent_kind TEXT, provider_id TEXT, model TEXT, effort TEXT, fast_mode INTEGER, cleared_at INTEGER);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, client_id TEXT, role TEXT, content TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER);
      CREATE TABLE orca_workers(session_id TEXT, team_id TEXT, label TEXT);
      CREATE TABLE orca_teams(id TEXT, lead_session_id TEXT, status TEXT);
      CREATE TABLE plugin_task_requests(id TEXT, target_id TEXT, plugin_id TEXT, operation TEXT, payload TEXT, revision INTEGER);
      INSERT INTO sessions VALUES ('lead','plugin','lead','/answer','auto',0,'active','codex','p','model','high',0,NULL),('worker','orca','worker','/answer','auto',0,'active','codex','p','model','high',0,NULL);
      INSERT INTO orca_workers VALUES ('worker','team','sample');
      INSERT INTO orca_teams VALUES ('team','lead','active');
      INSERT INTO plugin_task_requests VALUES ('lead','','plugin','create','{"teamPlan":{"task":"scope","items":[]}}',1);`);
  db.exec(readFileSync(new URL('../../../../drizzle/0122_auto_review_projections.sql', import.meta.url), 'utf8'));
  const companion = readFileSync(new URL('../../../../drizzle/scripts/0122_auto_review_projections.ts', import.meta.url), 'utf8');
  const module = { exports: {} as { run: (db: Database.Database) => void } };
  new Function('module', companion)(module);
  module.exports.run(db);
  resolvePath.mockReset().mockResolvedValue('/answer');
  const control = { phase: '', mutate: () => {}, storageUnavailable: false,
    accountChanged: false, ownershipValid: true, authorized: true, approvalRevision: 'install' as string | null, permissionMode: 'auto' };
  const mutate=(at:string)=>{if(control.phase===at)control.mutate();};
  const epoch={userId:'owner',clientEpoch:1,client:{drizzle:drizzle(db),
    tx:async(_name:string,args:unknown)=>{const projection=readAutoReviewProjectionTransaction(db,args);mutate('projection');return projection;},
    queryOne:async(sql:string,params:unknown[])=>{if(control.storageUnavailable)throw Error('storage unavailable');return db.prepare(sql).get(...params);},
  }};
  let load!:(id:string)=>Promise<PluginReviewSnapshot & {projection:StoredAutoReviewProjection}>;
  let resolve!: ReturnType<typeof createPluginTaskReviewResolver>;
  const deps={setAutoReviewContextResolver:(fn:typeof resolve)=>{resolve=fn;},
    createPluginTaskReviewResolver:(fn:typeof load)=>{load=fn;return createPluginTaskReviewResolver(fn);},
    fsp: {realpath: resolvePath},
    getCurrentDbClientSnapshot:()=>control.accountChanged ? null : epoch,sessions,orcaWorkers,orcaTeams,eq,
    createPluginTaskStore:()=>({get:async()=>db.prepare('SELECT id,target_id AS targetId,plugin_id AS pluginId,operation,payload,revision FROM plugin_task_requests').get()}),
    drainPersistQueue:async()=>mutate('drain'),pluginTaskServiceForCurrentOwner:()=>({get:async()=>{mutate('ownership');if(!control.ownershipValid)throw Error('ownership revoked');}}),
    readGhostErrandConfig:()=>({permissionMode:control.permissionMode}),readPluginTaskPlanReceipt,
    pluginTaskAuthorizationRevision:()=>control.approvalRevision,isPluginTaskAuthorized:()=>control.authorized,
  };
  new Function(...Object.keys(deps),js)(...Object.values(deps));
  return {db,control,load,resolve};
}

it.each(['drain','projection','ownership'].flatMap(phase=>[
  ...Object.keys(changes).map(change=>({phase,change,sessionId:'worker'})),
  ...['leadPermission','leadPlan','leadStatus','receipt'].map(change=>({phase,change,sessionId:'lead'})),
]))('rejects changed $change for $sessionId after $phase with one final database read', async ({phase,change,sessionId})=>{
  const {db,control,load}=fixture();
  try {
    db.exec("UPDATE sessions SET provider_id=NULL,working_dir='/评测/answer'");
    expect((await load(sessionId)).authorized).toBe(true);
    control.storageUnavailable=true;
    await expect(load(sessionId)).rejects.toThrow('storage unavailable');
    control.storageUnavailable=false;
    control.phase=phase;
    control.mutate=()=>db.exec(changes[change as keyof typeof changes]);
    expect((await load(sessionId)).authorized).toBe(false);
  } finally {db.close();}
});

it.each(['drain','projection','ownership'].flatMap(phase =>
  [{sessionId:'worker',writer:'lead'},{sessionId:'worker',writer:'worker'},{sessionId:'lead',writer:'lead'}].flatMap(pair =>
    ['insert','edit','delete','rewind','clear'].map(operation => ({phase,...pair,operation})),
  ),
))('rechecks $writer $operation evidence for $sessionId after $phase', async ({phase,sessionId,writer,operation}) => {
  const {db,control,load}=fixture();
  const add = (id:string, text:string, at:number) => db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,NULL)').run(
    id,writer,id,'user',JSON.stringify({text}),at,JSON.stringify({delivery:'turn',autoReviewUserText:text}),
  );
  try {
    add('grant','allow publishing',1);
    const before=await load(sessionId);
    expect(before.authorized).toBe(true);
    expect(JSON.stringify(before.projection.reviewIntent)).toContain('allow publishing');
    control.phase=phase;
    control.mutate=()=>{
      if(operation==='insert') add('restriction','never publish',2);
      if(operation==='edit') db.prepare('UPDATE messages SET content=?,agent_meta=? WHERE id=?').run(
        JSON.stringify({text:'never publish'}),JSON.stringify({delivery:'turn',autoReviewUserText:'never publish'}),'grant');
      if(operation==='delete') db.prepare('DELETE FROM messages WHERE id=?').run('grant');
      if(operation==='rewind') db.prepare('UPDATE messages SET rewind_at=2 WHERE id=?').run('grant');
      if(operation==='clear') db.prepare('UPDATE sessions SET cleared_at=1 WHERE id=?').run(writer);
    };
    const result=await load(sessionId);
    const current=readAutoReviewProjectionTransaction(db,{sessionId,leadId:'lead'});
    expect(current.revision).toBeGreaterThan(before.projection.revision);
    expect(result.authorized).toBe(phase==='drain');
    expect(result.projection.revision).toBe(phase==='drain'?current.revision:before.projection.revision);
    // A subsequent request can read the new evidence; rejection does not poison the task.
    control.phase='';
    expect((await load(sessionId)).projection).toEqual(current);
    expect((await load(sessionId)).authorized).toBe(true);
  } finally {db.close();}
});


const request: AutoReviewRequest = {
  sessionId: 'worker', agentKind: 'codex', model: 'model', userIntent: '',
  workspaceRoots: ['/answer'], platform: 'linux',
  action: {kind: 'exec', command: 'run-evaluation', cwd: '/answer'},
};
function setPlan(db: Database.Database, directory = '/alias') {
  const route = {agentKind: 'codex', providerId: 'p', model: 'model', effort: 'high', fastMode: false};
  db.prepare('UPDATE plugin_task_requests SET payload=?').run(JSON.stringify({route,
    teamPlan: {concurrency: 1, task: 'scope', items: [{label: 'sample', task: 'scope', workingDir: directory, route}]},
  }));
}
const duringPathChanges = {
  ...Object.fromEntries(Object.entries(changes).map(([name, sql]) => [name, ({db}: ReturnType<typeof fixture>) => db.exec(sql)])),
  planScope: ({db}: ReturnType<typeof fixture>) => db.exec("UPDATE plugin_task_requests SET payload=json_set(payload,'$.teamPlan.items[0].task','new scope')"),
  settled: ({db}: ReturnType<typeof fixture>) => db.exec("UPDATE plugin_task_requests SET payload=json_set(payload,'$.settledLabels',json('[\"sample\"]'))"),
  ownership: ({control}: ReturnType<typeof fixture>) => {control.ownershipValid=false;},
  approval: ({control}: ReturnType<typeof fixture>) => {control.authorized=false;},
  approvalRemoved: ({control}: ReturnType<typeof fixture>) => {control.approvalRevision=null;},
  configAsk: ({control}: ReturnType<typeof fixture>) => {control.permissionMode='default';},
  account: ({control}: ReturnType<typeof fixture>) => {control.accountChanged=true;},
  userInstruction: ({db}: ReturnType<typeof fixture>) => db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,NULL)').run(
    'revoke','worker','revoke','user',JSON.stringify({text:'Do not run'}),1,JSON.stringify({delivery:'turn',autoReviewUserText:'Do not run'})),
};
it.each(['initial', 'after cached allow'].flatMap(phase => Object.keys(duringPathChanges).map(change => ({phase,change}))))(
  'rejects $change during alias resolution at $phase preparation', async ({phase,change}) => {
    const f=fixture();
    try {
      setPlan(f.db);
      let entered!: () => void, release!: () => void;
      const waiting=new Promise<void>(r=>{entered=r;});
      const paused=new Promise<void>(r=>{release=r;});
      if(phase==='after cached allow') resolvePath.mockResolvedValueOnce('/answer');
      resolvePath.mockImplementationOnce(async()=>{entered();await paused;return '/answer';});
      const cached=vi.fn(async():Promise<AutoReviewDecision>=>({verdict:'allow'}));
      const pending=phase==='initial'
        ? f.resolve(request).then(result=>{
          expect(result.authorizationError).toBeTruthy();
          expect(result.delegatedTask).toBeUndefined();
        }, error=>{
          expect(['account','ownership']).toContain(change);
          expect(error.message).toBe(change==='account'?'Account changed':'ownership revoked');
        })
        : withAutoReviewContext(request,Object.assign(async()=>null,{prepareRequest:f.resolve}),cached).then(result=>{
          if(change==='account'||change==='ownership') expect(result).toMatchObject({verdict:'ask',unavailable:true});
          else expect(result.verdict).toBe('block');
        });
      await waiting;
      duringPathChanges[change as keyof typeof duringPathChanges](f);
      release();
      await pending;
      expect(cached).toHaveBeenCalledTimes(phase==='initial'?0:1);
    } finally {f.db.close();}
  },
);
it('allows a healthy alias through both preparations without changing its authorization revision', async()=>{
  const f=fixture();
  try {
    setPlan(f.db);
    const evaluated=vi.fn(async(prepared:AutoReviewRequest):Promise<AutoReviewDecision>=>{
      expect(prepared.delegatedTask?.workingDir).toBe('/answer');
      return {verdict:'allow'};
    });
    expect((await withAutoReviewContext(request,Object.assign(async()=>null,{prepareRequest:f.resolve}),evaluated)).verdict).toBe('allow');
    expect(evaluated).toHaveBeenCalledOnce();
    expect(resolvePath).toHaveBeenCalledTimes(2);
  } finally {f.db.close();}
});
it.each(['ordinary','coordinator','exact Worker'])('does not resolve an alias for %s', async kind=>{
  const f=fixture();
  try {
    setPlan(f.db,'/answer');
    if(kind==='ordinary') f.db.exec("UPDATE sessions SET source='orca',orca_role=NULL WHERE id='worker'");
    const result=await f.resolve({...request,sessionId:kind==='coordinator'?'lead':'worker'});
    expect(result.authorizationError).toBeUndefined();
    expect(!!result.delegatedTask).toBe(kind!=='ordinary');
    expect(resolvePath).not.toHaveBeenCalled();
  } finally {f.db.close();}
});
it('resolves real aliases before the final authorization read and denies changed or missing targets', async()=>{
  const f=fixture();
  const root=await mkdtemp(join(tmpdir(),'plugin-review-path-'));
  const native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  try {
    resolvePath.mockImplementation(native.realpath);
    const target=join(root,'target'), other=join(root,'other'), alias=join(root,'alias');
    await mkdir(target); await mkdir(other); await symlink(target,alias,'junction');
    const canonical=await realpath(target);
    f.db.prepare('UPDATE sessions SET working_dir=?').run(canonical);
    setPlan(f.db,alias);
    const r={...request,workspaceRoots:[canonical]};
    expect((await f.resolve(r)).delegatedTask?.workingDir).toBe(canonical);
    await rm(alias); await symlink(other,alias,'junction');
    expect((await f.resolve(r)).authorizationError).toBeTruthy();
    await rm(alias);
    expect((await f.resolve(r)).authorizationError).toBeTruthy();
    setPlan(f.db,join(target,'..','target'));
    expect((await f.resolve(r)).delegatedTask?.workingDir).toBe(canonical);
    f.control.authorized=false;
    expect((await f.resolve(r)).authorizationError).toBeTruthy();
  } finally {f.db.close();await rm(root,{recursive:true,force:true});}
});

it.each(['receipt', 'plan'])('rejects an oversized %s before resolving a directory', async kind=>{
  const f=fixture();
  try {
    setPlan(f.db);
    const raw=(f.db.prepare('SELECT payload FROM plugin_task_requests').get() as {payload:string}).payload;
    const payload=kind==='receipt' ? raw+' '.repeat(PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS) : JSON.stringify({
      ...JSON.parse(raw), teamPlan:{...JSON.parse(raw).teamPlan,task:'x'.repeat(PLUGIN_TEAM_PLAN_MAX_JSON_CHARS)},
    });
    f.db.prepare('UPDATE plugin_task_requests SET payload=?').run(payload);
    await expect(f.resolve(request)).rejects.toThrow('exceeds the supported size');
    expect(resolvePath).not.toHaveBeenCalled();
  } finally {f.db.close();}
});
