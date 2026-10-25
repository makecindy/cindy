import { createProjectAutomationLoader } from '@cindy/app-runtime/projectAutomationLoader';
import { createProjectAutomationIpc } from '@cindy/app-runtime/projectAutomationIpc';
import { createLegacyXdmakerMigration } from '@cindy/app-runtime/legacyXdmakerMigration';
import { createScheduleLock } from '@cindy/app-runtime/scheduleLock';
import { buildForcedFailureRun } from '@cindy/app-runtime/scheduleForcedFailureRun';
import { createScriptScheduleRunner } from '@cindy/app-runtime/scheduleScriptRunner';
import { createScheduledTargetRestore, createScheduledTargetValidator } from '@cindy/app-runtime/scheduledTargetRestore';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createSchedulerScriptCapabilityBroker } from '@cindy/app-runtime/scheduleScriptCapabilityBroker';
import { resolveScriptCapabilityStatuses } from '@cindy/app-runtime/scheduleScriptCapabilityStatus';
import type { TerminalPlugins } from '../plugins/host.js';
import path from 'node:path';
import { Scheduler, BUILTIN_TEMPLATES, applyTemplateParams, type Schedule, type ScheduleRun, type FireContext, type CreateScheduleInput, type UpdateScheduleInput, type ListFilter } from '@cindy/maker-scheduler';
import type { Logger } from '@cindy/maker-core';
import type { RemoteResourceRegistry, RemoteCollectionItem } from '@cindy/device-link';
import type { InvocationContext } from '../contracts.js';
import { openTerminalScheduleStorage,type TerminalScheduleStorage } from './schedule-storage.js';
import {registerScheduleHistoryIpc} from '@cindy/app-runtime/scheduleHistoryIpc';
import type {IpcHandler} from '@cindy/app-runtime/ipcHandlerRegistry';
import { preRun } from './schedule-process.js';
import type { TerminalCompanionHost } from '../remote/companions/host.js';
import type { TerminalTaskHost } from './host.js';
import { scheduleForm, scheduleFormInput, scheduleText } from './schedule-resources.js';
import type { TerminalWorktrees } from '../worktrees/host.js';


export const TERMINAL_SCHEDULE_CHANNELS = ['list','get','create','update','delete','pause','resume','run-now','list-runs','delete-run','get-inflight-count','get-runtime-state','get-unread-count','mark-run-read','mark-all-runs-read','mark-schedule-runs-read','list-sidebar-index-runs','list-templates','create-from-template','script-capability-status'].map(action=>`maker:schedule:${action}`);
export interface TerminalSchedulerOptions {
  profileDir: string;
  tasks: TerminalTaskHost;
  worktrees?: TerminalWorktrees;
  plugins?: TerminalPlugins;
  /** Construct storage/IPC while the host waits for credential unlock. */
  startPaused?: boolean;
  companions?(): TerminalCompanionHost | undefined;
  logger: Logger;
  emit(channel: string, args: unknown[]): void;
  /** Host closure invalidated on owner switch, including while a script awaits. */
  canDispatch?(): boolean;
  notify?(schedule: Schedule, run: ScheduleRun): Promise<void>;
}
function object(value: unknown): Record<string,unknown> { if(!value || typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_ARGUMENT');return value as Record<string,unknown>; }
function text(value: unknown): string {if(typeof value!=='string'||!value)throw new Error('INVALID_ARGUMENT');return value;}

/** One owner-scoped scheduler, using the shared engine for every trigger and run. */
export class TerminalSchedulerHost {
  get channels(){return [...new Set([...TERMINAL_SCHEDULE_CHANNELS,...this.historyHandlers.keys()])];}
  private historyHandlers=new Map<string,IpcHandler>();
  storage!: TerminalScheduleStorage;
  engine!: Scheduler;
  readonly ready: Promise<void>;
  private closed=false;
  private projectAutomationIpc?: ReturnType<typeof createProjectAutomationIpc>;
  private projectAutomationStartup?: Promise<void>;
  private activation?: Promise<void>;
  private reconcileProjects?: () => Promise<void>;
  private promptRunner!: Awaited<ReturnType<TerminalTaskHost['createSchedulerPromptRunner']>>;
  constructor(private readonly options: TerminalSchedulerOptions) {
    this.ready=this.initialize();
  }
  private async initialize(){
    const options=this.options;
    this.storage=await openTerminalScheduleStorage(options.tasks);
    const [database, conversations] = await Promise.all([options.tasks.database, options.tasks.conversations]);
    const restore = createScheduledTargetRestore({
      ...conversations.snapshot,
      restoreArchivedSessionForSend: (id, restoreOptions) => options.tasks.restoreArchivedSessionForSend(id, restoreOptions),
      withSessionRouteLock: (id, action) => options.tasks.routes.withLock(id, action),
      getManagedWorktreeReadinessForSession: (id, directory) => {
        if (!options.worktrees) throw new Error('SCHEDULE_WORKTREE_NOT_CONFIGURED');
        return options.worktrees.restore.getManagedWorktreeReadinessForSession(id, directory);
      },
    });
    const { ScriptScheduleRunner } = createScriptScheduleRunner(restore);
    const scriptContext = new AsyncLocalStorage<{ schedule: Schedule; fire: FireContext }>();
    const { SchedulerScriptCapabilityBroker } = createSchedulerScriptCapabilityBroker({
      findTrustedXdGhostForScript: id => { this.guard(); return options.plugins?.identity.findTrustedXdGhostForScript(id) ?? null; },
      getGhostCardService: () => { if (!options.plugins) throw new Error('PLUGIN_HOST_NOT_READY'); return options.plugins.cards; },
      getGhostPipeDispatcher: () => { this.guard(); if (!options.plugins?.native.dispatcher) throw new Error('PLUGIN_HOST_NOT_READY'); return options.plugins.native.dispatcher; },
      ...conversations.snapshot,
      restoreArchivedSessionForSend: id => options.tasks.restoreArchivedSessionForSend(id),
      tryGetOrcaCollabService: () => ({ sendToSession: async input => {
        const context = scriptContext.getStore();
        if (!context) throw new Error('SCRIPT_RUN_NOT_ACTIVE');
        const { schedule, fire } = context;
        const current = () => { this.guard(); fire.signal.throwIfAborted(); if (fire.canDispatch?.() === false) throw new Error('SCHEDULE_OWNER_CHANGED'); };
        current();
        let id = input.targetSessionId;
        if (!id) {
          const defaults = input.createDefaults!;
          const created = await options.tasks.invoke('maker:create-session', [{ ...defaults, title: input.title ?? schedule.name,
            workingDir: defaults.workingDir, source: 'scheduler' }], { source: 'local', assertCurrent: current }) as { id: string };
          id = created.id;
        }
        current();
        const target = await options.tasks.storage.get(id);
        if (!target || target.deleted || target.archived) return { ok: false, errorCode: target?.archived ? 'ARCHIVED' : 'NOT_FOUND', message: 'Task is unavailable' };
        await options.tasks.submitScheduled(id, input.message, { scheduleId: schedule.id, scheduleName: schedule.name,
          runId: fire.runId, firedAt: fire.firedAt, assertCurrent: current });
        current();
        return { ok: true, targetSessionId: id, agentKind: target.agentKind, wakeKind: input.targetSessionId ? 'queued' : 'created',
          targetTitle: target.title ?? null, targetLastUserSendAt: target.userSendAt ? new Date(target.userSendAt).toISOString() : null };
      } }),
    });
    const scriptBroker = new SchedulerScriptCapabilityBroker({ resolveDefaultModelRoute: async (agentKind, providerId) => {
      const { selection } = await options.tasks.models.select({ agentKind, ...(providerId ? { providerId } : {}) });
      return { model: selection.model, providerId: selection.providerId };
    } });
    const scriptRunner = new ScriptScheduleRunner({
      getDb: () => { this.guard(); return database.getDbClient().drizzle; },
      logger: options.logger,
      notifier: { notify: (schedule, run) => this.notifyRun(schedule, run) },
      broker: { call: (request, granted, context) => {
        this.guard(); scriptContext.getStore()?.fire.signal.throwIfAborted();
        return scriptBroker.call(request, granted, context);
      }, finalizeActiveCalls: id => scriptBroker.finalizeActiveCalls(id) },
    });
    const fireScript = async (schedule: Schedule, ctx: FireContext) => {
      this.guard(); ctx.signal.throwIfAborted();
      return scriptContext.run({ schedule, fire: ctx }, () => scriptRunner.fire(schedule, ctx));
    };
    this.promptRunner = await options.tasks.createSchedulerPromptRunner({ notify: (schedule, run) => this.notifyRun(schedule, run) });
    const { withScheduleLock } = createScheduleLock();
    this.engine=new Scheduler({storage:this.storage,runner:{fire:(schedule,ctx)=>withScheduleLock(schedule.id,ctx.signal,()=>schedule.executionMode==='script'?fireScript(schedule,ctx):this.fire(schedule,ctx))},generateId:randomUUID,processId:process.pid,instanceId:randomUUID(),logger:options.logger,notifyForcedFailure:async({scheduleId,runId,errorMsg})=>{
      const schedule=await this.storage.get(scheduleId);if(!schedule)return;
      const run=(await this.storage.listRuns(scheduleId,20)).find(item=>item.id===runId);
      await this.notifyRun(schedule,buildForcedFailureRun({scheduleId,runId,errorMsg,run,now:Date.now()}));
    },isManagedWorkspaceDir: dir => options.tasks.dialogueWorkspaceRoots().some(root => {
      const relative = path.relative(root, dir); return !relative.startsWith('..') && !path.isAbsolute(relative);
    }),validateTargetSession:createScheduledTargetValidator(()=>{this.guard();return database.getDbClient().drizzle;})});
    scriptRunner.attachScheduler(this.engine);
    this.promptRunner.attachScheduler(this.engine);
    for(const name of ['fired','completed','failed','skipped','deferred','session-bound','changed','runtime-state','silenced','notified'] as const) this.engine.on(name as 'changed', (event)=>{
      if(this.closed)return;
      options.tasks.sessionActivity.service.handleScheduleEvent(event);
      options.emit('maker:schedule:event',[event]);
      if(['completed','failed'].includes(event.type)&&!(event as {silenced?:boolean}).silenced)void this.notify(event as unknown as {scheduleId:string;runId:string});
    });
    options.tasks.configureScheduler({getScheduler:()=>{this.guard();return this.engine;}});
    registerScheduleHistoryIpc({
      ipcMain:{handle:(channel,handler)=>this.historyHandlers.set(channel,handler)},
      withScheduler:async action=>{this.guard();return action({storage:this.storage,scheduler:this.engine});},
      broadcast:(channel,payload)=>{if(!this.closed)options.emit(channel,[payload]);},
    });
    const { ProjectAutomationLoader } = createProjectAutomationLoader({
      ...conversations.rowMapper, ...createLegacyXdmakerMigration(options.logger),
    });
    const loader = new ProjectAutomationLoader({scheduler:this.engine,storage:this.storage,
      getDb:()=>{this.guard();return database.getDbClient().drizzle;},logger:options.logger});
    this.projectAutomationIpc = createProjectAutomationIpc({
      ...conversations.rowMapper, getDbClient:()=>{this.guard();return database.getDbClient();},log:options.logger,
      ipcMain:{handle:(channel,handler)=>this.historyHandlers.set(channel,handler),removeHandler:channel=>{this.historyHandlers.delete(channel);}},
      broadcast:(channel,payload)=>{if(!this.closed)options.emit(channel,[payload]);},
    });
    this.projectAutomationIpc.registerProjectAutomationIpc(loader);
    this.reconcileProjects=()=>loader.reconcileAll();
    if(!options.startPaused)await this.startEngine();
  }
  async activate(){await this.ready;return this.startEngine();}
  private startEngine():Promise<void>{
    if(this.closed)return Promise.resolve();
    if(this.activation)return this.activation;
    const options=this.options;
    const pending=Promise.resolve().then(async()=>{
    if(!this.closed){
      await this.engine.start();
      if(this.closed){await this.engine.stop();return;}
      try { await this.storage.deleteOrphanRuns(); } catch(error) { options.logger.warn('Scheduler orphan run cleanup failed',{error:String(error)}); }
      if(this.closed)return;
      this.projectAutomationStartup=this.reconcileProjects!().catch(error=>options.logger.warn('Project automation startup failed',{error:String(error)}));
      options.emit('maker:schedule:event',[{type:'ready'}]);
    }
    });
    this.activation=pending;
    void pending.catch(()=>{if(this.activation===pending)this.activation=undefined;});
    return pending;
  }
  private guard(context?:InvocationContext){if(this.closed || this.options.canDispatch?.()===false)throw new Error('SCHEDULE_OWNER_CHANGED');if(context?.sharedTask)throw new Error('SHARED_TASK_PERMISSION_DENIED');context?.signal?.throwIfAborted();context?.assertCurrent?.();}
  private async notify(event:{scheduleId:string;runId:string}){
    const schedule=await this.storage.get(event.scheduleId);const run=(await this.storage.listRuns(event.scheduleId,Number.MAX_SAFE_INTEGER)).find(item=>item.id===event.runId);if(!schedule||!run||this.closed)return;
    if (schedule.executionMode !== 'script' && schedule.targetSessionId && await this.options.companions?.()?.owns(schedule.targetSessionId)) await this.notifyRun(schedule, run);
  }
  private async notifyRun(schedule:Schedule,run:ScheduleRun) {
    if(this.closed)return;
    if(this.options.notify)await this.options.notify(schedule,run).catch(()=>this.options.logger.warn('SCHEDULE_NOTIFICATION_FAILED'));
    else if(schedule.notify.desktop)this.options.emit('terminal:notification',[{id:run.id,title:schedule.name,text:run.resultText??run.errorMsg??run.status,sessionId:run.sessionId}]);
  }
  private validateInput(input:Record<string,unknown>){
    const notify=input.notify as Schedule['notify']|undefined;
    if((notify?.feishu || notify?.wecomGroup)&&!this.options.notify)throw new Error('SCHEDULE_NOTIFICATION_CONNECTION_REQUIRED');
    const script=input.scriptConfig as Schedule['scriptConfig'];
    if(input.useWorktree && !this.options.worktrees)throw new Error('SCHEDULE_WORKTREE_NOT_CONFIGURED');
  }
  private async fire(schedule: Schedule, ctx: FireContext) {
    this.guard(); ctx.signal.throwIfAborted();
    const companion = this.options.companions?.();
    if (schedule.targetSessionId && companion && await companion.owns(schedule.targetSessionId)) return this.fireCompanion(companion, schedule, ctx);
    return this.promptRunner.fire(schedule, ctx);
  }
  private async fireCompanion(host:TerminalCompanionHost,schedule:Schedule,ctx:FireContext){
    const profile=await host.profileForSession(schedule.targetSessionId!);
    await host.assertMayRun(profile.id);
    if(await host.isBusy(profile.id))return {sessionId:profile.sessionId,deferred:true,deferRetryMs:15_000};
    const current=()=>{this.guard();ctx.signal.throwIfAborted();if(ctx.canDispatch?.()===false)throw new Error('ROUTINE_CANCELLED');};
    current();
    const hook=await preRun(schedule,ctx,path.join(host.profiles.home(profile.id),'workspace'));
    current();await host.assertMayRun(profile.id);
    if(hook){await ctx.onPreRunHookCompleted?.(hook);if(hook.decision==='skip')return {sessionId:profile.sessionId,skipped:true,resultText:hook.stdout};if(hook.decision!=='run')throw new Error('PRE_RUN_HOOK_FAILED');}
    const abort=()=>{void host.stop(profile.id).catch(()=>{});};ctx.signal.addEventListener('abort',abort,{once:true});
    try{
      current();await ctx.onSessionBound?.(profile.sessionId);
      const sent=await host.submitScheduled(profile.id,schedule.prompt,{kind:'scheduler',scheduleId:schedule.id,scheduleName:schedule.name,runId:ctx.runId,firedAt:ctx.firedAt},current);
      await ctx.onTurnActive?.(profile.sessionId);
      const resultText=await sent.completion;current();return {sessionId:profile.sessionId,resultText};
    }finally{ctx.signal.removeEventListener('abort',abort);}
  }
  async invoke(channel:string,args:unknown[]=[],context:InvocationContext={source:'local'}):Promise<unknown>{
    await this.ready;this.guard(context);const handler=this.historyHandlers.get(channel);if(handler)return handler(context,...args);let result:unknown;const id=()=>text(args[0]);
    switch(channel){
      case 'maker:schedule:list':result=await this.engine.list(args[0] as ListFilter|undefined);break;
      case 'maker:schedule:get':result=await this.engine.get(id());break;
      case 'maker:schedule:create':{const input=object(args[0]);this.validateInput(input);result=await this.engine.create(input as unknown as CreateScheduleInput);break;}
      case 'maker:schedule:update':{const input=object(args[1]);this.validateInput(input);result=await this.engine.update(id(),input as UpdateScheduleInput);break;}
      case 'maker:schedule:delete':result=await this.engine.delete(id());break;
      case 'maker:schedule:pause':result=await this.engine.pause(id());break;
      case 'maker:schedule:resume':result=await this.engine.resume(id());break;
      case 'maker:schedule:run-now':result=await this.engine.runNow(id(),{canDispatch:()=>!this.closed&&this.options.canDispatch?.()!==false});break;
      case 'maker:schedule:list-templates':result=BUILTIN_TEMPLATES;break;
      case 'maker:schedule:create-from-template': {
        const body=object(args[0]);const template=BUILTIN_TEMPLATES.find(item=>item.id===text(body.templateId));if(!template)throw new Error('TEMPLATE_NOT_FOUND');
        const parameters=body.paramValues?object(body.paramValues):{};if(Object.values(parameters).some(value=>typeof value!=='string'))throw new Error('INVALID_TEMPLATE_PARAMETERS');
        const overrides=body.overrides?object(body.overrides):{};const input={name:template.name,kind:'cron',cronExpr:template.cronExpr,timezone:template.timezone,recurring:template.recurring??true,agentKind:template.agentKind??'claude-code',model:template.model,providerId:template.providerId,effort:template.effort,fastMode:template.fastMode,useWorktree:template.useWorktree??false,persistentSession:template.persistentSession,silentWhenIdle:template.silentWhenIdle,notify:template.notify??{desktop:true,feishu:false},...overrides,prompt:overrides.prompt??applyTemplateParams(template.prompt??'',parameters as Record<string,string>,template.parameters)};
        this.validateInput(input);result=await this.engine.create(input as CreateScheduleInput);break;
      }
      case 'maker:schedule:script-capability-status':result={statuses:resolveScriptCapabilityStatuses((this.options.plugins?.native.list() ?? []).filter(ghost => this.options.plugins!.identity.findTrustedXdGhostForScript(ghost.manifest.id) !== null).map(ghost => ({ id: ghost.manifest.id, name: ghost.manifest.name, enabled: ghost.enabled })))};break;
      default:throw new Error(`UNSUPPORTED_CHANNEL:${channel}`);
    }
    this.guard(context);return result;
  }
  registerResources(registry:RemoteResourceRegistry){
    const item=(schedule:Schedule):RemoteCollectionItem=>({
      ref:{collectionId:'schedules',kind:'schedule',id:schedule.id},revision:String(schedule.updatedAt),
      display:{title:schedule.name,subtitle:schedule.intervalMs?`${schedule.intervalMs/1000}s`:schedule.cronExpr,
        status:{label:schedule.status==='active'?scheduleText('active'):scheduleText('paused'),tone:schedule.status==='active'?'positive':'neutral'}},
      links:schedule.targetSessionId?[{rel:'task',target:{kind:'session',sessionId:schedule.targetSessionId}}]:[],
      actions:[{id:'run-now',label:scheduleText('run')},{id:schedule.status==='active'?'pause':'resume',label:scheduleText(schedule.status==='active'?'pause':'resume')},scheduleForm(schedule),
        {id:'delete',label:scheduleText('delete'),tone:'destructive',confirmation:{title:scheduleText('deleteTitle'),confirmLabel:scheduleText('delete')}}],
    });
    registry.register({
      collection:{id:'schedules',resourceKind:'schedule',title:scheduleText('schedules'),placement:'sidebar',actions:[scheduleForm()]},
      list:async(context,request)=>{
        await this.ready;this.guard();context.assertCurrent?.();const rows=await this.engine.list();
        const offset=request.cursor?Number(request.cursor):0;if(!Number.isInteger(offset)||offset<0)throw new Error('INVALID_CURSOR');
        const limit=Math.min(request.limit??100,100);return {collectionId:'schedules',revision:rows.map(row=>row.updatedAt).join(','),items:rows.slice(offset,offset+limit).map(item),...(offset+limit<rows.length?{nextCursor:String(offset+limit)}:{})};
      },
      get:async(context,request)=>{
        await this.ready;this.guard();context.assertCurrent?.();const row=await this.engine.get(request.ref.id);if(!row)throw new Error('SCHEDULE_NOT_FOUND');
        return {...item(row),blocks:[{id:'prompt',primitive:'text',fallbackMarkdown:row.prompt},{id:'configuration',primitive:'text',fallbackMarkdown:[row.workingDir,row.model,row.timezone].filter(Boolean).join(' · ')},
          {id:'edit',primitive:'form',fallbackMarkdown:'',data:{actionId:'edit',values:{name:row.name,prompt:row.prompt,workingDir:row.workingDir,agentKind:row.agentKind,providerId:row.providerId??'',model:row.model??'',kind:row.intervalMs?'interval':'cron',cronExpr:row.cronExpr,intervalSeconds:row.intervalMs?String(row.intervalMs/1000):'',timezone:row.timezone,useWorktree:row.useWorktree,__revision:String(row.updatedAt)}}}]};
      },
      invoke:async(context,request)=>{
        await this.ready;this.guard();context.assertCurrent?.();
        const invocation:InvocationContext={source:'local',assertCurrent:context.assertCurrent};
        if(request.actionId==='create'&&!request.resourceRef){
          const input=scheduleFormInput(request.input??{});this.validateInput(input as Record<string,unknown>);
          await this.invoke('maker:schedule:create',[input],invocation);
        }else{
          if(!request.resourceRef||request.resourceRef.kind!=='schedule'||request.resourceRef.collectionId!=='schedules')throw new Error('INVALID_ACTION');
          const row=await this.engine.get(request.resourceRef.id);if(!row)throw new Error('SCHEDULE_NOT_FOUND');context.assertCurrent?.();
          if(request.actionId==='edit'){
            if(request.input?.__revision!==undefined&&request.input.__revision!==String(row.updatedAt))throw new Error('SCHEDULE_REVISION_CHANGED');
            await this.invoke('maker:schedule:update',[row.id,scheduleFormInput(request.input??{},row)],invocation);
          }
          else if(['run-now','pause','resume','delete'].includes(request.actionId))await this.invoke(`maker:schedule:${request.actionId}`,[row.id],invocation);
          else throw new Error('INVALID_ACTION');
        }
        return {effects:[{kind:'refresh-collection',collectionId:'schedules'}]};
      },
    });
  }
  async close(){this.closed=true;this.options.tasks.configureScheduler(undefined);await this.ready;this.projectAutomationIpc?.dispose();await this.activation?.catch(()=>{});await this.projectAutomationStartup;await this.engine?.stop();}
}
