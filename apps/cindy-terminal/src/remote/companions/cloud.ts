import path from 'node:path';
import { createCompanionHomeRegistry } from '@cindy/companion-core/homes';
import { activeCompanionCloud, type CompanionCloudHost } from '@cindy/companion-core/runtime';
import { companionCloudView } from '@cindy/companion-core/view';
import type { DeviceLinkDeviceView } from '@cindy/companion-core/device';
import { createCompanionCloudLocalRuntime } from '@cindy/app-runtime/companionCloudHost';
import { createBotCanonicalSessionRegistry } from '@cindy/app-runtime/botCanonicalSessionRegistry';
import { createChatServerRuntime } from '@cindy/app-runtime/chatServer';
import { createChatMediaRuntime } from '@cindy/app-runtime/chatServerMedia';
import { createChatReplyImages } from '@cindy/app-runtime/chatServerReplyImages';
import { createChatReplyFiles } from '@cindy/app-runtime/chatServerReplyFiles';
import { createChatServerWorkspaces } from '@cindy/app-runtime/chatServerWorkspaces';
import { createChatMigrationReceipts } from '@cindy/app-runtime/chatMigrationReceipts';
import { createBotGroupTaskPostSnapshot } from '@cindy/app-runtime/botGroupTaskPostSnapshot';
import { companionMergeIds, companionMergeResult, companionFailureCode, companionSwitchOptions } from '@cindy/app-runtime/companionCloudControl';
import { validateAvatarUploadAsync } from '@cindy/app-runtime/profileEdit';
import { createPublicAssetUpload } from '@cindy/app-runtime/ossPublicUpload';
import { createRuntimeTranslator } from '@cindy/maker-shared/runtime-i18n';
import { mainLocaleResources } from '../../../../desktop/src/shared/mainLocaleResources.js';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import { GroupToolAuthorizationError } from '@cindy/app-runtime/botGroupToolAuthorization';
import {
  COMPANION_CLOUD_CAPS_CHANNEL, COMPANION_CLOUD_VERSION, COMPANION_CLOUD_RECEIVE_VERSION,
  COMPANION_CLOUD_TARGETS_CHANNEL, COMPANION_CLOUD_HAND_OVER_CHANNEL, COMPANION_CLOUD_MERGE_CHANNEL,
  COMPANION_CLOUD_FLUSH_CHANNEL, companionCloudCapsVersion, parseCompanionCloudRemoteTargets,
  parseCompanionCloudRemoteActionResult, type RemoteResourceRegistry,
} from '@cindy/device-link';
import type { Logger } from '@cindy/maker-core';
import type { TerminalCompanionHost } from './host.js';
import type { TerminalCompanionRoutines } from './routines.js';

/** Platform binding only. The original Chat Server owns polling, claims,
 * direct-room delivery, account fences and cloud-home synchronization. */
export class TerminalCompanionCloud {
  readonly homes=createCompanionHomeRegistry();
  private closed=false;
  private unsubscribe?:()=>void;
  private groupService?:import('@cindy/app-runtime/botGroupChatService').BotGroupChatService;
  constructor(readonly options:{
    host:TerminalCompanionHost;routines:TerminalCompanionRoutines;userDataPath:string;
    endpoint(name:'chatApiBaseUrl'|'ossApiBaseUrl'):string;getToken():string|null;refresh():Promise<boolean>;
    remoteControlEnabled():boolean;guard():void;logger:Logger;deviceId:string;locale():import('@cindy/maker-shared/runtime-i18n').RuntimeLocale;
    listDevices():Promise<DeviceLinkDeviceView[]>;remoteInvoke(device:string,channel:string,args:unknown[]):Promise<unknown>;
    fetch?:typeof fetch;emit(channel:string,args:unknown[]):void;
  }){}
  private guard(){if(this.closed)throw new Error('COMPANION_CLOUD_CLOSED');this.options.guard();}
  private async peerVersion(deviceId:string){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return companionCloudCapsVersion(await Promise.race([
      this.options.remoteInvoke(deviceId,COMPANION_CLOUD_CAPS_CHANNEL,[]),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('INVOKE_TIMEOUT')),5000);}),
    ]));}catch{return 0;}finally{clearTimeout(timer);}
  }
  async open(resources:RemoteResourceRegistry,trashItem:(file:string)=>Promise<void>,notifications?:import('@cindy/app-runtime/botGroupStepNotification').BotGroupStepNotificationDelivery){
    const {host,routines}=this.options,tasks=host.options.tasks;
    await host.ready;this.guard();
    const database=await tasks.database,conversations=await tasks.conversations,media=await tasks.media.persisted();
    if(!tasks.bots)throw new Error('BOT_SERVICES_NOT_READY');
    const bots=tasks.bots;
    const getDbClient=()=>{this.guard();return database.getDbClient();};
    const ownerRoot=(...parts:string[])=>{this.guard();return path.join(host.options.profileDir,...parts);};
    const canonical=createBotCanonicalSessionRegistry(getDbClient);
    const local=createCompanionCloudLocalRuntime({
      ...bots.profiles,...bots.skills,...host.workbench,...routines.transfer,...canonical,
      getDbClient,activeOwnerScopeKey:()=>{this.guard();return conversations.broadcastTap.captureDataOwnerBroadcastScope().ownerScopeKey!;},
      ownerScopedUserDataPath:ownerRoot,userDataPath:()=>this.options.userDataPath,getBotMemoryService:()=>bots.memory,
      createMessage:conversations.messages.createMessage,commitChatImageUrls:media.commitChatImageUrls,
      onBotRemoteResourceChanged:listener=>host.onChange(listener),companionTodoStore:id=>host.todos(id),companionHomes:this.homes,
    });
    const isTurnActive=(id:string)=>tasks.isTurnRunning(id)||tasks.notificationHasActiveWork(id);
    const ensureCanonical=async(botId:string)=>{
      const result=await tasks.botDelegations!.ensureCanonicalSession(botId);
      if(!result.ok)throw new Error(result.errorCode);return result.sessionId;
    };
    const invoke=this.options.remoteInvoke;
    const cloud:CompanionCloudHost=local.createCompanionCloudHost({
      log:this.options.logger,ensureCanonicalSession:ensureCanonical,isTurnActive,
      rebuildContext:async id=>{if(isTurnActive(id))return 'busy';await tasks.restartOriginalBotRuntime(id,()=>this.guard());return 'rebuilt';},
      stopTurn:async id=>{await tasks.invoke('maker:abort-session',[id],{source:'local'});},
      listDevices:this.options.listDevices,selfDeviceId:()=>this.options.deviceId,
      probeCompanionCloud:async device=>(await this.peerVersion(device))>=COMPANION_CLOUD_RECEIVE_VERSION,
      homeLink:{
        version:device=>this.peerVersion(device),
        targets:async device=>parseCompanionCloudRemoteTargets(await invoke(device,COMPANION_CLOUD_TARGETS_CHANNEL,[])),
        handOver:async(device,botId,target,options)=>{
          const result=parseCompanionCloudRemoteActionResult(await invoke(device,COMPANION_CLOUD_HAND_OVER_CHANNEL,options?.whenBusy?[botId,target,{whenBusy:options.whenBusy}]:[botId,target]));
          return result.ok?result:{...result,code:companionFailureCode(result.code)};
        },
        merge:async(device,keep,from)=>companionMergeResult(await invoke(device,COMPANION_CLOUD_MERGE_CHANNEL,[keep,from])),
        flush:async(device,botId)=>{const result=parseCompanionCloudRemoteActionResult(await invoke(device,COMPANION_CLOUD_FLUSH_CHANNEL,[botId]));return result.ok?result:{...result,code:companionFailureCode(result.code)};},
      },
      deliverToCanonical:async(botId,text,clientId)=>{
        this.guard();if(!this.options.remoteControlEnabled())return {ok:false,errorCode:'REMOTE_CONTROL_DISABLED'};
        if(!tasks.botDelegations)return {ok:false,errorCode:'DELEGATION_UNAVAILABLE'};
        const result=await tasks.botDelegations.ensureCanonicalSession(botId);if(!result.ok)return {ok:false,errorCode:result.errorCode};
        const sent=await tasks.dispatchBotMessage({targetSessionId:result.sessionId,message:text,clientId,resumeWithStoredPermissionMode:true});
        return sent.ok?{ok:true}:{ok:false,errorCode:sent.errorCode};
      },
    });
    const fetch=this.options.fetch??globalThis.fetch;
    const {t}=createRuntimeTranslator(mainLocaleResources,this.options.locale);
    const chatMedia=createChatMediaRuntime({fetch,getDbClient,ownerScopedUserDataPath:ownerRoot,...media});
    const replyImages=createChatReplyImages({getDbClient,...media,...media.blobStore,...media.ledger});
    const replyFiles=createChatReplyFiles({getCurrentDbClientSnapshot:()=>{this.guard();return database.getCurrentDbClientSnapshot();}});
    const snapshots=createBotGroupTaskPostSnapshot(getDbClient);
    await tasks.connectOriginalGroupServices({resources,trashItem,notifications,companionCloud:cloud,
      withChatServer:(service,deps,readPersistedReplyText)=>createChatServerRuntime({
        getDbClient,userDataPath:()=>this.options.userDataPath,isPackaged:()=>process.env.XDT_ISOLATED!=='1',
        getClientEndpoint:this.options.endpoint,t,fetch,getAccessToken:this.options.getToken,refresh:this.options.refresh,
        readMedia:media.blobStore.readFile,...chatMedia,...replyImages,...replyFiles,...snapshots,
        chatServerWorkspaces:createChatServerWorkspaces(ownerRoot),chatMigrationReceipts:createChatMigrationReceipts(ownerRoot),
        readPersistedReplyText,registerGroupToolAuthority:bots.groups.registerGroupToolAuthority,
        GroupToolAuthorizationError:class extends GroupToolAuthorizationError{constructor(temporary=false){super(temporary,t(temporary?'groupTools.verificationUnavailable':'groupTools.authorizationRequired'));}},
        // No diagnostic body is requested by this caller; upload errors remain typed results.
        uploadPublicAsset:createPublicAssetUpload(()=> 'Public asset upload failed'),
        validateAvatar:avatar=>validateAvatarUploadAsync(avatar,async({buffer})=>{
          const {default:sharp}=await import('sharp');
          const decoded=await sharp(buffer,{limitInputPixels:512*512,failOn:'error'}).raw().toBuffer({resolveWithObject:true});
          return {width:decoded.info.width,height:decoded.info.height};
        }),
      }).withChatServer(service,deps),
    });
    this.groupService=tasks.botGroupChat;
    this.unsubscribe=this.homes.onChange(snapshot=>{
      void companionCloudView(snapshot,this.options.listDevices).then(view=>{
        this.guard();if(this.homes.snapshot()===snapshot)this.options.emit('maker:companion-cloud:changed',[view]);
      }).catch(()=>{});
    });
  }
  async assertMayRun(id:string){this.guard();if(this.homes.isShadowed(id))throw new Error('COMPANION_NOT_HOME');}
  async invoke(channel:string,args:unknown[]){
    this.guard();
    if(channel===COMPANION_CLOUD_CAPS_CHANNEL)return {companionCloud:COMPANION_CLOUD_VERSION};
    if(channel==='maker:companion-cloud:state')return companionCloudView(this.homes.snapshot(),this.options.listDevices);
    const runtime=activeCompanionCloud(),notEnabled={ok:false,code:'NOT_ENABLED'};
    const botId=()=>{const id=args[0];if(typeof id!=='string'||!id.trim()||id.length>200)throwIpcError('INVALID_PARAMS','botId required');return id;};
    switch(channel){
      case 'maker:companion-cloud:targets':return runtime?.transferTargets()??[];
      case 'maker:companion-cloud:home-choices':return runtime?.homeChoices(botId())??{homeDeviceId:null,mode:'unavailable',reason:'NOT_ENABLED',targets:[]};
      case 'maker:companion-cloud:transcript':{
        const id=botId(),before=args[1];
        if(before!==undefined&&before!==null&&(typeof before!=='string'||!/^[1-9][0-9]{0,18}$/.test(before)))throwIpcError('INVALID_PARAMS','Invalid cursor');
        if(!runtime)throwIpcError('PRECONDITION_FAILED','Cloud companions are not available');
        try{return await runtime.transcript(id,typeof before==='string'?before:undefined);}
        catch{throwIpcError('PRECONDITION_FAILED','Companion conversation is not available');}
      }
      case 'maker:companion-cloud:attachment':{
        const id=botId(),mediaId=args[1];
        if(typeof mediaId!=='string'||!/^[0-9a-f-]{1,64}$/i.test(mediaId))throwIpcError('INVALID_PARAMS','Invalid media id');
        if(!runtime)throwIpcError('PRECONDITION_FAILED','Cloud companions are not available');
        try{return await runtime.attachment(id,mediaId);}
        catch{throwIpcError('PRECONDITION_FAILED','Companion attachment is not available');}
      }
      case 'maker:companion-cloud:take-over':return runtime?.takeOver(botId())??notEnabled;
      case 'maker:companion-cloud:switch-home':case 'maker:companion-cloud:hand-over':{
        const id=botId(),target=args[1];if(typeof target!=='string'||!target||target.length>200)throwIpcError('INVALID_PARAMS','targetDeviceId required');
        return (channel.endsWith('hand-over')?runtime?.transfer(id,target,companionSwitchOptions(args[2])):runtime?.switchHome(id,target,companionSwitchOptions(args[2])))??notEnabled;
      }
      case 'maker:companion-cloud:cindy-copies':return runtime?.cindyCopies()??[];
      case 'maker:companion-cloud:merge-cindy':case 'maker:companion-cloud:merge':{
        const {keep,from}=companionMergeIds(args[0],args[1]);
        return (channel.endsWith('merge-cindy')?runtime?.mergeCindy(keep,from):runtime?.mergeCindyHere(keep,from))??notEnabled;
      }
      case 'maker:companion-cloud:flush':return runtime?.flushHere(botId())??notEnabled;
      default:throw new Error('COMPANION_CLOUD_CHANNEL_UNAVAILABLE');
    }
  }
  async retire(id:string){this.guard();await activeCompanionCloud()?.retire(id);}
  async close(){if(this.closed)return;this.closed=true;this.unsubscribe?.();this.groupService?.dispose();this.groupService=undefined;}
}
