import path from 'node:path';
import { TencentIlinkTransport } from '@cindy/wechat-ilink';
import { WechatIM, WECHAT_AUTH_BASE_URL } from '@cindy/app-runtime/wechat/WechatIM';
import { createWechatMediaStaging } from '@cindy/app-runtime/wechat/mediaStaging';
import { createWechatSilkDecoder } from '@cindy/app-runtime/wechat/silkDecoder';
import { createWechatAdapterFactory } from '@cindy/app-runtime/wechat/adapter';
import { createWechatChannelSettings } from '@cindy/app-runtime/wechatChannelSettings';
import { WechatCompatibilityPolicyService, WECHAT_COMPATIBILITY_POLICY_PRODUCTION_CONFIG } from '@cindy/app-runtime/wechat/compatibilityPolicy';
import { IM_DEFAULT_SETTINGS, IM_DEFAULT_EFFORT_OVERRIDES } from '@cindy/im-runtime/imDefaultSettings';
import type { createTerminalCompanionIm } from './companions.js';
import type { TerminalTaskHost } from '../tasks/host.js';
import type { TerminalImTransportHost } from './transport-host.js';
import type { Logger } from '@cindy/maker-core';
import { VERSION, RUNTIME_DIRECTORY } from '../version.js';

export async function createTerminalWechat(options:{
  tasks:TerminalTaskHost;transport:TerminalImTransportHost;root:string;logger:Logger;
  guard():void;emit(channel:string,payload:unknown):void;
}) {
  const {tasks,transport}=options, database=await tasks.database, persisted=await tasks.media.persisted();
  options.guard();
  const ownerScopedImUserDataPath=(...parts:string[])=>{options.guard();return path.join(options.root,...parts);};
  const settings=createWechatChannelSettings({ownerScopedImUserDataPath,log:options.logger,maskPath:()=>'<owner-data>'});
  const media=createWechatMediaStaging({...persisted,ownerScopedImUserDataPath,
    ...createWechatSilkDecoder(()=>path.join(RUNTIME_DIRECTORY,'wechat-silk-worker.cjs')),
  });
  const policy=new WechatCompatibilityPolicyService({...WECHAT_COMPATIBILITY_POLICY_PRODUCTION_CONFIG,
    cachePath:()=>ownerScopedImUserDataPath('controlled-config','wechat-compatibility-policy.v1.json'),appVersion:()=>VERSION,fetch,
  },{log:options.logger,maskPath:()=>'<owner-data>'});
  const account=tasks.channelControl.account;
  let authorizationUrl:string|undefined, closed=false;
  const guard=()=>{options.guard();if(closed)throw new Error('IM_ACCOUNT_SCOPE_CLOSED');};
  const im=new WechatIM({host:transport.host,media,getDbClient:()=>{guard();return database.getDbClient();},
    captureAccountGeneration:()=>{guard();return account.captureImAccountGeneration();},
    isAccountGenerationCurrent:generation=>!closed&&account.isImAccountGenerationCurrent(generation),
    isCompatibilityDisabled:()=>policy.isDisabled(),
    createTransport:({credentials,onAuthorizationEvent})=>new TencentIlinkTransport({
      baseUrl:credentials?.baseUrl??WECHAT_AUTH_BASE_URL,
      ...(credentials?{token:credentials.botToken,appId:credentials.ilinkBotId}:{}),botAgent:`Cindy/${VERSION}`,fetch,
      ...(onAuthorizationEvent?{authorizationObserver:{onEvent:onAuthorizationEvent}}:{}),
    }),
    openAuthorizationUrl:async url=>{guard();authorizationUrl=url;options.emit('terminal:im-authorization',{channel:'wechat'});},
  });
  const offPolicy=policy.subscribe(decision=>{void im.setCompatibilityDisabled(decision.disabled).catch(()=>options.logger.warn('Personal WeChat policy application failed'));});
  const offStatus=im.onStatusChange(()=>{
    const phase=im.getState().phase;
    if(phase!=='waiting_confirmation'&&phase!=='authorizing')authorizationUrl=undefined;
    options.emit('maker:remote-resources:changed',{collectionId:'channels'});
  });
  let companions:Awaited<ReturnType<typeof createTerminalCompanionIm>>|undefined;
  const ipc=transport.host.ipc;
  ipc.handle('wechatBot:get-state',()=>im.getState());
  ipc.handle('wechatBot:authorize',()=>{guard();return im.authorize();});
  ipc.handle('wechatBot:cancel-authorization',()=>{guard();im.cancelAuthorization();authorizationUrl=undefined;return {ok:true};});
  ipc.handle('wechatBot:unbind',async()=>{guard();await im.unbind();guard();return {ok:true};});
  ipc.handle('wechatBot:get-channel-settings',()=>{guard();return settings.readWechatChannelSettings();});
  ipc.handle('wechatBot:set-companion',async botId=>{
    guard();if(botId!==null&&(typeof botId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(botId)))throw new Error('INVALID_ARGUMENT');
    if(!companions)throw new Error('BOT_SERVICES_NOT_READY');
    await companions.setWechatCompanionBinding(botId as string|null,commit=>im.updateCompanionBinding(()=>{guard();commit();}));
    guard();const next=settings.readWechatChannelSettings();ipc.broadcast('wechatBot:channel-settings-changed',next);return next;
  });
  ipc.handle('wechatBot:reset-working-directory',()=>{guard();const next=settings.resetWechatWorkingDir();ipc.broadcast('wechatBot:channel-settings-changed',next);return next;});
  ipc.handle('terminal:wechat:set-working-directory',dir=>{
    guard();if(typeof dir!=='string'||!path.isAbsolute(dir))throw new Error('INVALID_WORKING_DIRECTORY');
    const next=settings.writeWechatWorkingDir(dir);ipc.broadcast('wechatBot:channel-settings-changed',next);return next;
  });
  return {im,settings,
    authorization:()=>{guard();return authorizationUrl;},
    removeCompanionBinding:(update:()=>void,isCurrent:()=>boolean)=>im.updateCompanionBinding(()=>{guard();update();},{cancelPendingIf:()=>{guard();return isCurrent();}}),
    connect(runtime:Awaited<ReturnType<typeof createTerminalCompanionIm>>){
      guard();companions=runtime;
      const config={agentKind:IM_DEFAULT_SETTINGS.agentKind,defaultModel:IM_DEFAULT_SETTINGS.agents[IM_DEFAULT_SETTINGS.agentKind].model,
        defaultPermissionMode:IM_DEFAULT_SETTINGS.permissionMode,effortOverrides:IM_DEFAULT_EFFORT_OVERRIDES};
      const {buildWechatAdapter}=createWechatAdapterFactory(settings.resolveWechatWorkingDir);
      const orchestrator=tasks.channelOrchestrators.attach(buildWechatAdapter(im,config),{
        companion:runtime.routes.createImCompanionRouteDeps(()=>settings.readWechatChannelSettings().companionBotId??null),
      });
      im.attachTurnRuntime({runner:orchestrator.runner,repo:orchestrator.repo,config,
        resetSessionToDefaults:(id,next,prepared)=>tasks.resetChannelTask(id,next,prepared,'wechat')});
    },
    async start(){guard();policy.start();await im.init();guard();},
    async close(){if(closed)return;closed=true;offPolicy();offStatus();authorizationUrl=undefined;policy.stop();await transport.disposeConnection(()=>im.dispose());},
  };
}
