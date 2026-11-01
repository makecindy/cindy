import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createBotRemoteManagement} from '@cindy/app-runtime/botRemoteManagement';
import {createBotRemoteResourceProvider} from '@cindy/app-runtime/botRemoteResourceProvider';
import {createBotTodoAccess} from '@cindy/app-runtime/botTodoAccess';
import {createBotWorkbenchTools} from '@cindy/app-runtime/botWorkbenchTools';
import {createBotWorkbenchTranscripts} from '@cindy/app-runtime/botWorkbenchTranscripts';
import {createCompanionHelperCallbacks} from '@cindy/app-runtime/companionHelperCallbacks';
import {createRemoteWorkbenchMessageReader} from '@cindy/app-runtime/remoteWorkbenchMessages';
import {createWorkbenchCaller} from '@cindy/app-runtime/workbenchCaller';
import {createWorkbenchAuthority} from '@cindy/app-runtime/workbenchAuthority';
import {createBotLinkedProjects,linkedProjectDirectoryKey} from '@cindy/app-runtime/botLinkedProjects';
import {createProjectAliases} from '@cindy/app-runtime/projectAliases';
import {createSidebarSettingsDocument} from '@cindy/app-runtime/sidebarSettingsDocument';
import {createWorkingStatus} from '@cindy/app-runtime/workingStatus';
import {createBotTaskResponsibility} from '@cindy/app-runtime/botTaskResponsibility';
import {createBotAutonomyHostData} from '@cindy/app-runtime/botAutonomyHostData';
import {createBotAutonomySettings} from '@cindy/app-runtime/botAutonomySettings';
import {createBotAutonomyHub} from '@cindy/app-runtime/botAutonomyHub';
import {createBotAutonomyIpc} from '@cindy/app-runtime/botAutonomyIpc';
import {createBotAutonomyService,type BotAutonomyServiceHost} from '@cindy/app-runtime/botAutonomyService';
import {createBotWorkbenchAutonomyBridge} from '@cindy/app-runtime/botWorkbenchAutonomyBridge';
import {SUPPORTED_LOCALES} from '@cindy/plugin-runtime/shared/locale';
import {MAKER_INVOKE,MAKER_PUSH} from '@cindy/maker-shared/maker-channels';
import type {RemoteResourceRegistry} from '@cindy/device-link';
import type {TaskInvocationContext} from '../../tasks/host.js';
import type {TerminalCompanionHost} from './host.js';
import type {TerminalCompanionRoutines} from './routines.js';

export type CompanionObservationTransport=Pick<BotAutonomyServiceHost,'listDevices'|'remoteBackgroundInvoke'|'mayServeBackgroundRead'|'remindOwner'> & {enabled():boolean};

/** The original GUI services own resources, settings and admission. This file
 * supplies the Node process, current owner, SQLite and existing device-link. */
export async function createTerminalCompanionServices(host:TerminalCompanionHost) {
  const tasks=host.options.tasks;
  const [database,conversations]=await Promise.all([tasks.database,tasks.conversations]);
  const bots=tasks.bots;
  if(!bots)throw new Error('BOT_SERVICES_NOT_READY');
  const snapshot=database.getCurrentDbClientSnapshot();
  if(!snapshot)throw new Error('BOT_OWNER_UNAVAILABLE');
  const scope=conversations.broadcastTap.captureDataOwnerBroadcastScope();
  let closed=false;
  const current=()=>{
    if(closed||database.getCurrentDbClientSnapshot()!==snapshot||!conversations.broadcastTap.isDataOwnerBroadcastScopeCurrent(scope))return false;
    try{host.options.guard();return true;}catch{return false;}
  };
  const assertCurrent=()=>{host.options.guard();if(!current())throw new Error('BOT_OWNER_CHANGED');};
  const activeOwnerScopeKey=()=>scope.ownerScopeKey!;
  const isAppSessionBoundaryPending=()=>!current();
  const ownerScopedUserDataPath=(...parts:string[])=>path.join(host.options.profileDir,...parts);
  const owner={activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath};
  const getDbClient=()=>{assertCurrent();return database.getDbClient();};
  const publish=(channel:string,payload:unknown)=>{assertCurrent();host.options.emit(channel,[payload]);};
  const broadcastBotWorkbenchChanged=(botId:string)=>publish(MAKER_PUSH.BOT_WORKBENCH_CHANGED,{botId});
  const invocation=new AsyncLocalStorage<TaskInvocationContext>();
  const ipcMain={handle(channel:string,handler:(event:TaskInvocationContext,...args:any[])=>unknown){
    tasks.registerCompanionIpc(channel,(context,...args)=>{
      assertCurrent();context.assertCurrent?.();
      if(context.sharedTask)throw new Error('COMPANION_OWNER_REQUIRED');
      return invocation.run(context,()=>handler(context,...args));
    });
  }};
  const assertTrustedAppRendererEvent=(context:TaskInvocationContext)=>{
    assertCurrent();context.assertCurrent?.();
    if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');
  };
  const aliases=createProjectAliases({getDbClient,ipcMain,
    broadcastProjectAliasesChanged:()=>publish('local-db:project-aliases:changed',undefined)});
  aliases.registerProjectAliasesIpc();
  const sidebar=createSidebarSettingsDocument({ownerRoot:host.options.profileDir,activeOwnerScopeKey,log:host.options.logger});
  const projects=createBotLinkedProjects({...owner,...host.workbench,...tasks.botProfileLocks,...conversations.botInvalidation,
    getBotRemoteSettingsSource:bots.profiles.getBotRemoteSettingsSource,
    listRecentWorkdirs:conversations.recent.listRecentWorkdirs,listProjectAliases:aliases.listProjectAliases,
    linkedProjectDirectoryKey,loadSidebarSettingsSnapshot:()=>{assertCurrent();sidebar.invalidateIfChanged();return sidebar.read();},
  });
  const caller=createWorkbenchCaller(getDbClient);
  const todos=createBotTodoAccess({...owner,...host.workbench,...caller,...conversations.botInvalidation,
    getDbClient,broadcastBotWorkbenchChanged,saveCancelledInputDelivery:database.inputQueue.saveCancelledInputDelivery});
  await tasks.connectBotTodoDelivery(todos);
  let rosterChanged:(()=>void)|null=null;
  const signalRosterChanged=()=>{try{rosterChanged?.();}catch{}};
  const responsibilities=createBotTaskResponsibility(signalRosterChanged);
  const authority=createWorkbenchAuthority({...owner,...responsibilities,getDbClient,broadcastBotWorkbenchChanged});
  const data=createBotAutonomyHostData({...responsibilities,getDbClient,isCompanionShadowed:id=>host.isShadowed(id)});
  const settings=createBotAutonomySettings({...owner,getActiveAppSession:()=>({dataOwnerId:current()?snapshot.userId:null}),
    legacyUserDataPath:()=>host.options.profileDir,log:host.options.logger});
  const autonomy=createBotAutonomyHub({...owner,...data,...settings,log:host.options.logger});
  autonomy.configureBotAutonomyHost({
    readSessionExecution:id=>{const session=tasks.channelRuntime().getSession(id);return session?{instanceId:session.instanceId,generation:session.getTurnGeneration()}:null;},
    isCompletionHandledByTeammate:(id,botId,execution)=>tasks.botDelegations?.isCompletionHandledByTeammate(id,{pendingForBotId:botId,execution})??Promise.resolve(null),
    getPendingInteractions:id=>tasks.companionPendingInteractions(id),
  });
  const bridge=createBotWorkbenchAutonomyBridge();
  const workbenchTools=createBotWorkbenchTools({...owner,...responsibilities,...bridge,...projects,
    ...createBotWorkbenchTranscripts(getDbClient),getDbClient,broadcastBotWorkbenchChanged});
  const detachHelper=tasks.configureCompanionHelper(input=>createCompanionHelperCallbacks({...workbenchTools,...todos,...owner,
    getActiveAppSession:()=>({dataOwnerId:current()?snapshot.userId:null}),tryGetDbClient:()=>current()?getDbClient():null,
    routineTools:host.routines?.service,createBotProfile:bots.profiles.createBotProfile,
    getTaskActionInputState:id=>({ownerInput:tasks.isTaskInputOwnerAuthored(id)}),
    workbenchHost:{
      sendToSession:async params=>{assertCurrent();const result=await tasks.helperDeps(input).sendToSession!(params);assertCurrent();return result;},
      sendToRemoteSession:async params=>{assertCurrent();const send=tasks.helperDeps(input).sendToRemoteSession;
        if(!send)return {ok:false as const,errorCode:'REMOTE_UNAVAILABLE',message:'这台电脑没有开启跨电脑发送'};
        const result=await send(params);assertCurrent();return result;},
      readRemoteMessages:createRemoteWorkbenchMessageReader(tasks.invokeHelperRemote),
    },
  }),workbenchTools.canBotContinueWorkbenchTask);
  createBotAutonomyIpc({...autonomy,ipcMain,getDbClient,assertTrustedAppRendererEvent,
    isDeviceLinkInvoke:()=>invocation.getStore()?.source==='remote'}).registerBotAutonomyIpc();
  tasks.configureBotInputProjection(autonomy.noteBotAutonomyInputProjection);
  const offRoster=tasks.onBotRosterChanged(signalRosterChanged);
  const working=createWorkingStatus({...owner,SUPPORTED_LOCALES,getMakerIfReady:()=>current()?tasks.channelRuntime():null,
    getEffectiveAuxiliaryModelChainSnapshot:()=>tasks.utility.effectiveSnapshot(),
    requestUtilityText:(_maker,prompt,options)=>tasks.utility.request(prompt,options)});
  ipcMain.handle(MAKER_INVOKE.WORKING_STATUS,(event,raw)=>{assertTrustedAppRendererEvent(event);return working.getWorkingStatusCopy(raw);});
  const management=createBotRemoteManagement({...owner,...bots.profiles,...bots.skills,...tasks.botModelSettings,...tasks.defaultModels,...projects,...autonomy,
    getBotMemoryService:()=>bots.memory,
    requestBotRuntimeEpochRefresh:(...args)=>{assertCurrent();if(!tasks.botRuntimeEpochRefresh)throw new Error('BOT_SERVICES_NOT_READY');return tasks.botRuntimeEpochRefresh(...args);},
    runRegisteredBotLifecycleAction:(input,guard)=>{assertCurrent();if(!tasks.botLifecycle)throw new Error('BOT_SERVICES_NOT_READY');return tasks.botLifecycle.run(input,guard);},
    listBotSettingsCapabilities:bots.capabilities.forSettings,validateBotCapabilityAdditions:bots.capabilities.validateAdditions,
  });
  let observation:ReturnType<typeof createBotAutonomyService>|undefined;
  return {owner,assertCurrent,current,database,conversations,ipcMain,assertTrustedAppRendererEvent,
    todos,projects,aliases,authority,autonomy,bridge,management,
    connectObservation(routines:TerminalCompanionRoutines,transport?:CompanionObservationTransport){
      assertCurrent();observation?.dispose();
      observation=createBotAutonomyService({...data,...autonomy,...settings,...bridge,...conversations.broadcastTap,
        ownerScopedUserDataPath,log:host.options.logger,getAgentIslandService:()=>tasks.sessionActivity.service,
        getAppCapabilities:()=>({canUseDeviceLink:transport?.enabled()===true}),
        onRoutineEngineLifecycle:listener=>routines.runtime.onRoutineEngineLifecycle(listener),
        listDevices:()=>{if(!transport)throw new Error('DEVICE_LINK_UNAVAILABLE');return transport.listDevices();},
        remoteBackgroundInvoke:(...args)=>{if(!transport)throw new Error('DEVICE_LINK_UNAVAILABLE');return transport.remoteBackgroundInvoke(...args);},
        mayServeBackgroundRead:version=>transport?.mayServeBackgroundRead(version)===true,
        setBotAutonomyBotsChangedListener:listener=>{rosterChanged=listener;},
        remindOwner:(row,id)=>{if(transport)transport.remindOwner(row,id);else publish('terminal:notification',{sessionId:row.sessionId,title:row.title,kind:'needs-reply',detail:row.pendingQuestion,eventId:`bot-autonomy:${id}`});},
        broadcastLocal:publish,
      });
      observation.initBotAutonomy();
    },
    registerResources(registry:RemoteResourceRegistry,routines?:TerminalCompanionRoutines){
      assertCurrent();
      createBotRemoteResourceProvider({...bots.profiles,...conversations.broadcastTap,...conversations.botInvalidation,...working,...todos,
        getDbClient,getAgentIslandService:()=>tasks.sessionActivity.service,remoteResourceRegistry:registry,
        routineTools:{todoCheckEnabled:id=>{if(!routines)throw new Error('ROUTINES_NOT_READY');return routines.service.todoCheckEnabled(id);},setTodoCheck:(id,value)=>{if(!routines)throw new Error('ROUTINES_NOT_READY');return routines.service.setTodoCheck(id,value);}},getBotRemoteMessageService:()=>tasks.botDirectMessages??null,
      }).registerBotRemoteResourceProvider(management);
    },
    close(){observation?.dispose();detachHelper();offRoster();closed=true;},
  };
}
