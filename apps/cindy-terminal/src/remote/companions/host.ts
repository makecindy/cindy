import {createTerminalCompanionServices} from './original-services.js';
import {linkedProjectDirectoryKey} from '@cindy/app-runtime/botLinkedProjects';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Logger} from '@cindy/maker-core';
import {createBotWorkbenchStore} from '@cindy/companion-core/workbench';
import {normalizeTaskInput,type InputHost} from '../../tasks/input.js';
import type {TerminalTaskHost,TaskInvocationContext} from '../../tasks/host.js';
import type {TerminalTaskStorage,Submission,HistoryRecord} from '../../tasks/storage.js';
import type {ModelSelection} from '../../models/config.js';
import type {InvocationContext} from '../../contracts.js';
import {TerminalCompanionModels} from './models.js';
import {TerminalCompanionProfiles,type TerminalCompanionProfile} from './profiles.js';
import type {TerminalCompanionRoutines} from './routines.js';

type CompanionSchedule=NonNullable<Submission['scheduler']>;
type CompanionContext=TaskInvocationContext;
/** Compatibility ports for terminal resources and cloud transport. All task
 * execution, state and recovery belong to the same host as ordinary GUI tasks. */
export class TerminalCompanionHost {
  readonly profiles:TerminalCompanionProfiles;
  readonly modelSettings:TerminalCompanionModels;
  readonly storage:TerminalTaskStorage;
  readonly ready:Promise<void>;
  readonly workbench:ReturnType<typeof createBotWorkbenchStore>;
  routines?:TerminalCompanionRoutines;
  services!:Awaited<ReturnType<typeof createTerminalCompanionServices>>;
  private readonly shutdown=new AbortController();
  private executionGuard?: (id:string)=>Promise<void>;
  constructor(
    readonly options: {
      tasks: TerminalTaskHost;
      root: string;
      profileDir: string;
      logger: Logger;
      guard(): void;
      emit(channel: string, args: unknown[]): void;
      binary(kind: ModelSelection['agentKind']): Promise<string | null>;
      resolveModel?: ConstructorParameters<typeof TerminalCompanionModels>[0]['resolve'];
      providerViews?: ConstructorParameters<typeof TerminalCompanionModels>[0]['views'];
      modelLocations?: ConstructorParameters<typeof TerminalCompanionModels>[0]['locations'];
      isGroupedProvider?: ConstructorParameters<typeof TerminalCompanionModels>[0]['isGrouped'];
      attachments?: Pick<InputHost, 'ingestAttachment' | 'resolveAttachment'>;
      isShadowed?(id:string):boolean;
      beforeDelete?(id:string):Promise<void>;
      afterDelete?(id:string,assertCurrent:()=>void):Promise<void>;
    },
  ) {
    const tasks=options.tasks;
    this.storage=tasks.storage;
    this.profiles=new TerminalCompanionProfiles(options.profileDir,()=>this.guard(),tasks);
    this.modelSettings=new TerminalCompanionModels({root:options.root,ownerRoot:options.profileDir,models:tasks.models,
      logger:options.logger,binary:options.binary,locations:options.modelLocations,guard:()=>this.guard(),resolve:options.resolveModel,
      views:options.providerViews,isGrouped:options.isGroupedProvider,original:()=>tasks.botModelSettings});
    this.workbench=createBotWorkbenchStore({profileDir:(_root,id)=>this.profiles.home(id),
      directoryKey:linkedProjectDirectoryKey,
      logger:options.logger,changed:id=>this.changed(id)});
    this.ready=Promise.all([tasks.ready,this.modelSettings.ready]).then(async()=>{this.guard();if(!tasks.bots)throw new Error('BOT_SERVICES_NOT_READY');this.services=await createTerminalCompanionServices(this);});
    tasks.configureBotLifecycleHooks({
      onPaused:id=>this.routines?.lifecycle(id,'pause'),onResumed:id=>this.routines?.lifecycle(id,'resume'),
      onBeforeDelete:id=>options.beforeDelete?.(id),
      onDeleted:async(id,current)=>{current();await options.afterDelete?.(id,current);await this.routines?.lifecycle(id,'delete');},
    });
  }
  isShadowed(id:string){return this.options.isShadowed?.(id)??false;}
  private guard(){if(this.shutdown.signal.aborted)throw new Error('COMPANION_HOST_CLOSED');this.options.guard();}
  private changed(id:string){this.guard();this.options.emit('maker:remote-resources:changed',[{collectionId:'teammates',resourceRefs:[{collectionId:'teammates',kind:'bot',id}]}]);}
  onChange(listener:(id:string)=>void){return this.options.tasks.onBotProfileChanged(listener);}
  setExecutionGuard(guard:(id:string)=>Promise<void>){this.executionGuard=guard;}
  async assertMayRun(id:string){this.guard();await this.executionGuard?.(id);this.guard();}
  hasLiveSession(id:string){return !!this.options.tasks.channelRuntime().getSession(id);}
  requestHostPermission=(...args:Parameters<TerminalTaskHost['requestHostPermission']>)=>this.options.tasks.requestHostPermission(...args);
  pluginPermissionSnapshot=(...args:Parameters<TerminalTaskHost['pluginPermissionSnapshot']>)=>this.options.tasks.pluginPermissionSnapshot(...args);
  requestPluginWrite=(...args:Parameters<TerminalTaskHost['requestPluginWrite']>)=>this.options.tasks.requestPluginWrite(...args);
  async owns(sessionId:string){const db=(await this.options.tasks.database).getDbClient();this.guard();return !!await db.queryOne('SELECT session_id FROM bot_session_links WHERE session_id = ?',[sessionId]);}
  async profileForSession(sessionId:string){
    const row=await (await this.options.tasks.database).getDbClient().queryOne<{botId:string}>('SELECT bot_id AS botId FROM bot_session_links WHERE session_id = ?',[sessionId]);
    const profile=row?await this.profiles.get(row.botId):null;if(!profile)throw new Error('COMPANION_NOT_FOUND');return profile;
  }
  async ensureCanonical(profile:TerminalCompanionProfile){
    await this.ready;const current=await this.profiles.get(profile.id);if(!current)throw new Error('COMPANION_NOT_FOUND');
    const existing=current.sessionId?await this.storage.get(current.sessionId):null;
    if(existing&&!existing.deleted&&!existing.archived)return current.sessionId;
    const result=await this.options.tasks.bots!.profiles.createBotCanonicalSession({botId:profile.id,expectedCanonicalSessionId:current.sessionId||null,expectedProfileVersion:current.version});
    return result.canonicalSessionId;
  }
  async create(input:Parameters<TerminalCompanionProfiles['create']>[0]){await this.ready;return this.profiles.create(input);}
  async change(id:string,patch:Parameters<TerminalCompanionProfiles['change']>[1],expectedVersion?:number,guard:()=>void=()=>{}){
    if(patch.models)for(const choice of this.modelSettings.parseChain(patch.models))await this.modelSettings.validate(choice);
    guard();return this.profiles.change(id,patch,expectedVersion,guard);
  }
  async remove(id:string){await this.profiles.remove(id);}
  async todos(id:string){await this.ready;this.guard();return this.services.todos.companionTodoStore(id);}
  async isBusy(id:string){const profile=await this.profiles.get(id);return !!profile&&(this.options.tasks.isTurnRunning(profile.sessionId)||this.options.tasks.notificationHasActiveWork(profile.sessionId));}
  async prepareInput(sessionId:string,input:unknown){
    const row=await this.storage.get(sessionId);if(!row)throw new Error('TASK_NOT_FOUND');
    return normalizeTaskInput({profileDir:this.options.profileDir,...this.options.tasks.attachmentHost()},sessionId,input,{source:'local'},row.workDir,()=>this.guard());
  }
  private completion(sessionId:string,clientId:string):Promise<string>{
    return new Promise((resolve,reject)=>{
      const done=(receipt:Submission)=>{if(receipt.sessionId!==sessionId||receipt.requestId!==clientId||!['completed','failed','interrupted'].includes(receipt.status))return;
        cleanup();if(receipt.status==='completed')resolve(receipt.finalText??'');else reject(new Error(receipt.error??'TASK_'+receipt.status.toUpperCase()));};
      const abort=()=>{cleanup();reject(new Error('COMPANION_HOST_CLOSED'));};
      const off=this.options.tasks.onSubmission(done);
      const cleanup=()=>{off();this.shutdown.signal.removeEventListener('abort',abort);};
      this.shutdown.signal.addEventListener('abort',abort,{once:true});
      void this.storage.submission(sessionId,clientId).then(row=>{if(row)done(row);else{cleanup();reject(new Error('SUBMISSION_NOT_FOUND'));}}).catch(error=>{cleanup();reject(error);});
      if(this.shutdown.signal.aborted)abort();
    });
  }
  async send(id:string,input:unknown,clientId:string=randomUUID(),context:CompanionContext={source:'local'}){
    await this.ready;context.assertCurrent?.();await this.assertMayRun(id);
    const profile=await this.profiles.get(id);if(!profile)throw new Error('COMPANION_NOT_FOUND');if(profile.status!=='active')throw new Error('COMPANION_PAUSED');
    const sessionId=await this.ensureCanonical(profile);
    await this.options.tasks.invoke('terminal:tasks:submit',[sessionId,input,{requestId:clientId}],context);
    const completion=this.completion(sessionId,clientId);void completion.catch(()=>{});
    return {accepted:true as const,clientId,completion};
  }
  submitScheduled(id:string,text:string,origin:CompanionSchedule,assertCurrent:()=>void){return this.send(id,text,`schedule_${origin.runId}`,{source:'local',scheduler:origin,assertCurrent});}
  async resumePending(id?:string){await this.ready;for(const profile of id?[await this.profiles.get(id)]:await this.profiles.list())if(profile?.status==='active'){await this.assertMayRun(profile.id);if(profile.sessionId)await this.options.tasks.restoreTaskQueue(profile.sessionId);}}
  async stop(id:string){const profile=await this.profiles.get(id);if(profile?.sessionId)await this.options.tasks.invoke('maker:abort-session',[profile.sessionId]);}
  async records(id:string,after=0,limit=200):Promise<HistoryRecord[]>{const profile=await this.profiles.get(id);if(!profile)throw new Error('COMPANION_NOT_FOUND');return (await this.storage.history(await this.ensureCanonical(profile),after,limit)).records;}
  async messages(sessionId:string){return this.options.tasks.invoke('local-db:messages:list',[sessionId]) as Promise<Array<{id:string;clientId:string;sessionId:string;role:string;content:string;createdAt:string;agentKind:string;agentMeta:Record<string,unknown>|null}>>;}
  projection(sessionId:string,options:Record<string,unknown>={}){return this.options.tasks.invoke('maker:input:get-projection',[sessionId,options]);}
  async permissionState(id:string){const profile=await this.profiles.get(id);if(!profile)throw new Error('COMPANION_NOT_FOUND');
    const row=await this.storage.get(await this.ensureCanonical(profile));if(!row)throw new Error('TASK_NOT_FOUND');
    return {sessionId:row.id,mode:row.permissionMode==='default'?'ask':row.permissionMode??'ask',modes:this.options.tasks.channelRuntime().getCapabilities(row.agentKind).permissionModes};}
  async changePermission(id:string,value:unknown,confirmedFullAccess:boolean,context:InvocationContext){
    if(context.sharedTask)throw new Error('COMPANION_OWNER_REQUIRED');await this.assertMayRun(id);
    if(value==='bypassPermissions'&&!confirmedFullAccess)throw new Error('PERMISSION_CONFIRMATION_REQUIRED');
    const profile=await this.profiles.get(id);if(!profile)throw new Error('COMPANION_NOT_FOUND');
    return this.options.tasks.invoke('maker:set-permission-mode',[await this.ensureCanonical(profile),value],context);
  }
  async invoke(channel:string,args:unknown[],context:InvocationContext):Promise<unknown>{
    this.guard();context.assertCurrent?.();if(context.sharedTask)throw new Error('COMPANION_OWNER_REQUIRED');
    const id=channel==='local-db:history:messages'?(args[0] as {sessionId:string})?.sessionId:args[0];
    if(['maker:send','maker:input:enqueue','maker:input:resume','terminal:tasks:submit'].includes(channel)&&typeof id==='string')await this.assertMayRun((await this.profileForSession(id)).id);
    return this.options.tasks.invoke(channel,args,context);
  }
  hasInteraction(id:string){return this.options.tasks.hasPendingInteraction(id);}
  resolveInteraction(id:string,decision:unknown,context:InvocationContext){return this.options.tasks.invoke('maker:resolve-interaction',[id,decision],context);}
  async close(){this.shutdown.abort();this.services?.close();}
}
