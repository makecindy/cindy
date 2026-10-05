import { Session } from '../../../../../../packages/maker-core/src/session.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { withSessionRestartLock, withSendToSessionLock, sendToSessionLocks } from '../sendToSessionLock.js';
import { isPluginTaskPermissionAllowed, PluginTaskError } from '../pluginTaskService.js';
import { PluginWriteAccessGate } from '../pluginWriteAccessGate.js';
import { withSessionPermissionChange } from '../sessionPermissionChange.js';
import { changeSessionPermissionMode } from '../../im/shared/permissionModeControl.js';
import type { PermissionMode } from '@cindy/maker-core';
const ownership = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => ownership.current }));

// Execute the real switch branch with controlled Host boundaries.
// Git may check out CRLF on Windows; all source boundaries below use LF.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const branch = source.slice(source.indexOf("      case 'requestWriteAccess': {"), source.indexOf("      case 'startTeam': {"));
const js = ts.transpileModule(`return async function(pluginId, request, explicitWriteAccess = false, assertCallerCurrent = () => {}) { switch(request.kind) { ${branch} } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const settingSource = source.slice(source.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.SET_PERMISSION_MODE,'), source.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.SET_PLAN_MODE,'));
const planSource = source.slice(source.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.SET_PLAN_MODE,'), source.indexOf('  ipcMain.handle(MAKER_INVOKE.EXPORT_SESSION_HTML,'));
const planJs = ts.transpileModule(planSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const settingJs = ts.transpileModule(settingSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
 let identity = 'owner-epoch-install';
 const gate = new PluginWriteAccessGate();
 let cfg: Record<string, unknown> = { permissionMode: 'plan', model: 'old' };
 const history = { input: false, startedAt: null as number | null, endedAt: null as number | null, permissionMode: 'plan', planModeEnabled: false };
 const messages = {id:'message-id',sessionId:'session-id',role:'role'}, sessions = {id:'session-id',activeTurnStartedAt:'started',lastTurnEndedAt:'ended'};
 const select = vi.fn(() => ({from:(table:unknown)=>({where:()=>({limit:async()=>table===messages ? (history.input ? [{id:'manual-input'}] : []) : [{startedAt:history.startedAt,endedAt:history.endedAt,permissionMode:history.permissionMode,planModeEnabled:history.planModeEnabled}]})})}));
 const drain = vi.fn(async()=>{});
 const epoch = { client: { tx: vi.fn(async (_name?: string, args?: {mode: string}) => {if(args) history.permissionMode=args.mode;return { updated: true };}), drizzle: {select} } };
 ownership.current = epoch; let cold = false, runtimeMode = 'plan';
 const task = { taskId: 'task', revision: 1, status: 'active', permissionMode: 'plan' };
 const service = { get: vi.fn(async () => task), listRuns: vi.fn(async () => ({ items: [] })), completeOperation: vi.fn(async <T>(operation: () => Promise<T>) => operation()) };
 let runtimePlan: boolean | null = false;
 const live = { get stablePlanModeState() { return runtimePlan === null ? null : {enabled:runtimePlan,generation:0}; }, getPlanMode:()=>runtimePlan, setPlanMode:vi.fn(async(enabled:boolean)=>{runtimePlan=enabled;}), isTurnRunning: () => false, getTurnControlSnapshot: () => ({ pendingInteractionCount: 0 }), setPermissionMode: vi.fn(async (mode: string) => {runtimeMode=mode;}) };
 const queue = { ensureQueueRestored: vi.fn(async (_id: string) => {}), isQueueRestored: vi.fn((_id: string) => true), getQueueControlSnapshot: vi.fn((_id: string) => ({ pendingQueue: [] as string[] })) };
 const slots = new Set<string>();
 const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
 const write = vi.fn((_id: string, value: Record<string, unknown>) => { cfg = value; });
 const deps = { isPluginTaskPermissionAllowed, withSessionPermissionChange, withSessionRestartLock, drainPersistQueue:drain,messages,sessions,eq:()=>true,and:()=>true,service, getCurrentDbClientSnapshot: () => ownership.current, readPluginTaskConfig: () => cfg, pluginPermissionRequests: slots, PluginTaskError, maker: { getSession: () => cold ? null : live }, inputCoordinator: queue, dialog, t: (x: string) => x, getInstalledGhostName: () => 'fixture', clampPluginTaskPermissionMode: (x: string) => x, writePluginTaskConfig: write, broadcastSessionPatched: vi.fn() };
 const allDeps = {...deps, pluginWriteAccessGate:gate, pluginWriteAccessIdentity:()=>identity};
 const run = new Function(...Object.keys(allDeps), js)(...Object.values(allDeps));
 let setMode!: (event: unknown, sessionId: string, mode: string) => Promise<unknown>;
 let setPlan!: (event:unknown, sessionId:string, enabled:boolean)=>Promise<unknown>;
 let remote = false;
 const persistedResults = new WeakSet<object>();
 const settingDeps = {...deps, log:{warn:vi.fn()}, ipcMain:{handle:(_name:unknown,fn:typeof setMode)=>{setMode=fn;}}, MAKER_INVOKE:{SET_PERMISSION_MODE:'permission'}, isDeviceLinkInvoke:()=>remote, assertTrustedAppRendererEvent:()=>{}, assertReviewSettingsUnlocked:async()=>{}, isSessionPermissionMode:()=>true, throwIpcError:(code:string,message:string)=>{throw Object.assign(Error(message),{code});}, persistPermissionModeWithoutRuntime:async(_id:string,mode:string)=>(await epoch.client.tx('bots.persistSessionPermission',{mode})).updated, markRemoteSettingPersistedInsideHandler:(result:object)=>persistedResults.add(result)};
 new Function(...Object.keys(settingDeps), settingJs)(...Object.values(settingDeps));
 expect(setMode, 'SET_PERMISSION_MODE source extraction must register its handler').toBeTypeOf('function');
 const planPersist=vi.fn(async(_id:string,patch:{planModeEnabled:boolean})=>{history.planModeEnabled=patch.planModeEnabled;});
 const planDeps={...settingDeps,persistSessionFields:planPersist,ipcMain:{handle:(_name:unknown,fn:typeof setPlan)=>{setPlan=fn;}},MAKER_INVOKE:{SET_PLAN_MODE:'plan'}};
 new Function(...Object.keys(planDeps), planJs)(...Object.values(planDeps));
 expect(setPlan, 'SET_PLAN_MODE source extraction must register its handler').toBeTypeOf('function');
 const setImMode = (mode: PermissionMode) => changeSessionPermissionMode({
  sessionId:'task', mode, modes:[{id:mode,displayName:mode}],
  readPreviousMode:async()=>history.permissionMode as PermissionMode,
  getLiveSession:()=>cold?null:live,
  persist:async next=>{await epoch.client.tx('bots.persistSessionPermission',{mode:next});},
 });
 return {setPlan:(enabled:boolean)=>setPlan({},'task',enabled),planPersist,runtimePlan:()=>runtimePlan,nativePlan:(enabled:boolean|null)=>{runtimePlan=enabled;},setImMode, setMode:(mode:string)=>setMode({},'task',mode), persistedResults, remote:()=>{remote=true;}, cold:()=>{cold=true;}, runtimeMode:()=>runtimeMode, changeOwner:()=>{ownership.current={};}, run: (mode = 'acceptEdits', explicit = false) => run('plugin', { kind: 'requestWriteAccess', taskId: 'task', mode }, explicit), queue, gate, identity: (next: string) => {identity=next;}, service, live, epoch, dialog, slots, write, history, drain, config: () => cfg, change: (next: Record<string, unknown>) => { cfg = next; } };
}
describe('plugin write confirmation interleavings', () => {
 it.each(['auto','acceptEdits'].flatMap(mode=>['before','dialog','lastRead'].map(point=>({mode,point}))))('rejects independent Plan Mode at $point for $mode without reporting a grant',async ({point,mode})=>{
  const f=fixture();f.change({permissionMode:mode});
  const planTask={taskId:'task',revision:1,status:'active',permissionMode:mode,planModeEnabled:true};
  if(point==='before') f.service.get.mockResolvedValue(planTask);
  if(point==='dialog') f.dialog.showMessageBox.mockImplementationOnce(async()=>{f.service.get.mockResolvedValue(planTask);return {response:0};});
  if(point==='lastRead') f.epoch.client.tx.mockImplementationOnce(async()=>{f.service.get.mockResolvedValue(planTask);return {updated:true};});
  await expect(f.run(mode)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  expect(f.write).not.toHaveBeenCalled();
  if(point==='before') expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  if(point!=='lastRead') {expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.epoch.client.tx).not.toHaveBeenCalled();}
 });
 it.each(['acceptEdits', 'auto'])('restores a cold durable queue before %s confirmation under the send lock', async mode => {
  const f=fixture();
  f.queue.ensureQueueRestored.mockImplementation(async()=>{
   expect(sendToSessionLocks.has('task')).toBe(true);
   f.queue.getQueueControlSnapshot.mockReturnValue({pendingQueue:['persisted-input']});
  });
  await expect(f.run(mode)).rejects.toMatchObject({code:'TASK_BUSY'});
  expect(f.dialog.showMessageBox).not.toHaveBeenCalled();expect(f.epoch.client.tx).not.toHaveBeenCalled();
 });
 it('fails closed on incomplete restoration and retries preflight without consuming consent',async()=>{
  const f=fixture();f.queue.isQueueRestored.mockReturnValueOnce(false);
  await expect(f.run()).rejects.toMatchObject({code:'HOST_NOT_READY'});
  expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  await expect(f.run()).resolves.toMatchObject({granted:true});
 });
 it('rechecks restored queue after confirmation before committing permission',async()=>{
  const f=fixture();f.dialog.showMessageBox.mockImplementationOnce(async()=>{
   f.queue.ensureQueueRestored.mockImplementationOnce(async()=>{f.queue.getQueueControlSnapshot.mockReturnValue({pendingQueue:['late-input']});});
   return {response:0};
  });
  await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
  expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.epoch.client.tx).not.toHaveBeenCalled();
 });

 it('remembers refusal across modes and repeats, and only Host retry opens the original confirmation',async()=>{
  const f=fixture();f.dialog.showMessageBox.mockResolvedValueOnce({response:1});
  await expect(f.run()).resolves.toEqual({granted:false});
  await expect(f.run('auto')).resolves.toEqual({granted:false});
  await expect(f.run()).resolves.toEqual({granted:false});
  expect(f.gate.recoverable(JSON.stringify(['plugin','task']),'owner-epoch-install')).toBe('acceptEdits');
  expect(f.dialog.showMessageBox).toHaveBeenCalledOnce();expect(f.write).not.toHaveBeenCalled();
  await expect(f.run('acceptEdits',true)).resolves.toMatchObject({granted:true});
  expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(2);
 });
 it('retains failed confirmation suppression, then permits a new owner/install identity',async()=>{
  const f=fixture();f.dialog.showMessageBox.mockRejectedValueOnce(new Error('dialog unavailable'));
  await expect(f.run()).rejects.toThrow('dialog unavailable');
  await expect(f.run()).resolves.toEqual({granted:false});
  f.identity('new-owner-install');
  await expect(f.run()).resolves.toMatchObject({granted:true});
  expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(2);
 });
 it('rejects an install change while permission UI was open',async()=>{
  const f=fixture();f.dialog.showMessageBox.mockImplementationOnce(async()=>{f.identity('replacement');return {response:0};});
  await expect(f.run()).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
 });
 it('tracks the permission commit only after confirmation and includes rollback', async () => {
  const f=fixture();let answer!:()=>void;
  f.dialog.showMessageBox.mockImplementationOnce(()=>new Promise(resolve=>{answer=()=>resolve({response:0});}));
  const operation=f.run();const rejected=expect(operation).rejects.toThrow('write failed');
  await vi.waitFor(()=>expect(f.dialog.showMessageBox).toHaveBeenCalledOnce());
  expect(f.service.completeOperation).not.toHaveBeenCalled();
  let release!:()=>void;const rollback=new Promise<void>(resolve=>{release=resolve;});
  f.epoch.client.tx.mockRejectedValueOnce(new Error('write failed'));
  f.live.setPermissionMode.mockImplementationOnce(async()=>{}).mockImplementationOnce(()=>rollback);
  answer();await vi.waitFor(()=>expect(f.live.setPermissionMode).toHaveBeenCalledTimes(2));
  expect(f.service.completeOperation).toHaveBeenCalledOnce();
  let finished=false;const tracked=f.service.completeOperation.mock.results[0]!.value.then(()=>{finished=true;},()=>{finished=true;});
  await Promise.resolve();expect(finished).toBe(false);
  release();await Promise.all([rejected,tracked]);expect(finished).toBe(true);
 });
 it('owns the existing slot across idle checks and releases it on failure', async () => {
  const f = fixture(); let reject!: (e: Error) => void;
  f.service.listRuns.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const first = f.run(); const rejected = expect(first).rejects.toThrow('idle failed');
  await vi.waitFor(() => expect(f.slots.size).toBe(1));
  await expect(f.run()).rejects.toMatchObject({ code: 'TASK_BUSY' });
  expect(f.dialog.showMessageBox).not.toHaveBeenCalled(); expect(f.slots.size).toBe(1);
  reject(new Error('idle failed')); await rejected; expect(f.slots.size).toBe(0);
  await expect(f.run()).resolves.toMatchObject({ granted: true });
 });
 it.each(['runtime', 'database', 'lastRead'])('preserves unrelated configuration changed during %s', async point => {
  const f = fixture(), change = () => f.change({ permissionMode: 'plan', model: 'new', workingDir: '/chosen', fastMode: true });
  if (point === 'runtime') f.live.setPermissionMode.mockImplementationOnce(async () => { change(); });
  if (point === 'database') f.epoch.client.tx.mockImplementationOnce(async () => { change(); return { updated: true }; });
  if (point === 'lastRead') f.service.get.mockImplementationOnce(async () => ({ taskId: 'task', revision: 1, status: 'active', permissionMode: 'plan' })).mockImplementationOnce(async () => ({ taskId: 'task', revision: 1, status: 'active', permissionMode: 'plan' })).mockImplementationOnce(async () => { change(); return { taskId: 'task', revision: 1, status: 'active', permissionMode: 'plan' }; });
  await f.run('auto'); expect(f.config()).toEqual({ permissionMode: 'auto', model: 'new', workingDir: '/chosen', fastMode: true });
 });
 it('does not overwrite a later permission change', async () => {
  const f = fixture(); f.live.setPermissionMode.mockImplementationOnce(async () => { f.change({ permissionMode: 'acceptEdits', model: 'new' }); });
  await expect(f.run('auto')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(f.write).not.toHaveBeenCalled(); expect(f.slots.size).toBe(0);
  expect(f.live.setPermissionMode).toHaveBeenLastCalledWith('plan');
  expect(f.epoch.client.tx).toHaveBeenLastCalledWith('bots.persistSessionPermission', {sessionId:'task', mode:'plan'});
 });
 it.each(['database', 'lastRead'] as const)('rolls back runtime and stored permission after late %s revocation', async point => {
  const f=fixture();
  const revoke=()=>f.change({permissionMode:'acceptEdits',model:'new'});
  if(point==='database') f.epoch.client.tx.mockImplementationOnce(async()=>{revoke();return {updated:true};});
  else f.service.get.mockImplementationOnce(async()=>({taskId:'task',revision:1,status:'active',permissionMode:'plan'}))
   .mockImplementationOnce(async()=>({taskId:'task',revision:1,status:'active',permissionMode:'plan'}))
   .mockImplementationOnce(async()=>{revoke();return {taskId:'task',revision:1,status:'active',permissionMode:'auto'};});
  await expect(f.run('auto')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  expect(f.live.setPermissionMode.mock.calls).toEqual([['auto'],['plan']]);
  expect(f.epoch.client.tx).toHaveBeenLastCalledWith('bots.persistSessionPermission',{sessionId:'task',mode:'plan'});
  expect(f.config()).toEqual({permissionMode:'acceptEdits',model:'new'});
  expect(f.write).not.toHaveBeenCalled();expect(f.slots.size).toBe(0);
 });
 it('rolls back a persisted grant if the final ownership read fails', async()=>{
  const f=fixture();
  f.service.get.mockImplementationOnce(async()=>({taskId:'task',revision:1,status:'active',permissionMode:'plan'}))
   .mockImplementationOnce(async()=>({taskId:'task',revision:1,status:'active',permissionMode:'plan'}))
   .mockRejectedValueOnce(new Error('owner revoked'));
  await expect(f.run('auto')).rejects.toThrow('owner revoked');
  expect(f.live.setPermissionMode).toHaveBeenLastCalledWith('plan');
  expect(f.epoch.client.tx).toHaveBeenLastCalledWith('bots.persistSessionPermission',{sessionId:'task',mode:'plan'});
  expect(f.write).not.toHaveBeenCalled();
 });
});

describe('first plugin write approval checks actual task history', () => {
 it.each(['input','startedAt','endedAt'] as const)('rejects a manual UI turn with %s evidence without a plugin receipt', async key=>{
  const f=fixture();
  if(key==='input') f.history.input=true; else f.history[key]=1;
  await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
  expect(f.dialog.showMessageBox).not.toHaveBeenCalled();expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.slots.size).toBe(0);
 });
 it('rechecks after confirmation if a manual turn completed while the dialog was open',async()=>{
  const f=fixture();f.dialog.showMessageBox.mockImplementationOnce(async()=>{f.history.input=true;return {response:0};});
  await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
  expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.epoch.client.tx).not.toHaveBeenCalled();
 });
 it('drains pending message writes before checking and fails closed on storage failure',async()=>{
  const f=fixture();f.drain.mockImplementationOnce(async()=>{f.history.input=true;});
  await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
  const g=fixture();g.drain.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(g.run()).rejects.toThrow('storage unavailable');expect(g.dialog.showMessageBox).not.toHaveBeenCalled();
 });
});

 it('rechecks under the shared lock after an earlier sender completes', async () => {
  const f = fixture(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let sender: Promise<void>;
  f.dialog.showMessageBox.mockImplementationOnce(async () => {
   sender = withSendToSessionLock('task', async () => { entered(); await barrier; f.history.endedAt = 1; });
   await started;
   return { response: 0 };
  });
  const result = expect(f.run()).rejects.toMatchObject({ code: 'TASK_BUSY' });
  await vi.waitFor(() => expect(sendToSessionLocks.has('task')).toBe(true));
  expect(f.live.setPermissionMode).not.toHaveBeenCalled();
  release(); await result; await sender!;
 });
 it('keeps send fenced through runtime permission persistence and releases after rejection', async () => {
  const f = fixture(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.epoch.client.tx.mockImplementationOnce(async () => { await barrier; throw new Error('persist failed'); });
  const result = expect(f.run()).rejects.toThrow('persist failed');
  await vi.waitFor(() => expect(f.epoch.client.tx).toHaveBeenCalled());
  const send = vi.fn(async () => {});
  await expect(withSendToSessionLock('task', send)).rejects.toThrow('restart');
  expect(send).not.toHaveBeenCalled();
  release(); await result;
  await withSendToSessionLock('task', send); expect(send).toHaveBeenCalledOnce();
 });


it.each(['bypassPermissions', 'auto', 'acceptEdits'])('does not report %s as granted after plugin authority is lowered', async permissionMode => {
 const f = fixture();
 f.service.get.mockImplementation(async () => ({taskId:'task',revision:1,status:'active',permissionMode}));
 f.dialog.showMessageBox.mockResolvedValue({response:1});
 await expect(f.run()).resolves.toMatchObject({granted:false});
 expect(f.dialog.showMessageBox).toHaveBeenCalledOnce();
 expect(f.live.setPermissionMode).not.toHaveBeenCalled();
});
it.each(['acceptEdits', 'auto'])('reuses an effective %s grant without another confirmation',async permissionMode=>{
 const f=fixture();f.change({permissionMode});
 f.service.get.mockImplementation(async()=>({taskId:'task',revision:1,status:'active',permissionMode}));
 await expect(f.run()).resolves.toMatchObject({granted:true});expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
});

it.each(['plan', 'acceptEdits', 'auto'])('rejects archived %s tasks before reuse or confirmation', async permissionMode => {
 const f=fixture();f.change({permissionMode});
 f.service.get.mockResolvedValue({taskId:'task',revision:1,status:'archived',permissionMode});
 await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
 expect(f.dialog.showMessageBox).not.toHaveBeenCalled();expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.epoch.client.tx).not.toHaveBeenCalled();
});
it('rejects archival while confirmation is open even if revision is unchanged',async()=>{
 const f=fixture();f.dialog.showMessageBox.mockImplementationOnce(async()=>{
  f.service.get.mockResolvedValue({taskId:'task',revision:1,status:'archived',permissionMode:'plan'});return {response:0};
 });
 await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
 expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.epoch.client.tx).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
});

describe('permission commits share the same order', () => {
 it.each(['local','remote','cold','im','im-cold'].flatMap(entry=>['runtime','database','lastRead'].filter(point=>!entry.includes('cold')||point!=='runtime').map(point=>({entry,point}))))('keeps a later Ask after plugin grant/rollback: $entry $point',async({entry,point})=>{
  const f=fixture();if(entry==='remote')f.remote();if(entry.includes('cold'))f.cold();
  let release!:()=>void,entered!:()=>void;
  const barrier=new Promise<void>(r=>{release=r;}), started=new Promise<void>(r=>{entered=r;});
  const pause=async()=>{entered();await barrier;};
  if(point==='runtime')f.live.setPermissionMode.mockImplementationOnce(pause);
  if(point==='database')f.epoch.client.tx.mockImplementationOnce(async(_name,args)=>{await pause();f.history.permissionMode=args!.mode;return {updated:true};});
  if(point==='lastRead')f.service.get.mockImplementationOnce(async()=>({taskId:'task',revision:1,status:'active',permissionMode:'plan'}))
   .mockImplementationOnce(async()=>({taskId:'task',revision:1,status:'active',permissionMode:'plan'}))
   .mockImplementationOnce(async()=>{await pause();throw Error('owner revoked');});
  const grant=f.run('auto').then(()=> 'granted',(e: Error)=>e.message);
  await started;
  const change=entry.startsWith('im')?f.setImMode('ask'):f.setMode('ask');
  // Let the ordinary handler reach its old runtime-only boundary before the
  // delayed plugin write, or queue behind the complete grant after the fix.
  await Promise.resolve();await Promise.resolve();
  release();await grant;const result=await change;
  expect(f.history.permissionMode).toBe('ask');
  if(!entry.includes('cold'))expect(f.runtimeMode()).toBe('ask');
  if(entry==='remote')expect(f.persistedResults.has(result as object)).toBe(true);
 });

 it('does not block a user downgrade while the plugin dialog is open',async()=>{
  const f=fixture();let answer!:()=>void;
  f.dialog.showMessageBox.mockImplementationOnce(()=>new Promise(r=>{answer=()=>r({response:1});}));
  const grant=f.run('auto');await vi.waitFor(()=>expect(answer).toBeTypeOf('function'));
  await f.setMode('ask');expect(f.history.permissionMode).toBe('ask');
  answer();await grant;
 });

 it('rejects a queued permission change after the account changes',async()=>{
  const f=fixture();let release!:()=>void;
  const prior=withSessionPermissionChange('task',()=>new Promise<void>(r=>{release=r;}));
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const next=f.setMode('ask');const rejected=expect(next).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  f.changeOwner();release();await prior;await rejected;
  expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.epoch.client.tx).not.toHaveBeenCalled();
 });
});

it.each(['local','remote','cold','im','im-cold'])('recovers from a failed %s commit before accepting the next change',async entry=>{
 const f=fixture();if(entry==='remote')f.remote();if(entry.includes('cold'))f.cold();
 f.epoch.client.tx.mockRejectedValueOnce(Error('db failed'));
 const change=(mode:PermissionMode)=>entry.startsWith('im')?f.setImMode(mode):f.setMode(mode);
 const first=change('auto').catch(e=>e.message);
 const later=change('ask');
 if(entry.startsWith('im'))expect(await first).toMatchObject({kind:'failed'});else expect(await first).toBe('db failed');
 await later;
 expect(f.history.permissionMode).toBe('ask');
 if(!entry.includes('cold')){
  expect(f.live.setPermissionMode.mock.calls).toEqual([['auto'],['plan'],['ask']]);
  expect(f.runtimeMode()).toBe('ask');
 }
});
it.each(['local','remote','cold','im','im-cold'])('preserves repeated/ABA choices through %s',async entry=>{
 const f=fixture();if(entry==='remote')f.remote();if(entry.includes('cold'))f.cold();
 const change=(mode:PermissionMode)=>entry.startsWith('im')?f.setImMode(mode):f.setMode(mode);
 await Promise.all([change('ask'),change('auto'),change('ask'),change('ask')]);
 expect(f.epoch.client.tx.mock.calls.map(call=>call[1]?.mode)).toEqual(['ask','auto','ask','ask']);
 expect(f.history.permissionMode).toBe('ask');
 if(!entry.includes('cold'))expect(f.runtimeMode()).toBe('ask');
});
it.each(['queued','runtime','database'])('rejects IM ownership changes during %s without touching the new account',async point=>{
 const f=fixture();let release!:()=>void;
 let prior:Promise<void>|undefined;
 if(point==='queued'){
  prior=withSessionPermissionChange('task',()=>new Promise<void>(r=>{release=r;}));
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 }
 if(point==='runtime')f.live.setPermissionMode.mockImplementationOnce(async()=>{f.changeOwner();});
 if(point==='database')f.epoch.client.tx.mockImplementationOnce(async()=>{f.changeOwner();return {updated:true};});
 const next=f.setImMode('ask').catch(e=>({kind:'failed',reason:e.message}));
 if(point==='queued'){f.changeOwner();release();await prior;}
 expect(await next).toMatchObject({kind:'failed',reason:'Account changed during permission update'});
 expect(f.live.setPermissionMode).toHaveBeenCalledTimes(point==='queued'?0:1);
 expect(f.epoch.client.tx).toHaveBeenCalledTimes(point==='database'?1:0);
});

it('lets a real Session policy lease restore through the send fence while a permission commit waits',async()=>{
 const f=fixture(), transport=vi.fn(async()=>{});
 const logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return logger;}};
 const session=new Session({id:'task',agentKind:'codex',workDir:'/fixture',permissionMode:'ask',turnStallMs:0,
  handle:{setPermissionMode:transport,setInteractionResolver(){},close:async()=>{}} as never,
  capabilities:{permissionModes:[{id:'ask'},{id:'bypassPermissions'}],setPermissionModeMidSession:{supported:true},
   turnPermissionPolicy:{unsupportedPermissionModes:['bypassPermissions']}} as never,logger});
 const releaseLease=session.acquireTurnLease();
 f.live.setPermissionMode.mockImplementation(mode=>session.setPermissionMode(mode as PermissionMode));
 let started!:()=>void;const entered=new Promise<void>(r=>{started=r;});
 f.live.setPermissionMode.mockImplementationOnce(mode=>{started();return session.setPermissionMode(mode as PermissionMode);});
 const change=f.setMode('bypassPermissions');
 try{
  await entered;
  expect(transport).not.toHaveBeenCalled();
  // The continuation's existing send fence and Host-owned restore stay free.
  await withSendToSessionLock('task',()=>session.setPermissionModeTracked('ask'));
  expect(transport).toHaveBeenCalledExactlyOnceWith('ask');
  expect(f.epoch.client.tx).not.toHaveBeenCalled();
 }finally{releaseLease();await change;await session.close();}
 expect(transport.mock.calls).toEqual([['ask'],['bypassPermissions']]);
 expect(f.history.permissionMode).toBe('bypassPermissions');
});


describe('Plan changes share the complete permission commit',()=>{
 it.each(['local','remote','cold'])('persists Plan through Host for %s and recovers before a successor',async entry=>{
  const f=fixture();if(entry==='remote')f.remote();if(entry==='cold')f.cold();
  f.planPersist.mockRejectedValueOnce(Error('plan db failed'));
  const first=f.setPlan(true).catch(e=>e.message);const next=f.setPlan(false);
  expect(await first).toBe('plan db failed');const result=await next;
  expect(f.history.planModeEnabled).toBe(false);expect(f.planPersist).toHaveBeenCalledTimes(2);
  if(entry!=='cold')expect(f.live.setPlanMode.mock.calls).toEqual([[true],[false],[false]]);
  if(entry==='remote')expect(f.persistedResults.has(result as object)).toBe(true);
 });
 it('restores a partially changed runtime even when its setter rejects',async()=>{
  const f=fixture();f.live.setPlanMode.mockImplementationOnce(async()=>{f.nativePlan(true);throw Error('partial runtime');});
  await expect(f.setPlan(true)).rejects.toThrow('partial runtime');
  expect(f.runtimePlan()).toBe(false);expect(f.planPersist).not.toHaveBeenCalled();
 });
 it('rejects a queued Plan change when its captured account is gone',async()=>{
  const f=fixture();let release!:()=>void;const prior=withSessionPermissionChange('task',()=>new Promise<void>(r=>{release=r;}));
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const pending=f.setPlan(true).then(value=>value,error=>error);
  f.changeOwner();release();await prior;expect(await pending).toMatchObject({code:'PRECONDITION_FAILED'});expect(f.planPersist).not.toHaveBeenCalled();expect(f.live.setPlanMode).not.toHaveBeenCalled();
 });
 it.each([true,null])('rejects runtime Plan %s even with a stale already-granted DB snapshot',async enabled=>{
  const f=fixture();f.change({permissionMode:'auto'});f.service.get.mockResolvedValue({taskId:'task',revision:1,status:'active',permissionMode:'auto'});f.nativePlan(enabled);
  await expect(f.run('auto')).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
 });
 it.each(['dialog','lastRead'])('rejects native Plan enabled at %s before its DB mirror',async point=>{
  const f=fixture();if(point==='dialog')f.dialog.showMessageBox.mockImplementationOnce(async()=>{f.nativePlan(true);return {response:0};});
  else f.epoch.client.tx.mockImplementationOnce(async()=>{f.nativePlan(true);return {updated:true};});
  await expect(f.run('auto')).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(f.write).not.toHaveBeenCalled();
 });
 it('keeps the later manual Plan after a plugin grant and DB commit',async()=>{
  const f=fixture();let release!:()=>void;f.epoch.client.tx.mockImplementationOnce(()=>new Promise(r=>{release=()=>r({updated:true});}));
  const grant=f.run('auto');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const plan=f.setPlan(true);await Promise.resolve();expect(f.live.setPlanMode).not.toHaveBeenCalled();release();await grant;await plan;
  expect(f.history.planModeEnabled).toBe(true);expect(f.runtimePlan()).toBe(true);
 });
});


describe('native Plan mirrors preserve the current binding and armed value',()=>{
 const emitter=source.slice(source.indexOf('  const emitWiredSessionEvent ='),source.indexOf('  const ownerDb =',source.indexOf('  const emitWiredSessionEvent =')));
 const code=ts.transpileModule(`${emitter}\nreturn emitWiredSessionEvent;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 it.each(['current','stale-value','unknown','account','replacement'])('handles queued native Plan mirror: %s',async scenario=>{
  const f=fixture();let release!:()=>void;
  const before=withSessionPermissionChange('task',()=>new Promise<void>(r=>{release=r;}));
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const session={...f.live,id:'task'};let bound:unknown=session;
  const deps={session,ownerDb:f.epoch,getCurrentDbClientSnapshot:()=>ownership.current,sessionBindings:{getSession:()=>bound},withSessionPermissionChange,persistSessionFields:f.planPersist,handleSessionEvent:vi.fn(),ownerEventDependencies:{},log:{warn:vi.fn()}};
  const emit=new Function(...Object.keys(deps),code)(...Object.values(deps));
  f.nativePlan(false);expect(emit({type:'plan_mode_changed',data:{enabled:false}})).toBeUndefined();
  // The event callback is synchronous even while a permission change is held.
  expect(f.planPersist).not.toHaveBeenCalled();
  if(scenario==='stale-value')f.nativePlan(true);
  if(scenario==='unknown')f.nativePlan(null);
  if(scenario==='account')f.changeOwner();
  if(scenario==='replacement')bound={};
  release();await before;await withSessionPermissionChange('task',async()=>{});
  if(scenario==='current')expect(f.planPersist).toHaveBeenCalledExactlyOnceWith('task',{planModeEnabled:false});
  else expect(f.planPersist).not.toHaveBeenCalled();
 });
});


describe('new user input waits outside execution fences',()=>{
 const sendStart=source.indexOf('      sendToAgentAccepted: async (sessionId, message, createOpts, sendOpts) => {');
 const sendText=source.slice(sendStart,source.indexOf('      assertRemoteInputControlBoundary:',sendStart));
 const sendJs=ts.transpileModule(`return {${sendText}}.sendToAgentAccepted;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const enqueueStart=source.indexOf('    MAKER_INVOKE.INPUT_ENQUEUE,');
 const enqueueText=source.slice(source.indexOf('      const sid = requireSessionId(sessionId);',enqueueStart),source.indexOf('      if (parsed.durableDelivery)',enqueueStart));
 const enqueueJs=ts.transpileModule(`return async function(event,sessionId,item){${enqueueText}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 it.each(['send','enqueue'].flatMap(entry=>[false,true].map(switchOwner=>({entry,switchOwner}))))('$entry waits for permission and rejects changed owner=$switchOwner',async({entry,switchOwner})=>{
  const f=fixture();let release!:()=>void;
  const prior=withSessionPermissionChange('task',()=>new Promise<void>(r=>{release=r;}));
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const dispatch=vi.fn(async()=>({}));
  const deps={withSessionPermissionChange,getCurrentDbClientSnapshot:()=>ownership.current,throwIpcError:(code:string,message:string)=>{throw Object.assign(Error(message),{code});},sendToAgentAccepted:dispatch,isDeviceLinkInvoke:()=>false,attachTrustedDesktopSendContext:(_m:unknown,o:unknown)=>o,requireSessionId:(id:string)=>id,assertReviewExternalInputAllowed:async()=>{},assertTrustedAppRendererEvent:()=>{},prepareSharedTaskInput:dispatch,requireQueuedMessage:(x:unknown)=>x};
  const run=new Function(...Object.keys(deps),entry==='send'?sendJs:enqueueJs)(...Object.values(deps));
  const result=(entry==='send'?run('task','hello',{},{}):run({},'task',{})).then((v:unknown)=>v,(e:Error)=>e);
  await Promise.resolve();await Promise.resolve();expect(dispatch).not.toHaveBeenCalled();
  // Completion/continuation can use the normal send fence while input waits.
  await withSendToSessionLock('task',async()=>{});
  if(switchOwner)f.changeOwner();release();await prior;const value=await result;
  if(switchOwner){expect(value).toMatchObject({code:'PRECONDITION_FAILED'});expect(dispatch).not.toHaveBeenCalled();}
  else expect(dispatch).toHaveBeenCalledOnce();
 });
});
