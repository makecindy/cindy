import {describe, it, expect, vi} from 'vitest';
import {pluginWorkerCompletedAt} from '../pluginWorkerCompletion.js';
import {readFileSync} from 'node:fs';
import Database from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {and, asc, desc, eq, gte, inArray, isNull, sql} from 'drizzle-orm';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import ts from 'typescript';
import {ORCA_WORKER_READY_MESSAGE} from '../orcaLifecycleService.js';
import {PluginTaskError} from '../pluginTaskService.js';
const final = {status:'idle',working:false,queued:0,paused:false,startedAt:100,endedAt:200,anchor:{role:'assistant',createdAt:190,agentMeta:'{"turnCompleted":true}'},taskInput:{createdAt:90,content:JSON.stringify('Evaluate this answer')}};
describe('released Worker completion',()=>{
 it('recovers a released final turn from host metadata',()=>expect(pluginWorkerCompletedAt(final)).toBe(200));
 it.each([{working:true},{queued:1},{paused:true},{status:'error'},{startedAt:210},{clearedAt:195},{anchor:{...final.anchor,role:'user'}},{anchor:{...final.anchor,agentMeta:'{}'}},{anchor:{...final.anchor,agentMeta:'{"turnCompleted":false}'}},{anchor:{...final.anchor,agentMeta:'{"turnCompleted":true,"parentUuid":"child"}'}}])('does not infer completion from idle or old/report text: %j',patch=>expect(pluginWorkerCompletedAt({...final,...patch})).toBeNull());
 it.each([undefined, {createdAt:90,content:JSON.stringify(ORCA_WORKER_READY_MESSAGE)}, {createdAt:90,content:ORCA_WORKER_READY_MESSAGE}, {createdAt:90,content:JSON.stringify({text:ORCA_WORKER_READY_MESSAGE})}])('does not settle a ready acknowledgement: %j',taskInput=>expect(pluginWorkerCompletedAt({...final,taskInput})).toBeNull());
});

it.each(['none', 'ready', 'auto-only', 'ready-auto', 'real', 'real-auto', 'ready-real', 'real-ready', 'cleared', 'rewound', 'child', 'other'].flatMap(scenario=>['idle','done'].map(status=>({scenario,status}))))('requires real visible input for $scenario completion from $status', async ({scenario,status}) => {
 const sqlite = new Database(':memory:');
 try {
  sqlite.exec('CREATE TABLE sessions(id TEXT, active_turn_started_at INTEGER, last_turn_ended_at INTEGER, cleared_at INTEGER); CREATE TABLE messages(session_id TEXT, role TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER, content TEXT);');
  const sessions = sqliteTable('sessions', {id:text('id'),activeTurnStartedAt:integer('active_turn_started_at'),lastTurnEndedAt:integer('last_turn_ended_at'),clearedAt:integer('cleared_at')});
  const messages = sqliteTable('messages', {sessionId:text('session_id'),role:text('role'),createdAt:integer('created_at'),agentMeta:text('agent_meta'),rewindAt:integer('rewind_at'),content:text('content')});
  sqlite.prepare('INSERT INTO sessions VALUES (?, 100, 200, ?)').run('worker', scenario === 'cleared' ? 95 : null);
  const insert = sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
  const user = (content:string, meta='{}', at=90, session='worker', rewind:number|null=null) => insert.run(session,'user',at,meta,rewind,JSON.stringify(content));
  if (scenario.startsWith('ready')) user(ORCA_WORKER_READY_MESSAGE);
  if (['real','real-auto','ready-real','real-ready','cleared'].includes(scenario)) user('Evaluate', '{}', 92);
  if (scenario === 'real-ready') user(ORCA_WORKER_READY_MESSAGE, '{}', 94);
  if (scenario.endsWith('auto') || scenario === 'auto-only') user('Continue', '{"autoResume":true}', 96);
  if (scenario === 'rewound') user('Evaluate', '{}', 90, 'worker', 95);
  if (scenario === 'child') user('Evaluate', '{"parentUuid":"child"}');
  if (scenario === 'other') user('Evaluate', '{}', 90, 'other');
  insert.run('worker','assistant',190,'{"turnCompleted":true}',null,'"Ready or done"');
  const epoch = {client:{drizzle:drizzle(sqlite)}};
  const source = readFileSync(new URL('../register.ts',import.meta.url),'utf8');
  const start = source.indexOf('  const readPluginWorkerCompletion =');
  const code = source.slice(start, source.indexOf('  const handlePluginTask =',start));
  const deps = {sessions,messages,and,desc,eq,inArray,isNull,sql,pluginWorkerCompletedAt,getCurrentDbClientSnapshot:()=>epoch,createOrcaDiagnosticsDeps:()=>({getWorkerFlowStatus:async()=>({isWorking:false,queuedCount:0,queuePaused:false})})};
  const read = new Function(...Object.keys(deps),ts.transpileModule(`${code}\nreturn readPluginWorkerCompletion;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(deps));
  const result = await read(epoch,'worker',status);
  const completed = ['real','real-auto','ready-real'].includes(scenario);
  expect(result.completedAt).toBe(completed ? 200 : null);
  expect(result.status).toBe(completed ? 'done' : 'idle');
  expect(result.row.lastTurnEndedAt).toBe(200);
  const branch = source.slice(source.indexOf("      case 'getTeam': {"), source.indexOf("      case 'create': return service.create"));
  const bindings = {...deps, asc, gte, PluginTaskError, readPluginWorkerCompletion:read,
    service:{get:async()=>({})},inputCoordinator:{ensureQueueRestored:async()=>{},isQueueRestored:()=>true,getQueueControlSnapshot:()=>({pendingQueue:[]})},
    getOrcaWorkspaceInfoReadOnly:async()=>({ok:true,workers:[{session_id:'worker',status}]}),
    maker:{getSession:()=>undefined},createPluginTaskStore:()=>({get:async()=>({payload:'{}'})}),readCollaborationSettings:()=>({workerHardLimit:4})};
  const getTeam = new Function(...Object.keys(bindings),ts.transpileModule(`return async function(pluginId,request){switch(request.kind){${branch}}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(bindings));
  const view = await getTeam('plugin',{kind:'getTeam',taskId:'lead'});
  expect(view.workers[0]).toMatchObject({status:completed?'done':'idle',completedAt:completed?200:null,lastTurnEndedAt:200});
 } finally {sqlite.close();}
});

it.each(['active','archived'])('refuses releasing %s Worker without task completion evidence', async status => {
 const source = readFileSync(new URL('../register.ts',import.meta.url),'utf8');
 const branch = source.slice(source.indexOf("      case 'releaseWorker': {"),source.indexOf("      case 'getTeam': {"));
 const row={id:'worker',sessionId:'worker',label:'one',status};
 const query={from:()=>query,innerJoin:()=>query,where:()=>query,limit:async()=>[row]};
 const epoch={client:{drizzle:{select:()=>query}}};
 const archive=vi.fn(),settleWorkerLabel=vi.fn();
 const bindings={PluginTaskError,getCurrentDbClientSnapshot:()=>epoch,eq:()=>true,and:()=>true,orcaWorkers:{},orcaTeams:{},sessions:{},
  service:{completeOperation:(fn:()=>Promise<unknown>)=>fn(),get:async()=>({}),settleWorkerLabel},
  createPluginTaskStore:()=>({get:async()=>({payload:'{"teamPlan":{"items":[{"label":"one"}]}}'})}),
  readPluginWorkerCompletion:async()=>({row,completedAt:null}),
  orcaTeamService:{archiveWorker:async({beforeArchive}:{beforeArchive:()=>Promise<void>})=>{await beforeArchive();archive();return {ok:true};}}};
 const release=new Function(...Object.keys(bindings),ts.transpileModule(`return async function(pluginId,request){switch(request.kind){${branch}}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(bindings));
 await expect(release('plugin',{kind:'releaseWorker',taskId:'lead',workerId:'worker',completedAt:200})).rejects.toMatchObject({code:'STALE_REVISION'});
 expect(archive).not.toHaveBeenCalled();expect(settleWorkerLabel).not.toHaveBeenCalled();
});

it.each(['assistant', 'user'])('uses insertion order for same-millisecond latest %s evidence', async latest => {
 const sqlite = new Database(':memory:');
 try {
  sqlite.exec('CREATE TABLE sessions(id TEXT, active_turn_started_at INTEGER, last_turn_ended_at INTEGER, cleared_at INTEGER); CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER, content TEXT DEFAULT \'"Evaluate"\');');
  const sessions = sqliteTable('sessions', {id:text('id'),activeTurnStartedAt:integer('active_turn_started_at'),lastTurnEndedAt:integer('last_turn_ended_at'),clearedAt:integer('cleared_at')});
  const messages = sqliteTable('messages', {id:text('id'),sessionId:text('session_id'),role:text('role'),createdAt:integer('created_at'),agentMeta:text('agent_meta'),rewindAt:integer('rewind_at'),content:text('content')});
  sqlite.prepare('INSERT INTO sessions VALUES (?, 100, 200, NULL)').run('worker');
  const insert = sqlite.prepare('INSERT INTO messages(id,session_id,role,created_at,agent_meta,rewind_at) VALUES (?, ?, ?, 190, ?, ?)');
  insert.run('z-old', 'worker', latest === 'user' ? 'assistant' : 'user', '{"turnCompleted":true}', null);
  insert.run('a-new', 'worker', latest, '{"turnCompleted":true}', null);
  insert.run('other', 'other-worker', 'user', '{}', null);
  insert.run('child', 'worker', 'user', '{"parentUuid":"child"}', null);
  insert.run('rewound', 'worker', 'user', '{}', 195);
  const epoch = {client:{drizzle:drizzle(sqlite)}};
  const source = readFileSync(new URL('../register.ts',import.meta.url),'utf8');
  const start = source.indexOf('  const readPluginWorkerCompletion =');
  const code = source.slice(start, source.indexOf('  const handlePluginTask =',start));
  const deps = {sessions,messages,and,desc,eq,inArray,isNull,sql,pluginWorkerCompletedAt,getCurrentDbClientSnapshot:()=>epoch,createOrcaDiagnosticsDeps:()=>({getWorkerFlowStatus:async()=>({isWorking:false,queuedCount:0,queuePaused:false})})};
  const read = new Function(...Object.keys(deps),ts.transpileModule(`${code}\nreturn readPluginWorkerCompletion;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(deps));
  expect((await read(epoch,'worker','idle')).completedAt).toBe(latest === 'assistant' ? 200 : null);
 } finally {sqlite.close();}
});
