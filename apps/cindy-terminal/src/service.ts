import { RUNTIME_DIRECTORY, terminalNodeExecutable } from './version.js';
import type { TerminalHostCommand } from './host-command.js';
import type { DirectRuntime } from '@cindy/device-link';
import type { TerminalFilePeerOptions } from './remote/files.js';
import {TerminalRemoteError} from './remote/types.js';
import type { CreateTerminalDesktopPlatform, TerminalDesktopPlatform } from './desktop-platform.js';
import { REMOTE_DESKTOP_CHANNEL, resolveDesktopIceServers, REMOTE_DESKTOP_ICE_CONFIG_PATH } from '@cindy/device-link';
import {createDialogueWorkspaceSettings} from '@cindy/app-runtime/dialogueWorkspaceSettings';
import { registerWorktreeResources } from './worktrees/resources.js';
import { createTerminalWorktrees } from './worktrees/host.js';
import { TerminalLocalModels } from './local-models/service.js';
import { TerminalClaudeAuthorization } from './models/claude-terminal.js';
import { TerminalClaudeLogin } from './models/claude-login.js';
import { TerminalSubscriptions } from './models/subscriptions.js';
import { TerminalProviderLogin } from './models/login.js';
import { TerminalPluginTasks } from './plugins/tasks.js';
import { TerminalGateway } from './models/gateway.js';
import { TerminalImConnections } from './im/connections.js';
import { registerImResources } from './im/resources.js';
import { TerminalPluginMarket } from './plugins/market.js';
import { TerminalPluginAccount } from './plugins/account.js';
import { fileURLToPath } from 'node:url';
import { TerminalBrowserRuntime } from './plugins/browser.js';
import { TerminalPlugins } from './plugins/host.js';
import { registerPluginResources } from './plugins/resources.js';
import { parsePluginSecretForm } from './plugins/secret-form.js';
import { registerLibraryResources } from './plugins/library-resources.js';
import { DirDepositVault, SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import { fetchSingleHopWithSsrFGuard } from '@cindy/browser-control-runtime/ssrf-runtime';
import { TerminalCompanionRoutines } from './remote/companions/routines.js';
import { TerminalProtectedInput } from './protected-input.js';
import { TerminalConfiguration, configurationOperation } from './configuration.js';
import { registerModelConfigurationResources } from './models/resources.js';
import { INPUT_HANDOFF_LOCAL_CHANNEL, INPUT_HANDOFF_REMOTE_LOCAL_CHANNEL, PLUGIN_OAUTH_CHANNEL } from '@cindy/device-link';
import { TerminalCompanionCloud } from './remote/companions/cloud.js';
import { TerminalCompanionHost } from './remote/companions/host.js';
import { registerCompanionResources } from './remote/companions/resources.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import wrtc from '@roamhq/wrtc';
import { TerminalAuthController, type AuthRegion, type TerminalAuthSnapshot } from '@cindy/auth-client';
import { createNodeDirectRtcRuntime, FILE_PEER_CHANNEL, REMOTE_AGENT_CHANNEL, PROVIDER_GROUP_REMOTE_CHANNEL, providerShareHostPeer, parseProviderSharePeer, parseSharedTaskPeer, PROVIDER_SHARE_RELAY_CAPABILITY, SHARED_TASK_RELAY_CAPABILITY } from '@cindy/device-link';
import { setClaudeRateLimitInfoListener } from '@cindy/maker-core';
import { logger } from './logger.js';
import { TerminalDeviceManagement } from './remote/management.js';
import globalEndpoints from '../../../config/endpoint.global.json';
import chinaEndpoints from '../../../config/endpoint.json';
import { TerminalSecretStore } from './secrets.js';
import { TerminalTransportServer } from './transport.js';
import { TerminalTaskHost, TerminalSchedulerHost } from './tasks/index.js';
import { TerminalDeviceService, TerminalFilePeerService } from './remote/index.js';
import { TerminalFileBrowser } from './file-browser.js';
import { TerminalMediaTransfer } from './media-transfer.js';
import { fetchMedia } from './media-fetch.js';
import { downloadRemoteFile } from './file-transfers.js';
import { TerminalResources } from './resources.js';
import { TerminalKnowledge } from './knowledge.js';
import { TerminalProjects } from './projects.js';
import { registerKnowledgeResources } from './knowledge-resources.js';
import { SettingsStore } from './settings.js';
import { TerminalServiceManager } from './service-manager.js';
import { VERSION } from './platform.js';
import { EngineManager } from './engines/manager.js';
import { TerminalEngineResources } from './engines/resources.js';
import { RemoteTerminalHost, REMOTE_TERMINAL_CHANNEL } from '@cindy/terminal-core';
import type { EngineKind } from './engines/types.js';
import { TerminalSshService } from './ssh.js';
import { TerminalRemoteAgentService } from './remote/agent.js';
import { TerminalRemoteAccountService } from './remote/account.js';
import { TerminalMembershipService } from './remote/membership.js';
import { TerminalSharedTasks } from './remote/shared-tasks.js';
import { TerminalProviderGroups } from './remote/groups.js';
import { TerminalGuestRoutes } from './remote/guest-routes.js';
import { TerminalRemoteModelGrants } from './remote/model-grants.js';
import { TerminalCrossRegionShares } from './remote/cross-region.js';
import { registerShareResources } from './remote/share-resources.js';
import { TerminalReshares } from './remote/reshare.js';
import { createProviderGroupGuestRelay } from '@cindy/remote-agent/groups/guestRelay';
import { createProviderGroupReshare, type ProviderGroupReshare } from '@cindy/remote-agent/groups/reshare';
import { readTurnUsageResetAt } from '@cindy/remote-agent/groups/usageLimit';
import { createGuestProviderRouteBinder, guestProviderModelIds, resolveGuestProviderId } from '@cindy/remote-agent/host/providerAccess';
import { registerRemoteManagementResources } from './remote/resources.js';
import { readDeviceProviderViews, remoteAgentPollerFor, RemoteAgentRunClient } from '@cindy/remote-agent';
import type { InvocationContext } from './contracts.js';
import { silentStopMessage, runtimeRecoveryMessage } from './ui/i18n.js';
import { openNodeDatabase, type NodeDatabase } from './database.js';
import { createRuntimeTranslator } from '@cindy/maker-shared/runtime-i18n';
import { createSessionNotificationCopy } from '@cindy/app-runtime/sessionNotificationCopy';
import { createTerminalTaskNotifications } from './tasks/notifications.js';
import { mainLocaleResources } from '../../desktop/src/shared/mainLocaleResources.js';

function valueString(value: unknown): string { if (typeof value !== 'string') throw new Error('INVALID_ARGUMENT'); return value; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT'); return value as Record<string,unknown>; }

export class TerminalService {
  readonly settings: SettingsStore;
  readonly secrets: TerminalSecretStore;
  readonly transport: TerminalTransportServer;
  readonly manager: TerminalServiceManager;
  private auth!: TerminalAuthController;
  private remote!: TerminalDeviceService;
  private deviceManagement!: TerminalDeviceManagement;
  private files!: TerminalFilePeerService;
  private browser!: TerminalFileBrowser;
  private media!: TerminalMediaTransfer;
  private resources!: TerminalResources;
  private engineResources?: TerminalEngineResources;
  private localModels?: TerminalLocalModels;
  private knowledge?: TerminalKnowledge;
  private plugins?:TerminalPlugins;
  private pluginTasks?:TerminalPluginTasks;
  private pluginMarket?:TerminalPluginMarket;
  private pluginAccount?:TerminalPluginAccount;
  private pluginAuthorizations=new Map<string,{url:string;userCode?:string;expiresAt:number}>();
  private readonly pluginBrowser:TerminalBrowserRuntime;
  private projects?: TerminalProjects;
  private tasks!: TerminalTaskHost;
  private database?: NodeDatabase;
  private im?: TerminalImConnections;
  private protectedInput?: TerminalProtectedInput;
  private desktop?: TerminalDesktopPlatform;
  private configuration?: TerminalConfiguration;
  private scheduler!: TerminalSchedulerHost;
  private agents!: TerminalRemoteAgentService;
  private account!: TerminalRemoteAccountService;
  private gateway?: TerminalGateway;
  private providerLogin?: TerminalProviderLogin;
  private membership!: TerminalMembershipService;
  private sharedTasks!: TerminalSharedTasks;
  private taskNotifications?: Awaited<ReturnType<typeof createTerminalTaskNotifications>>;
  private groups!: TerminalProviderGroups;
  private guestRoutes!: TerminalGuestRoutes;
  private modelGrants!: TerminalRemoteModelGrants;
  private crossShares!: TerminalCrossRegionShares;
  private reshares!: TerminalReshares;
  private groupReshare?:ProviderGroupReshare;
  private companions?: TerminalCompanionHost;
  private routines?: TerminalCompanionRoutines;
  private companionCloud?: TerminalCompanionCloud;
  private ssh!: TerminalSshService;
  private readonly engines: EngineManager;
  private readonly terminals = new RemoteTerminalHost({ getScope:()=>this.ownerSuspended?null:`${this.ownerKey}:${this.ownerGeneration}`, logger });
  private startedAt = Date.now();
  private ownerGeneration = 0;
  private ownerKey = 'guest';
  private ownerChange: Promise<void> = Promise.resolve();
  private ownerSuspended = false;
  private ownerActivation?: Promise<void>;
  private subscriptions = new Map<string, () => void>();
  private authorization: { url: string; expiresAt: number } | null = null;
  private init: Promise<void> = Promise.resolve();
  private refreshTimer?: NodeJS.Timeout;
  private stopWait: () => void = () => {};
  readonly stopped = new Promise<void>(resolve => { this.stopWait = resolve; });
  private closing?: Promise<void>;

  constructor(readonly profileDir: string, readonly region: AuthRegion = 'global', private readonly runtimePaths: { worktreeAppDataRoot?: string; createDesktopPlatform?: CreateTerminalDesktopPlatform; directRuntime?: DirectRuntime; createFilePeerRuntime?: TerminalFilePeerOptions['createRuntime']; desktopHost?: TerminalHostCommand } = {}) {
    this.pluginBrowser=new TerminalBrowserRuntime({root:path.join(profileDir,'browser-runtime'),changed:status=>this.transport?.publish('terminal:browser:status',[status])});
    this.settings = new SettingsStore(profileDir);
    this.secrets = new TerminalSecretStore(profileDir);
    this.engines = new EngineManager({ profileDir, onProgress: progress => this.transport?.publish('terminal:engines:progress', [progress]) });
    this.manager = new TerminalServiceManager(profileDir,path.join(RUNTIME_DIRECTORY,'cli.js'),terminalNodeExecutable(),{desktopHost:runtimePaths.desktopHost});
    this.transport = new TerminalTransportServer(profileDir, async (channel,args,deviceId) => {
      await this.init;
      if (deviceId) {
        if (channel.startsWith('terminal:')&&channel!==REMOTE_TERMINAL_CHANNEL) throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
        return this.remote.invoke(deviceId,channel,args);
      }
      return this.invoke(channel,args,{source:'local'});
    });
  }

  async start(): Promise<void> {
    // Bind before opening mutable stores. A second process never reaches them.
    // Install the readiness barrier before listen publishes service.json.
    // A fast client can authenticate while listen is still releasing its lock.
    this.init = (async()=>{
      await this.transport.listen();
      try { await this.initialize(); } catch (error) { await this.close().catch(()=>logger.warn('SERVICE_START_CLEANUP_FAILED'));throw error; }
    })();
    await this.init;
    setClaudeRateLimitInfoListener(info => {
      if (!this.ownerSuspended && !this.closing) void this.tasks.usage.accounts.onClaudeRateLimitInfo(info)
        .catch(() => logger.warn('CLAUDE_USAGE_EVENT_FAILED'));
    });
  }
  private async initialize() {
    await this.settings.open(); await this.secrets.open();
    this.auth = new TerminalAuthController({
      deviceId:this.settings.deviceId, region:this.region, locale:this.settings.snapshot().effective.language, fetch,
      endpoints:{global:{baseUrl:globalEndpoints.authApiBaseUrl,hostedCallbackUrl:globalEndpoints.authDesktopCallbackUrl},cn:{baseUrl:chinaEndpoints.authApiBaseUrl,hostedCallbackUrl:chinaEndpoints.authDesktopCallbackUrl}},
      secretStore:{
        load:async()=>{const value=await this.secrets.get('cindy-auth');return value ? JSON.parse(value) : null;},
        save:vault=>this.secrets.set('cindy-auth',JSON.stringify(vault)),
      },
      onAuthorizeUrl:request=>{
        this.authorization={url:request.url,expiresAt:request.expiresAt};
        this.transport.publish('terminal:auth:url',[this.authorization]);
        request.signal.addEventListener('abort',()=>{if(this.authorization?.url===request.url)this.authorization=null;},{once:true});
      },
      beforeAccountChange:async()=>{
        this.ownerSuspended = true;
        this.ownerGeneration++;
        await this.closeOwnerServices(true);
      },
      onChange:snapshot=>{
        if(snapshot.flow?.step!=='browser-redirect')this.authorization=null;
        this.transport.publish('terminal:auth:changed',[snapshot]);
        this.ownerChange=this.ownerChange.catch(()=>{}).then(()=>this.syncOwner(this.auth.snapshot()));
        void this.ownerChange.catch(()=>logger.error('OWNER_SWITCH_FAILED'));
      },
    });
    this.remote = new TerminalDeviceService({
      getToken:async()=>this.auth.getAccessToken(),
      getHello:()=>({deviceName:this.settings.snapshot().effective.deviceName,platform:process.platform,appVersion:VERSION,remoteControlEnabled:this.settings.snapshot().effective.remoteEnabled,busy:this.tasks?.isBusy() ?? false,capabilities:[PROVIDER_SHARE_RELAY_CAPABILITY,SHARED_TASK_RELAY_CAPABILITY]}),
      controllerCapabilities:[PROVIDER_SHARE_RELAY_CAPABILITY,SHARED_TASK_RELAY_CAPABILITY],hostCapabilities:[PROVIDER_SHARE_RELAY_CAPABILITY,SHARED_TASK_RELAY_CAPABILITY],
      getWsUrl:()=>{
        const endpoints=(this.auth.snapshot().session?.realm ?? this.region)==='cn'?chinaEndpoints:globalEndpoints;
        const url=new URL('/api/device-link/ws',endpoints.deviceLinkApiBaseUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';return url.href;
      },
      getOwnerScope:()=>this.auth.snapshot().session ? `${this.ownerKey}:${this.ownerGeneration}` : null,
      isPeerRevoked: id => this.deviceManagement.isRevoked(id),
      isControlTargetDisabled: id => this.settings.deviceLink.readDeviceLinkSettings().disabledControlDeviceIds.includes(id),
      createWebSocket:(url,headers)=>new WebSocket(url,{headers}),
      directRuntime:this.runtimePaths.directRuntime??createNodeDirectRtcRuntime(wrtc),
      resolveScopedAuthority: source => this.membership.resolve(source),
      invokeLocal:async(channel,args,context)=>{
        context.assertCurrent();
        this.membership.assertRequest(context.source,channel,args);
        if(channel===REMOTE_DESKTOP_CHANNEL){
          if(context.source.kind!=='owner')throw new TerminalRemoteError('OWNER_REQUIRED','Owner access required');
          if(!this.desktop)throw new TerminalRemoteError('DESKTOP_UNAVAILABLE','No graphical desktop platform is running');
          const result=await this.desktop.request(context.sourceDeviceId,args[0]);
          context.assertCurrent();return result;
        }
        if(channel===REMOTE_AGENT_CHANNEL)return this.agents.request(args[0],context);
        if(channel===PROVIDER_GROUP_REMOTE_CHANNEL)return this.groups.request(args[0],context);
        if(channel==='maker:provider:list'){
          const providers=this.membership.projectProviders(context.source,await this.agents.views());
          if(context.source.kind!=='owner')return {providers};
          const owner={dataOwnerId:this.auth.snapshot().session?.membership.id??null,generation:this.ownerGeneration};
          const snapshot=await this.tasks.models.providerListSnapshot(providers,owner);
          const decorated=await this.groups.decorate(snapshot.providers);
          context.assertCurrent();return {...snapshot,...object(decorated)};
        }
        if(channel===FILE_PEER_CHANNEL){if(context.source.kind!=='owner')throw new Error('OWNER_REQUIRED');return this.files.request(args[0],context);}
        if(context.source.kind==='provider-share'){
          const providers=this.membership.projectProviders(context.source,await this.agents.views());
          const kinds=[...new Set(providers.flatMap(provider=>provider.agents))];
          if(channel==='maker:list-available-agents')return kinds;
          if(!kinds.includes(args[0] as never))throw new Error('REMOTE_AGENT_UNAVAILABLE');
        }
        const ownerId=this.ownerKey;
        const sourceDevice=context.source.kind==='owner'&&['maker:send','maker:steer','maker:input:enqueue','maker:input:steer','maker:input:update-text','maker:input:update-content','maker:bot:send'].includes(channel)?await this.remote.sourceDevice(context.sourceDeviceId):undefined;
        return this.invoke(channel,args,{source:'remote',controllerCapabilities:context.controllerCapabilities,deviceId:context.sourceDeviceId,sourceDevice,ownerId,sharedTask:this.membership.taskContext(context.source),sharedTaskCapture:context.source.kind==='shared-task'?await this.sharedTasks.capturePeer(context.source.peerId,context.source.sharedTaskId):undefined,signal:context.signal,assertCurrent:()=>{
          context.assertCurrent();
          if(this.ownerKey!==ownerId || this.ownerSuspended)throw new Error('OWNER_CHANGED');
        }});
      },
      onPush:push=>this.transport.publish('terminal:remote-event',[push]),
      onLocalPush: (channel, payload) => this.transport.publish(channel, [payload]),
      readSharedTaskForProbe: id => this.account.sharedTasks.get(id),
      notificationBody: kind => createSessionNotificationCopy(createRuntimeTranslator(mainLocaleResources, () => this.settings.snapshot().effective.language).t).getSessionNotificationBody(kind),
      replaySessionActivity: emit => this.tasks?.sessionActivity?.service.replaySessionActivity(emit),
      onSubscriptionsClosed: source => {
        if (source.kind === 'owner') void this.tasks?.mcpApps.releaseDevice(source.deviceId)
          .catch(() => logger.warn('MCP_APP_PEER_CLEANUP_FAILED'));
      },
      onPeerClosed: (peer, transient) => transient ? this.desktop?.signalingLost(peer) : this.desktop?.peerClosed(peer),
      logger:{debug(){},info(){},warn(){logger.warn('DEVICE_LINK_WARNING');},error(){logger.error('DEVICE_LINK_ERROR');}},
    });
    this.deviceManagement = new TerminalDeviceManagement({ settings: this.settings, remote: this.remote,
      authenticated: () => !!this.auth.snapshot().session && !this.ownerSuspended && !this.closing,
      ownerScope: () => this.auth.snapshot().session && !this.ownerSuspended ? `${this.ownerKey}:${this.ownerGeneration}` : null,
      emit: (channel, payload) => this.transport.publish(channel, [payload]),
      closePeerResources: peer => { this.desktop?.peerClosed(peer); this.files?.stop(peer); this.browser?.stop(peer); },
    });
    this.desktop=this.runtimePaths.createDesktopPlatform?.({
      settings:this.settings,handoff:()=>this.protectedInput?.handoff,
      authenticated:()=>Boolean(this.auth.snapshot().session)&&!this.ownerSuspended&&!this.closing,
      credentials:async()=>{
        const session=this.auth.snapshot().session,generation=this.ownerGeneration;
        if(!session||this.ownerSuspended||this.closing)return null;
        const token=await this.auth.getAccessToken();
        if(this.ownerGeneration!==generation||this.auth.snapshot().session?.key!==session.key||this.ownerSuspended||this.closing)throw new Error('OWNER_CHANGED');
        return token?{realm:session.realm,membership:session.membership.id,authDevice:this.settings.deviceId,token}:null;
      },
      iceServers:()=>resolveDesktopIceServers(()=>this.remote.requestDevicesApi(REMOTE_DESKTOP_ICE_CONFIG_PATH)),
      controllerName:peer=>this.remote.directoryPresence().get(peer)?.deviceName,
      revoke:async peer=>{await this.deviceManagement.invoke('revoke',[peer]);},
      permissionGuideRequested:()=>this.transport.publish('terminal:desktop:permission-guide',[]),
    });
    this.remote.onStatusChange(status=>{if(status!=='online')this.desktop?.signalingLost();this.transport.publish('terminal:remote-status',[status]);});
    this.remote.onPresenceChanged(device=>{if(!device.online)this.desktop?.peerClosed(device.deviceId);this.transport.publish('terminal:devices:changed',[device]);});
    this.files=new TerminalFilePeerService({
      native:wrtc,
      createRuntime:this.runtimePaths.createFilePeerRuntime,
      getOwnerScope:()=>this.auth.snapshot().session?.status==='authenticated'?`${this.ownerKey}:${this.ownerGeneration}`:null,
      openFile:(url,context)=>this.browser.openMedia(url,context),
      invokeAuthorized:(channel,args,context)=>this.remote.dispatchLocal(channel,args,context),
      invokeRemote:(peer,channel,args)=>this.remote.invoke(peer,channel,args),
      attachment:async(request,context)=>{context.assertCurrent();const result=await this.media.inbox.handlePeerAttachment(context.sourceDeviceId,request);context.assertCurrent();return result;},
    });
    await this.createTasks('guest');
    if(!this.secrets.status().locked)await this.auth.initialize();
    await this.ownerChange;
    await this.activateOwner();
    this.refreshTimer=setInterval(()=>{
      const flow=this.auth.snapshot().flow;
      if(!this.secrets.status().locked && (!flow || flow.step==='completed'))void this.auth.refresh().catch(()=>logger.warn('AUTH_REFRESH_FAILED'));
    },5*60_000);
    this.refreshTimer.unref();
  }

  private async syncOwner(snapshot: TerminalAuthSnapshot) {
    if(this.closing)return;
    const next=snapshot.session?.key ?? 'guest';
    if(next!==this.ownerKey || this.ownerSuspended){
      await this.closeOwnerServices();
      await this.createTasks(next);this.ownerSuspended=false;
    }
    await this.activateOwner();
    if(snapshot.session?.status==='authenticated')this.remote.start();
    else this.remote.stop();
  }
  /** A passphrase-protected installation must expose local unlock before any
   * original runtime resumes work that needs credentials. Bind activation to
   * the constructed owner; concurrent unlock/auth callbacks share one start. */
  private activateOwner(): Promise<void> {
    if(this.closing||this.ownerSuspended||this.secrets.status().locked)return Promise.resolve();
    if(this.ownerActivation)return this.ownerActivation;
    const owner=this.ownerKey,generation=this.ownerGeneration;
    const {tasks,plugins,companions,companionCloud,routines,scheduler,im}=this;
    const current=()=>!this.closing&&!this.ownerSuspended&&owner===this.ownerKey&&generation===this.ownerGeneration;
    const pending=Promise.resolve().then(async()=>{
      if(!current())return;
      await tasks.unlockSecretServices();if(!current())return;
      await plugins!.start();if(!current())return;
      await tasks.resumePending();if(!current())return;
      if(!companionCloud)await companions?.resumePending();if(!current())return;
      await routines?.open();if(!current())return;
      await scheduler.activate();if(!current())return;
      this.startGateway();
      void im?.start().catch(()=>{if(current())logger.warn('IM_CONNECTION_START_FAILED');});
    });
    this.ownerActivation=pending;
    void pending.catch(()=>{if(this.ownerActivation===pending)this.ownerActivation=undefined;});
    return pending;
  }
  private startGateway() {
    const gateway = this.gateway;
    void gateway?.start().catch(() => { if (!this.closing && gateway === this.gateway) logger.warn('MODEL_ACCESS_REFRESH_FAILED'); });
  }
  /** Account authority is already revoked before this runs. Cleanup failures
   * cannot skip later owners' private sockets, native tasks or durable stores. */
  private async closeOwnerServices(logout = false): Promise<void> {
    const errors: unknown[] = [];
    const close = async (operation: () => unknown) => { try { await operation(); } catch (error) { errors.push(error); } };
    await close(()=>this.ownerActivation);this.ownerActivation=undefined;
    await close(() => this.desktop?.reset());
    this.taskNotifications?.close(); this.taskNotifications = undefined;
    await close(() => this.engineResources?.close());
    await close(() => this.localModels?.close());
    await close(() => this.im?.close());
    await close(() => this.gateway?.close());
    await close(() => this.providerLogin?.close());
    await close(() => this.terminals.close()); await close(() => this.remote?.stop());
    if (logout) await this.sharedTasks?.logout().catch(() => logger.warn('SHARED_TASK_CLOSE_PENDING'));
    await close(() => this.files?.stop()); await close(() => this.browser?.stop());
    await close(() => this.resources?.close()); await close(() => this.membership?.close());
    await close(() => this.sharedTasks?.close()); await close(() => this.crossShares?.close());
    await close(() => this.groupReshare?.stop()); await close(() => this.reshares?.close());
    await close(() => this.guestRoutes?.close()); await close(() => this.modelGrants?.close());
    await close(() => this.agents?.stop()); await close(() => this.groups?.close()); await close(() => this.ssh?.close());
    await close(() => this.pluginTasks?.close()); await close(() => this.pluginMarket?.close());
    await close(() => this.pluginAccount?.close()); this.pluginAuthorizations.clear();
    await close(() => this.plugins?.close()); await close(() => this.routines?.close());
    await close(() => this.protectedInput?.close()); await close(() => this.companionCloud?.close());
    await close(() => this.companions?.close()); await close(() => this.scheduler?.close());
    await close(() => this.tasks?.close({ reason: 'account-boundary' })); await close(() => this.knowledge?.close()); await close(() => this.projects?.close());
    for (const dispose of this.subscriptions.values()) await close(dispose);
    this.subscriptions.clear();
    await close(() => this.database?.close());
    this.database = undefined;
    if (errors.length) throw new AggregateError(errors, 'OWNER_CLEANUP_FAILED');
  }
  private async createTasks(owner: string) {
    this.ownerKey=owner;
    const generation=this.ownerGeneration;
    const ownerDir=path.join(this.profileDir,'owners',createHash('sha256').update(owner).digest('hex').slice(0,32));
    const scope=()=>`${this.ownerKey}:${this.ownerGeneration}`;
    const translation = createRuntimeTranslator(mainLocaleResources, () => this.settings.snapshot().effective.language);
    this.database = await openNodeDatabase({
      userDataDirectory: ownerDir,
      ownerId: createHash('sha256').update(owner).digest('hex'),
      appDataRoot: this.runtimePaths.worktreeAppDataRoot,
      runtimeDirectory: RUNTIME_DIRECTORY,
      logger,
      translate: translation.t,
      dialogueWorkspaceRoots: createDialogueWorkspaceSettings({activeOwnerScopeKey:scope,
        ownerScopedUserDataPath:(...parts)=>path.join(ownerDir,...parts),createLogger:()=>logger}).dialogueWorkspaceRoots,
      broadcast: (channel, payload) => {
        if (this.ownerKey !== owner || this.ownerGeneration !== generation || this.closing) return;
        this.transport.publish(channel, [payload]);
        void this.remote?.publish(channel, payload).catch(() => {});
      },
      reportFailure: failure => this.transport.publish('terminal:database:error', [failure]),
    });
    this.media=new TerminalMediaTransfer({ownerDir,getOwnerScope:()=>this.auth.snapshot().session&&!this.ownerSuspended&&this.ownerKey===owner&&this.ownerGeneration===generation?scope():null,
      getToken:async()=>this.auth.getAccessToken(),getApiBaseUrl:()=>((this.auth.snapshot().session?.realm??this.region)==='cn'?chinaEndpoints:globalEndpoints).deviceLinkApiBaseUrl});
    this.guestRoutes=new TerminalGuestRoutes(scope);
    this.modelGrants=new TerminalRemoteModelGrants(ownerDir,scope);
    try { await this.modelGrants.open(); } catch { logger.warn('REMOTE_MODEL_GRANTS_UNAVAILABLE'); }
    let readyRoutes!:()=>void;const routesReady=new Promise<void>(resolve=>{readyRoutes=resolve;});
    const sshOwnerGuard=()=>{if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.ownerSuspended||this.closing)throw new Error('OWNER_CHANGED');};
    this.ssh=new TerminalSshService(this.profileDir,(channel,payload)=>{
      if(scope()!==`${owner}:${generation}`||this.ownerSuspended)return;
      this.transport.publish(channel,[payload]);void this.remote.publish(channel,payload).catch(()=>{});
    },{logger,runtimeDirectory:RUNTIME_DIRECTORY,ownerScope:()=>scope()??'inactive',assertCurrent:sshOwnerGuard});
    try { await this.ssh.open(); } catch { logger.warn('SSH_CONFIGURATION_UNAVAILABLE'); }
    this.browser=new TerminalFileBrowser(this.profileDir,(channel,value)=>{
      if(this.ownerKey!==owner || this.ownerGeneration!==generation || this.ownerSuspended || this.closing)return;
      this.transport.publish(channel,[value]);void this.remote.publish(channel,value).catch(()=>{});
    },async url=>{const media=await this.tasks.resolveManaged(url);return {path:media.path,mimeType:media.mimeType??'application/octet-stream'};},this.ssh,logger);
    this.protectedInput = new TerminalProtectedInput({root:ownerDir,
      createDriver:()=>this.desktop?.createHandoffDriver()??null,
      liveViewAvailable:()=>this.desktop?.liveViewAvailable()??false,
      continueAgent:async(...args)=>{sshOwnerGuard();await this.tasks.continueInputHandoff(...args);},
      secrets:{get:key=>this.secrets.get(`${owner}:${key}`),set:(key,value)=>this.secrets.set(`${owner}:${key}`,value),delete:key=>this.secrets.delete(`${owner}:${key}`)},
      scope:()=>{const session=this.auth.snapshot().session;return session&&session.key===owner&&this.ownerGeneration===generation&&!this.ownerSuspended?{realm:session.realm,membershipId:session.membership.id,deviceId:this.settings.deviceId}:null;},
      assertCurrent:()=>{if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.closing)throw new Error('OWNER_CHANGED');},
      remoteEnabled:()=>this.settings.snapshot().effective.remoteEnabled,
      taskExists:async id=>Boolean(await this.tasks.storage.get(id)||await this.companions?.storage.get(id)),
      emit:(channel,payload)=>{if(this.ownerSuspended)return;this.tasks?.sessionActivity?.hostInteraction(channel,payload);this.taskNotifications?.event(channel,payload);this.transport.publish(channel,[payload]);void this.remote.publish(channel,payload).catch(()=>{});},
      invoke:async(device,channel,args)=>{
        try { return {ok:true,result:await this.remote.invoke(device,channel,args)}; }
        catch(error){return {ok:false,error:{code:(error as {code?:string}).code==='CHANNEL_NOT_ALLOWED'?'CHANNEL_NOT_ALLOWED':'IPC_ERROR',message:'Authorization exchange failed'}};}
      },
    });
    await this.protectedInput.prepare();
    this.tasks=new TerminalTaskHost({database:this.database,dataRoot:this.profileDir,ssh:this.ssh,
      secretsLocked:()=>this.secrets.status().locked,
      desktopInputBinary:this.desktop?()=>this.desktop!.inputBinary():undefined,
      currentOwnerSession:()=>({dataOwnerId:this.auth.snapshot().session?.membership.id??null,generation:this.ownerGeneration}),
      materializeSshRemoteMedia:(origin,url,limits)=>{sshOwnerGuard();if(!origin.remoteHostId)throw new Error('REMOTE_SOURCE_REQUIRED');return this.ssh.media.materializeSshRemoteMedia({...origin,remoteHostId:origin.remoteHostId},url,undefined,limits);},
      accountContext:()=>{const session=this.auth.snapshot().session;return {mode:session?'cloud':'local',isAuthenticated:!!session,userId:session?.membership.id??null,membershipKind:session?.membership.kind??null};},deviceId:this.settings.deviceId,listOrcaDevices:async()=>({devices:await this.deviceManagement.list()}),remoteWorkerLocations:async()=> (await this.remote.listDevices()).filter(device=>device.deviceId!==this.settings.deviceId&&device.online).map(device=>({agentDeviceId:device.deviceId,name:device.name})),profileDir:ownerDir,region:this.region,logger,language:()=>this.settings.snapshot().effective.language,silentStopMessage:()=>silentStopMessage(this.settings.snapshot().effective.language),runtimeRecoveryMessage:()=>runtimeRecoveryMessage(this.settings.snapshot().effective.language),deferPendingTasks:true,protectedInput:this.protectedInput,remoteAttachments:{
      materializeRemoteAttachment: async (ref,destination,integrity) => {
        const context=this.tasks.currentInvocation();
        const check=()=>{context.assertCurrent?.();if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.closing)throw new Error('OWNER_CHANGED');};
        check();
        if(ref.peer){
          if(!context.deviceId)throw new Error('FILE_PEER_DENIED');
          await this.media.inbox.copyFromPeer(context.deviceId,ref.peer,destination);
        } else await this.media.download(ref.ossKey,destination,integrity,check,context.signal);
        check();
      },
      removeRemote: key => this.media.remove(key),
    },resolveAttachment:async(reference,context,sessionId)=>{
      if(reference.startsWith('xdt-oss-attach:')||reference.startsWith('cindy-oss-attach:')||reference.startsWith('cindy-peer-attach:'))return this.media.resolve(reference,context);
      const url=path.isAbsolute(reference)?`xdt-file://open?path=${encodeURIComponent(reference)}`:reference;
      if(context.sharedTask&&url.startsWith('cindy-media:')){
        const media=await this.tasks.resolveManaged(url,sessionId);context.assertCurrent?.();
        return {path:media.path,mimeType:media.mimeType};
      }
      const source=await this.browser.openMedia(url,{assertCurrent:()=>context.assertCurrent?.()});
      try {
        if(context.sharedTask){
          const row=await this.tasks.storage.get(sessionId);
          const {realpath}=await import('node:fs/promises');
          const base=row?await realpath(row.workDir):'';
          if(!base||source.path!==base&&!source.path.startsWith(base+path.sep))throw new Error('SHARED_TASK_ATTACHMENT_SCOPE');
        }
        return {path:source.path,mimeType:source.mimeType};
      }finally{await source.handle.close();}
    },isSessionShared:id=>this.sharedTasks?.isSessionShared(id)??false,beforeTaskUnavailable:id=>this.sharedTasks.closeTask(id),remoteInvoke:(deviceId,channel,args)=>this.invokeRemoteResult(deviceId,channel,args),helperRemoteInvoke:(device,channel,args,options)=>this.remote.invokeResult(device,channel,args,options),authorizeGuestRequest:input=>this.guestRoutes.check(input),authorizeHostedRequest:async input=>this.guestRoutes.ownerAllowed(input),resolveExecutionRoute:async(input,id)=>{await routesReady;return this.groups.resolveExecutionRoute(input,id);},secretStore:{
      get:key=>this.secrets.get(`${owner}:${key}`),set:(key,value)=>this.secrets.set(`${owner}:${key}`,value),delete:key=>this.secrets.delete(`${owner}:${key}`),
    },emitRemote:(channel,args)=>{
      if(this.ownerKey!==owner || this.ownerGeneration!==generation || this.ownerSuspended || this.closing)return;
      void this.remote?.publish(channel,args[0]).catch(()=>{});
    },emitLocal:(channel,args)=>{
      if(this.ownerKey!==owner || this.ownerGeneration!==generation || this.ownerSuspended || this.closing)return;
      this.transport.publish(channel,args);
    },emit:(channel,args)=>{
      if(this.ownerKey!==owner || this.ownerGeneration!==generation || this.ownerSuspended || this.closing)return;
      this.taskNotifications?.event(channel, args[0]);
      this.transport.publish(channel,args);void this.remote?.publish(channel,args[0]).catch(()=>{});
      if(channel==='maker:status-changed')this.remote?.refreshPresence();
    }});
    await this.tasks.ready;
    this.tasks.usageApi.bindPeers({
      listDevices: async () => ({ devices: await this.deviceManagement.list() }),
      invoke: async (device, channel, args) => {
        try { return { ok: true, result: await this.remote.invoke(device, channel, args, { background: true }) }; }
        catch (error) { return { ok: false, error: { code: error instanceof TerminalRemoteError ? error.code : 'IPC_ERROR', message: error instanceof TerminalRemoteError ? error.message : 'Remote usage unavailable' } }; }
      },
    });
    const worktrees = await createTerminalWorktrees({ profile: this.profileDir, root: ownerDir, tasks: this.tasks.storage, logger, appDataRoot: this.runtimePaths.worktreeAppDataRoot,
      guard: () => { if (this.ownerKey !== owner || this.ownerGeneration !== generation || this.closing) throw new Error('OWNER_CHANGED'); },
      secrets: { getSync: key => this.secrets.getSync(`${owner}:${key}`), setSync: (key, value) => this.secrets.setSync(`${owner}:${key}`, value) },
    });
    await this.tasks.connectWorktrees(worktrees);
    const endpoints=()=>((this.auth.snapshot().session?.realm??this.region)==='cn'?chinaEndpoints:globalEndpoints);
    this.gateway = new TerminalGateway({ models: this.tasks.models, pricing: this.tasks.usage.pricing, root: ownerDir,
      endpoint: () => endpoints().modelAccessApiBaseUrl, fallbackEndpoint: () => endpoints().cdnBaseUrl,
      identity: () => { const session = this.auth.snapshot().session; return session && !this.ownerSuspended ? { userId: session.membership.id, realm: session.realm } : null; },
      token: () => this.ownerSuspended ? null : this.auth.getAccessToken(), refreshToken: () => this.auth.refresh(),
      assertCurrent: () => { if (this.ownerKey !== owner || this.ownerGeneration !== generation || this.closing) throw new Error('OWNER_CHANGED'); },
      secrets: { get: key => this.secrets.get(`${owner}:${key}`), set: (key, value) => this.secrets.set(`${owner}:${key}`, value), delete: key => this.secrets.delete(`${owner}:${key}`) },
      changed: status => { if (this.ownerKey !== owner || this.ownerGeneration !== generation || this.ownerSuspended || this.closing) return;
        this.tasks.usage.accounts.noteGatewayStatus(status);
        void this.tasks.history.reconcile().catch(()=>logger.warn('HISTORY_INDEX_RECONCILE_FAILED'));
        this.transport.publish('model-access:status-change', [status]); this.transport.publish('maker:provider:changed', [{}]);
        void this.remote?.publish('maker:provider:changed', {}).catch(() => {});
      },
    });
    const ownerGateway = this.gateway;
    const assertMediaOwner=()=>{if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.ownerSuspended||this.closing)throw new Error('OWNER_CHANGED');};
    this.tasks.mediaRuntime.bindAccount({
      auth:{getAuthState:()=>{assertMediaOwner();const session=this.auth.snapshot().session;return {mode:session?'cloud':'local',dataOwnerId:owner,ownerGeneration:generation,...(session?{user:{id:session.membership.id}}:{})};},getActiveAuthRealm:()=>{assertMediaOwner();return this.auth.snapshot().session?.realm??this.region;}},
      apiAuth:{getAccessToken:()=>{assertMediaOwner();return this.auth.getAccessToken();},refresh:()=>{assertMediaOwner();return this.auth.refresh();},invalidateSession:()=>{assertMediaOwner();return this.auth.logout();}},
      endpoint:()=>{assertMediaOwner();return endpoints().modelAccessApiBaseUrl;},
    });
    this.tasks.usage.accounts.bindCloudAccount({
      auth: () => { const session = this.auth.snapshot().session;
        return session && this.ownerKey === owner && this.ownerGeneration === generation && !this.closing
          ? { mode: 'cloud', dataOwnerId: session.membership.id, ownerGeneration: generation,
            user: { id: session.membership.id, membershipKind: session.membership.kind } }
          : { mode: 'guest', dataOwnerId: null, ownerGeneration: generation }; },
      status: () => ownerGateway.status(), fetchQuota: () => ownerGateway.readAccountQuota(),
    });
    this.account=new TerminalRemoteAccountService({getApiBaseUrl:()=>endpoints().deviceLinkApiBaseUrl,getAuthBaseUrl:()=>endpoints().authApiBaseUrl,getToken:async()=>this.auth.getAccessToken(),getOwnerScope:()=>this.auth.snapshot().session?scope():null});
    this.crossShares=new TerminalCrossRegionShares({profileDir:ownerDir,account:this.account,region:this.auth.snapshot().session?.realm??this.region,endpoints:{cn:chinaEndpoints.deviceLinkApiBaseUrl,global:globalEndpoints.deviceLinkApiBaseUrl},getOwnerScope:()=>this.auth.snapshot().session?scope():null,deviceId:this.settings.deviceId,getHello:()=>({deviceName:this.settings.snapshot().effective.deviceName,platform:process.platform,appVersion:VERSION,remoteControlEnabled:false,busy:false}),createWebSocket:(url,headers)=>new WebSocket(url,{headers}),directRuntime:createNodeDirectRtcRuntime(wrtc),onPush:push=>this.transport.publish('terminal:remote-event',[push])});
    if(this.auth.snapshot().session)void this.crossShares.open().catch(()=>logger.warn('CROSS_REGION_SHARE_UNAVAILABLE'));
    this.membership=new TerminalMembershipService({account:this.account,getOwnerScope:()=>this.auth.snapshot().session?scope():null,getDeviceId:()=>this.settings.deviceId,isTaskBlocked:id=>this.sharedTasks?.isBlocked(id)??true,externalReceived:()=>this.crossShares.snapshot(),onChanged:()=>this.groupReshare?.kick('memberships'),onRevoked:member=>{const match=(peer:string)=>{const source=parseProviderSharePeer(peer);return source?.role==='guest'&&source.shareId===member.shareId&&source.memberId===member.memberId;};void(member.removed?this.agents.host.purgeControllers(match):this.agents.host.abortControllers(match));if(member.removed)void this.reshares.service.pruneProviderShareReshares(record=>record.shareId===member.shareId&&record.memberId===member.memberId).catch(()=>logger.warn('RESHARE_PRUNE_FAILED'));}});
    this.sharedTasks=new TerminalSharedTasks({database:this.database,ownerAccountId:this.auth.snapshot().session?.membership.id??null,account:this.account,getOwnerScope:()=>this.auth.snapshot().session?scope():null,deviceId:this.settings.deviceId,readTask:id=>this.tasks.storage.get(id),revoke:id=>{for(const peer of this.membership.peersForTask(id))this.remote.revoke(peer);}});
    if(this.auth.snapshot().session)void this.sharedTasks.open().catch(()=>logger.warn('SHARED_TASK_SYNC_UNAVAILABLE'));
    this.reshares=new TerminalReshares({profileDir:ownerDir,getOwnerScope:scope,guestAccess:peer=>this.membership.guestAccess(peer),changed:()=>this.transport.publish('maker:remote-resources:changed',[{collectionId:'provider-reshares'}]),revoked:records=>{for(const record of records)void this.agents.host.abortReshare(controller=>{const peer=parseProviderSharePeer(controller);return peer?.role==='guest'&&peer.shareId===record.shareId&&peer.memberId===record.memberId&&peer.deviceId===record.deviceId;},record.key);}});
    await this.reshares.open();
    const invokeAgent=(deviceId:string,channel:string,args:unknown[])=>this.invokeRemoteResult(deviceId,channel,args);
    const connectAgent=(deviceId:string)=>{const poller=remoteAgentPollerFor(deviceId,invokeAgent,logger);return{invoke:poller.invoke,poller};};
    const groupRelay=createProviderGroupGuestRelay({scope:()=>this.groups.currentRuntime(),readGroup:id=>this.groups.read(id),connect:connectAgent,readResetAt:failure=>readTurnUsageResetAt(failure,Date.now(),{localTimeZoneTrusted:false}),reshareAllows:(id,key)=>this.groupReshare?.allows(id,key)??false,noteReshareDenied:(id,key)=>this.groupReshare?.noteDenied(id,key),reshareNeedsUpdate:id=>this.groupReshare?.needsUpdate(id)??false,now:Date.now,log:logger});
    const guestAllowed=(providerId:string,controller:string,model?:string)=>{const access=this.membership.guestAccess(controller);return access?.providerId===providerId&&this.agents.enabled(providerId)&&(!model||this.modelGrants.allows(providerId,model,access.memberId));};
    this.agents=new TerminalRemoteAgentService({profileDir:ownerDir,getOwnerScope:scope,readProviders:options=>this.tasks.models.views(options),startHosted:input=>this.tasks.startHosted(input),isAgentAvailable:kind=>this.tasks.isAgentAvailable(kind),modelAllowed:(id,model)=>this.modelGrants.allows(id,model),bindOwnerProviderRoute:(id,provider,allows)=>this.guestRoutes.bindOwner(id,provider,allows),ownerModelAllowed:(id,provider,_kind,model)=>this.guestRoutes.ownerAllowed({sessionId:id,providerId:provider,model}),
      shared:{
        purgeHostedTranscripts:(sessions,transcripts)=>this.tasks.purgeHostedTranscripts(sessions,transcripts),
        groupRelay,reshare:{sync:(...args)=>this.reshares.service.handleProviderShareReshare(...args),allows:(...args)=>this.reshares.service.providerShareReshareAllows(...args)},
        providerAccess:{
          resolve:async(kind,model,providerId,controller)=>resolveGuestProviderId(await this.tasks.models.views(),this.membership.guestAccess(controller)?.providerId,id=>guestAllowed(id,controller,model),kind,model,providerId),
          isAllowed:guestAllowed,
          models:async(kind,id,controller)=>guestProviderModelIds(await this.tasks.models.views(),id,kind).filter(model=>guestAllowed(id,controller,model)),
          restricted:(id,controller)=>{try{const rule=this.modelGrants.read(id,this.membership.guestAccess(controller)?.memberId);return rule.models!==null||rule.providerModels!==null;}catch{return true;}},
        },
        bindGuestProviderRoute:createGuestProviderRouteBinder({registerRoute:(...args)=>this.guestRoutes.register(...args),modelAllowed:(id,model,session)=>this.guestRoutes.modelAllowed(id,model,session),readProviders:()=>this.tasks.models.views(),guestAccess:controller=>this.membership.guestAccess(controller),ownerAllowed:controller=>this.agents.ownerController(controller),providerAllowed:id=>this.agents.enabled(id),modelAccess:this.modelGrants}),
      },log:logger});
    this.groups=new TerminalProviderGroups({profileDir:ownerDir,getOwnerScope:scope,invoke:(deviceId,channel,args)=>this.invokeRemoteResult(deviceId,channel,args),isRemoteAllowed:id=>this.agents.enabled(id),
      listLocalProviders:()=>this.agents.views(),localDeviceName:()=>this.settings.snapshot().effective.deviceName,localAppVersion:()=>VERSION,
      listDevices:async()=>await this.deviceManagement.list(),
      readDeviceProviders:deviceId=>readDeviceProviderViews((peer,channel,args)=>this.invokeRemoteResult(peer,channel,args),deviceId),
      listReceivedShares:()=>this.membership.receivedShares(),isMobilePlatform:platform=>platform==='ios'||platform==='android',listBindings:()=>this.tasks.listBindings(),isTurnRunning:id=>this.tasks.isTurnRunning(id),sessionGroup:id=>this.tasks.sessionGroup(id),onChanged:()=>this.groupReshare?.kick('groups')});
    this.groupReshare=createProviderGroupReshare({listGroups:()=>this.groups.snapshot(),ownedShares:()=>this.membership.ownedShares(),pendingCleanups:()=>this.groups.pendingCleanups(),completeCleanup:(id,token)=>this.groups.completeCleanup(id,token),readCaps:id=>RemoteAgentRunClient.caps(connectAgent(id).invoke),invoke:(id,request)=>connectAgent(id).invoke([request]),now:Date.now,log:logger});
    readyRoutes();
    const guardKnowledge=()=>{if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.closing)throw new Error('OWNER_CHANGED');};
    this.knowledge=new TerminalKnowledge({root:ownerDir,logger,assertCurrent:guardKnowledge,
      workingDirs:async()=>[this.settings.snapshot().effective.workingDir,...(await this.tasks.storage.list()).map(task=>task.workDir)],
      changed:collectionId=>{guardKnowledge();this.transport.publish('maker:remote-resources:changed',[{collectionId}]);void this.remote.publish('maker:remote-resources:changed',{collectionId}).catch(()=>{});},
      searchSessions:async(query,options)=>{
        guardKnowledge();
        if(options?.callerMemoryScopeKey?.startsWith('bot:'))throw new Error('TASK_SCOPE_MISMATCH');
        if(options?.role==='system')return [];
        const result=await this.tasks.historyDeps().searchChatHistory({query,sessionIds:options?.sessionId?[options.sessionId]:null,workdir:null,fromMs:null,toMs:null,agentKind:null,roles:options?.role?[options.role]:null,contextRadius:0,limit:options?.limit??10,offset:0});
        guardKnowledge();if(!result.ok)throw new Error('HISTORY_SEARCH_FAILED');
        return result.result.hits.map(hit=>({sessionId:hit.sessionId,sessionUrl:`cindy://session/${encodeURIComponent(hit.sessionId)}?device=${encodeURIComponent(this.settings.deviceId)}`,messageId:hit.messageId,role:hit.role,snippet:hit.snippet??'',ts:hit.createdAt,score:-hit.score}));
      }});
    await this.knowledge.ready;
    this.tasks.configureKnowledge(this.knowledge);
    this.resources=new TerminalResources(this.tasks);
    registerKnowledgeResources(this.resources.registry,this.knowledge);
    const guardIm = () => { if (this.ownerKey !== owner || this.ownerGeneration !== generation || this.closing) throw new Error('OWNER_CHANGED'); };
    const im = new TerminalImConnections({ tasks: this.tasks, root: ownerDir, logger, assertCurrent: guardIm, knowledge: this.knowledge, language: () => this.settings.snapshot().effective.language,
      remote: this.remote, hasUnrecoveredMatchingFailure: run => this.scheduler.storage.hasUnrecoveredMatchingFailure(run),
      secrets: { getSync: key => this.secrets.getSync(`${owner}:${key}`), setSync: (key, value) => this.secrets.setSync(`${owner}:${key}`, value), deleteSync: key => this.secrets.deleteSync(`${owner}:${key}`), available: () => !this.secrets.status().locked },
      emit: (channel, payload) => { guardIm(); if (this.ownerSuspended) return; this.transport.publish(channel, [payload]); void this.remote?.publish(channel, payload).catch(() => {}); },
    });
    this.im = im;
    this.taskNotifications = await createTerminalTaskNotifications({ tasks: this.tasks, im, remote: this.remote,
      t: translation.t, logger, current: () => this.ownerKey === owner && this.ownerGeneration === generation && !this.ownerSuspended && !this.closing,
      emit: (channel, payload) => { guardIm(); this.transport.publish(channel, [payload]); },
    });
    const subscriptions = new TerminalSubscriptions({ root: ownerDir, models: this.tasks.models,
      binary: async () => (await this.engines.resolve('codex'))?.binary ?? null,
      version: async () => (await this.engines.status('codex')).version,
      secrets: { getSync: key => this.secrets.getSync(`${owner}:${key}`), setSync: (key,value) => this.secrets.setSync(`${owner}:${key}`,value), deleteSync: key => this.secrets.deleteSync(`${owner}:${key}`) },
      assertCurrent: guardIm,
      changed: providerId => { guardIm(); this.tasks.models.gatewayChanged(); void this.tasks.usage.accounts.syncCredentialChanges(providerId).catch(()=>logger.warn('Account usage synchronization failed')); this.transport.publish('maker:provider:changed', [{}]); void this.remote?.publish('maker:provider:changed', {}).catch(() => {}); },
    });
    await subscriptions.openAiAccount()!.ready;
    this.tasks.models.nativeClaude = new TerminalClaudeLogin({ owner,
      binary: async () => (await this.engines.resolve('claude-code'))?.binary ?? null,
      readBinding: () => this.secrets.getSync('terminal:native:anthropic-binding'),
      writeBinding: value => value === null ? this.secrets.deleteSync('terminal:native:anthropic-binding') : this.secrets.setSync('terminal:native:anthropic-binding', value),
      assertCurrent: guardIm,
      changed: () => { guardIm(); this.tasks.models.gatewayChanged(); void this.tasks.usage.accounts.syncCredentialChanges('anthropic').catch(()=>logger.warn('Account usage synchronization failed')); this.transport.publish('maker:provider:changed', [{}]); },
    });
    this.providerLogin = new TerminalProviderLogin({ models: this.tasks.models, subscriptions,
      claude: new TerminalClaudeAuthorization({ auth: this.tasks.models.nativeClaude!, binary: async () => (await this.engines.resolve('claude-code'))?.binary ?? null, assertCurrent: guardIm }),
      secrets: { getSync: key => this.secrets.getSync(`${owner}:${key}`), setSync: (key,value) => this.secrets.setSync(`${owner}:${key}`,value), deleteSync: key => this.secrets.deleteSync(`${owner}:${key}`) },
      assertCurrent: guardIm, log: logger,
      changed: () => { guardIm(); this.tasks.models.gatewayChanged(); this.transport.publish('maker:provider:changed', [{}]); void this.remote?.publish('maker:provider:changed', {}).catch(() => {}); },
    });
    this.localModels = new TerminalLocalModels({ root: ownerDir, models: this.tasks.models, assertCurrent: guardIm, log: logger,
      changed: modelsChanged => { guardIm(); if (modelsChanged) { this.transport.publish('maker:provider:changed', [{}]); void this.remote.publish('maker:provider:changed', {}).catch(() => {}); } const payload = {collectionId: 'local-models'}; this.transport.publish('maker:remote-resources:changed', [payload]); void this.remote.publish('maker:remote-resources:changed', payload).catch(() => {}); },
    });
    const localModels = this.localModels;
    this.tasks.utility.configureConnections({
      ensureManagedOllamaReadyForSession: input => localModels.prepare(input.providerId ?? ''),
      readCachedGenericOAuthAccessToken: id => this.providerLogin!.cachedCredential(id),
      ...subscriptions.utilityConnections(),
    });
    this.configuration=new TerminalConfiguration(this.tasks.capabilities,{login:this.providerLogin,revision:()=>this.tasks.models.revision(),save:(action,provider,keys,context)=>this.tasks.configureProvider(action,provider,keys,context)}, {
      registration: im.registration,
      revision: () => im.version(), save: async (id, input, context) => {
        context.assertCurrent?.(); guardIm();
        await im.saveConfiguration(id, input);
      },
    });
    registerImResources(this.resources.registry, im, this.tasks, this.configuration);
    this.protectedInput.configureSettings(this.configuration);
    this.tasks.registerCapabilityResources(this.resources.registry,this.configuration);
    registerModelConfigurationResources(this.resources.registry,this.tasks.models,this.configuration,(channel,args,context)=>this.tasks.invoke(channel,args,context));
    this.localModels.register(this.resources.registry);
    const engineTasks = this.tasks;
    this.engineResources = new TerminalEngineResources(this.resources.registry, {
      engines: this.engines, assertCurrent: guardIm,
      refresh: status => { guardIm(); return engineTasks.refreshBinaries({ [status.kind]: status.binary ?? undefined }); },
      changed: () => { guardIm(); const payload = { collectionId: 'engines' }; this.transport.publish('maker:remote-resources:changed', [payload]); void this.remote.publish('maker:remote-resources:changed', payload).catch(() => {}); },
    });
    const guardPlugin=()=>{if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.closing)throw new Error('OWNER_CHANGED');};
    this.pluginAccount=new TerminalPluginAccount({endpoints,membership:()=>this.auth.snapshot().session?.membership??null,token:()=>this.auth.getAccessToken(),refresh:()=>this.auth.refresh(),assertCurrent:guardPlugin,onOrganization:organization=>this.plugins?.identity.rememberOrganization(organization)});
    const pluginAbort=new AbortController();
    const deposits=new DirDepositVault(),saves=new SaveDepositVault();
    const pluginConversations=await this.tasks.conversations,pluginDatabase=await this.tasks.database,pluginMedia=this.tasks.media;
    this.plugins=new TerminalPlugins({root:ownerDir,deferStart:true,runtimeDirectory:RUNTIME_DIRECTORY,
      account:this.pluginAccount,
      events:{getDbClient:()=>{guardPlugin();return pluginDatabase.getDbClient();},assertCurrent:guardPlugin,logger,
        updateMessageContent:(...args)=>{guardPlugin();return pluginConversations.messages.updateMessageContent(...args);},
        saveCard:row=>pluginMedia.savePluginCard(row,guardPlugin),
        publish:(channel,payload)=>{guardPlugin();this.transport.publish(channel,[payload]);void this.remote.publish(channel,payload).catch(()=>{});}},
      models:{models:this.tasks.models,utility:this.tasks.utility},
      executablePath:()=>this.pluginBrowser.resolve(),locale:()=>this.settings.snapshot().effective.language,assertCurrent:guardPlugin,log:logger,onClose:()=>pluginAbort.abort(),
      secrets:{get:key=>this.secrets.get(`${owner}:${key}`),set:(key,value)=>this.secrets.set(`${owner}:${key}`,value),delete:key=>this.secrets.delete(`${owner}:${key}`),getSync:key=>this.secrets.getSync(`${owner}:${key}`),setSync:(key,value)=>this.secrets.setSync(`${owner}:${key}`,value),deleteSync:key=>this.secrets.deleteSync(`${owner}:${key}`),setManySync:entries=>this.secrets.setManySync(Object.fromEntries(Object.entries(entries).map(([key,value])=>[`${owner}:${key}`,value])))},
      changed:()=>{if(this.ownerSuspended||this.closing)return;this.transport.publish('ghosts:changed',[]);void this.remote.publish('maker:remote-resources:changed',{collectionId:'plugins'}).catch(()=>{});},
      credentials:{getLoginEmail:()=>this.auth.snapshot().session?.membership.email??null,openExternal:async url=>{guardPlugin();const id=randomUUID();this.pluginAuthorizations.set(id,{url,expiresAt:Date.now()+15*60_000});this.transport.publish('terminal:plugin-authorization',[]);}},
      receive:async()=>({ok:false,errorCode:'UNSUPPORTED_CAPABILITY'}),
      archiveUserState:(from,to)=>this.tasks.media.relocatePlugin(from,to,guardPlugin),
      cards:{persist:row=>this.tasks.media.savePluginCard(row,guardPlugin),broadcast:payload=>{guardPlugin();this.transport.publish('ghosts:card-updated',[payload]);void this.remote.publish('ghosts:card-updated',payload).catch(()=>{});}},
      fs:{getSessionSnapshot:async(id,instance)=>(await this.tasks.pluginPermissionSnapshot(id,instance))??(await this.companions?.pluginPermissionSnapshot(id,instance))??null,requestWriteConfirm:(id,payload)=>this.companions?.hasLiveSession(id)?this.companions.requestPluginWrite(id,payload):this.tasks.requestPluginWrite(id,payload),writeSaveDeposit:(id,token,name,bytes)=>saves.write(id,token,name,bytes)},
      network:{getLoginEmail:()=>this.auth.snapshot().session?.membership.email??null,
        fetchImpl:(url,init)=>fetch(url,{...init,body:init.body as BodyInit,signal:AbortSignal.any([init.signal,pluginAbort.signal])}),
        fetchPublicImpl:(url,init,beforeDispatch)=>fetchSingleHopWithSsrFGuard({url,init:{...init,body:init.body as BodyInit},signal:AbortSignal.any([init.signal,pluginAbort.signal]),requireHttps:true,beforeDispatch}),
        isSupportedMediaMime:mime=>this.tasks.media.supportedMime(mime),
        readGhostMedia:(id,hash)=>this.tasks.media.readPluginMedia(id,hash,guardPlugin),
        saveGhostMedia:input=>this.tasks.media.savePluginMedia(input,guardPlugin),
        takeDirDeposit:(id,token)=>deposits.take(id,token),writeSaveDeposit:(id,token,name,bytes)=>saves.write(id,token,name,bytes),
      },
    });
    await this.plugins.ready;
    this.tasks.configurePluginEvents(this.plugins.events!);
    this.pluginMarket=new TerminalPluginMarket({root:ownerDir,host:this.plugins,account:this.pluginAccount,assertCurrent:guardPlugin});
    this.pluginMarket.register(this.resources.registry);
    this.pluginTasks=new TerminalPluginTasks({root:ownerDir,runtimeDirectory:RUNTIME_DIRECTORY,host:this.plugins,account:this.pluginAccount,market:this.pluginMarket,tasks:this.tasks,protectedInput:this.protectedInput,deposits,saves,mediaTransfer:this.media,projectDirectories:()=>this.projects?.directories()??Promise.resolve([]),
      companions:()=>this.companions,owner:()=>({mode:this.auth.snapshot().session?'cloud':'local',dataOwnerId:owner,generation}),signedIn:()=>Boolean(this.auth.snapshot().session),remoteAvailable:()=>Boolean(this.auth.snapshot().session)&&this.settings.snapshot().effective.remoteEnabled,locale:()=>this.settings.snapshot().effective.language,assertCurrent:guardPlugin,
      emit:(channel,payload)=>{guardPlugin();if(this.ownerSuspended)return;this.tasks.sessionActivity.hostInteraction(channel,payload);this.transport.publish(channel,[payload]);void this.remote.publish(channel,payload).catch(()=>{});},
    });
    await this.pluginTasks.ready;
    registerPluginResources(this.resources.registry,this.plugins,this.pluginTasks.pages,this.pluginTasks.sessions);
    registerLibraryResources(this.resources.registry,this.plugins);

    this.projects=new TerminalProjects(ownerDir,{tasks:this.tasks,logger,emit:(channel,payload)=>{guardKnowledge();this.transport.publish(channel,[payload]);void this.remote.publish(channel,payload).catch(()=>{});},guard:guardKnowledge,createSession:async(workingDir,title)=>{const created=await this.tasks.invoke('maker:create-session',[{workingDir,title}],{source:'local',assertCurrent:guardKnowledge}) as {sessionId?:string;id?:string};const id=created.sessionId??created.id;if(!id)throw new Error('SESSION_CREATE_FAILED');return id;}});
    await this.projects.ready;this.projects.register(this.resources.registry);
    registerWorktreeResources(this.resources.registry,worktrees,this.tasks);
    registerRemoteManagementResources(this.resources.registry,{agent:this.agents,groups:this.groups,membership:this.membership,modelGrants:this.modelGrants,account:this.account,deviceId:this.settings.deviceId,apiBaseUrl:()=>endpoints().deviceLinkApiBaseUrl,remoteEnabled:()=>this.settings.snapshot().effective.remoteEnabled});
    registerShareResources(this.resources.registry,{account:this.account,membership:this.membership,cross:this.crossShares,agent:this.agents,grants:this.modelGrants,reshares:this.reshares,sharedTasks:this.sharedTasks,deviceId:this.settings.deviceId,apiBaseUrl:()=>endpoints().deviceLinkApiBaseUrl,listTasks:()=>this.tasks.storage.list()});
    this.ssh.registerResources(this.resources.registry);
    const binaries=await this.engines.allStatus();
    await this.tasks.refreshBinaries(Object.fromEntries(binaries.filter(status=>status.binary).map(status=>[status.kind,status.binary!])));
    this.scheduler=new TerminalSchedulerHost({startPaused:true,worktrees,plugins:this.plugins,profileDir:ownerDir,tasks:this.tasks,logger,companions:()=>this.companions, notify:(schedule,run)=>im.notify(schedule,run),
      canDispatch:()=>this.ownerKey===owner&&this.ownerGeneration===generation&&!this.ownerSuspended&&!this.closing,
      emit:(channel,args)=>{if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.ownerSuspended||this.closing)return;this.transport.publish(channel,args);void this.remote.publish(channel,args[0]).catch(()=>{});}});
    this.scheduler.registerResources(this.resources.registry);
    // The new owner initializes while public RPC remains suspended. Generation
    // fences reject the old owner; the suspension gate is lifted only after setup.
    const guardCompanion=()=>{if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.closing)throw new Error('OWNER_CHANGED');};
    await this.tasks.connectOriginalBotServices({memory:this.knowledge.memory,
      resourceRoot:()=>path.join(RUNTIME_DIRECTORY,'resources'),
      listBotImChannels:({botId})=>[...new Set(this.tasks.botImConnections.listBotImConnectionsForBot(botId).map(connection=>connection.channel))],
      isCompanionShadowed:id=>this.companionCloud?.homes.isShadowed(id)??false,
    });
    this.companions=new TerminalCompanionHost({ tasks: this.tasks,
    isShadowed:id=>this.companionCloud?.homes.isShadowed(id)??false,
    beforeDelete:async id=>{guardCompanion();await im.companionRuntime?.removeBotImConnectionsForBot(id);},
    afterDelete:async(id,current)=>{current();void this.companionCloud?.retire(id).catch(()=>logger.warn('Companion cloud retirement failed'));},
    modelLocations: async () => [
        ...(await this.remote.listDevices()).filter(device => device.deviceId !== this.settings.deviceId && device.online).map(device => ({ agentDeviceId: device.deviceId, name: device.name })),
        ...this.membership.receivedShares().filter(share => share.status === 'active').map(share => ({ agentDeviceId: `share:${share.shareId}`, name: `${share.deviceName} · ${share.providerLabel}` })),
    ], isGroupedProvider: id => Boolean(this.groups.read(id)), resolveModel: (choice, id, dir) => this.tasks.resolveCompanionModel(choice, id, dir), providerViews: device => this.tasks.companionProviderViews(device), root: path.join(ownerDir, 'companions'), profileDir: ownerDir, logger, guard: guardCompanion, attachments: this.tasks.attachmentHost(),
    binary: async (kind) => (await this.engines.allStatus()).find(status => status.kind === kind)?.binary ?? null,
    emit: (channel, args) => { guardCompanion(); if (this.ownerSuspended)
        return; this.taskNotifications?.event(channel, args[0]); this.transport.publish(channel, args); void this.remote.publish(channel, args[0]).catch(() => { }); } });
    await this.companions.ready;
    await im.connectCompanions();
    this.pluginTasks.connectCompanions();
    this.routines=new TerminalCompanionRoutines(this.companions,this.scheduler,()=>!this.secrets.status().locked);
    this.companions.routines=this.routines;
    this.companions.services.connectObservation(this.routines,{
      enabled:()=>!!this.auth.snapshot().session&&this.settings.snapshot().effective.remoteEnabled,
      listDevices:async()=>({devices:await this.deviceManagement.list()}),
      mayServeBackgroundRead:version=>this.tasks.mayServeBackgroundRead(version),
      remoteBackgroundInvoke:async(device,channel,args)=>{
        guardCompanion();
        try{return {ok:true as const,result:await this.remote.invoke(device,channel,args,{background:true,preSend:guardCompanion})};}
        catch(error){guardCompanion();return {ok:false as const,error:{code:error instanceof Error&&'code' in error?String(error.code):'REMOTE_UNAVAILABLE'}};}
      },
      remindOwner:(row,eventId)=>{guardCompanion();this.remote.notifications.sendMobileSessionNotify({
        sessionId:row.sessionId,title:row.title,kind:'needs-reply',...(row.pendingQuestion?{detail:row.pendingQuestion}:{}),
        eventId:`bot-autonomy:${eventId}`,generation:this.remote.getNotificationGeneration(),
      });this.transport.publish('terminal:notification',[{sessionId:row.sessionId,title:row.title,kind:'needs-reply',detail:row.pendingQuestion}]);},
    });
    const trashItem=async(file:string)=>{guardCompanion();const {default:trash}=await import('trash');guardCompanion();await trash(file,{glob:false});};
    const groupNotifications={
      getMobileNotifyGeneration:()=>this.remote.getNotificationGeneration(),
      sendMobileBotGroupNotify:(payload:Parameters<typeof this.remote.notifications.sendMobileBotGroupNotify>[0])=>this.remote.notifications.sendMobileBotGroupNotify(payload),
      getBotGroupStepNotificationBody:createSessionNotificationCopy(translation.t).getBotGroupStepNotificationBody,
    };
    if(this.auth.snapshot().session){
      const cloud=new TerminalCompanionCloud({host:this.companions,routines:this.routines,userDataPath:this.profileDir,
        endpoint:name=>endpoints()[name],getToken:()=>this.auth.getAccessToken(),refresh:async()=>{await this.auth.refresh();return !!this.auth.getAccessToken();},
        remoteControlEnabled:()=>this.settings.snapshot().effective.remoteEnabled,locale:()=>this.settings.snapshot().effective.language,
        guard:guardCompanion,logger,deviceId:this.settings.deviceId,
        listDevices:async()=>await this.deviceManagement.list(),remoteInvoke:(device,channel,args)=>this.remote.invoke(device,channel,args),
        emit:(channel,args)=>{guardCompanion();this.transport.publish(channel,args);void this.remote.publish(channel,args[0]).catch(()=>{});}});
      this.companionCloud=cloud;this.companions.setExecutionGuard(id=>cloud.assertMayRun(id));
      await cloud.open(this.resources.registry,trashItem,groupNotifications);
    }else {
      this.companionCloud=undefined;
      await this.tasks.connectOriginalGroupServices({resources:this.resources.registry,trashItem,notifications:groupNotifications});
    }
    this.companions.onChange(id => this.tasks.sessionActivity.companionChanged(id));
    this.routines.registerResources(this.resources.registry);
    await registerCompanionResources(this.resources.registry,this.companions,this.companionCloud);
  }

  private async invokeRemoteResult(deviceId:string,channel:string,args:unknown[]) {
    try {
      let peer=deviceId;
      if(deviceId.startsWith('share:')){
        if(this.crossShares.has(deviceId.slice(6)))return {ok:true,result:await this.crossShares.invoke(deviceId.slice(6),channel,args)};
        const shares=await this.membership.list();
        const share=shares.received.find(value=>value.shareId===deviceId.slice(6)&&value.status==='active');
        if(!share)throw new Error('[REMOTE_AGENT_SHARE_REMOVED] Shared provider is unavailable');
        peer=providerShareHostPeer(share.shareId,share.hostDeviceId);
      }
      return {ok:true,result:await this.remote.invoke(peer,channel,args)};
    } catch(error) {return {ok:false,error:{code:(error as {code?:string}).code,message:error instanceof Error?error.message:'Remote operation failed'}};}
  }

  async invoke(channel: string,args: unknown[],context: InvocationContext): Promise<unknown> {
    const local=context.source==='local';
    if(this.closing)throw new Error('SERVICE_STOPPING');
    context.assertCurrent?.();
    if(channel==='terminal:channel-registration'||channel==='terminal:provider-login'){
      if(!local || context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');
      await this.ownerChange; context.assertCurrent?.();
      if(this.ownerSuspended)throw new Error('ACCOUNT_CHANGE_IN_PROGRESS');
      return this.protectedInput!.channelRegistration(args[0], channel === 'terminal:provider-login' ? 'providers' : 'channels');
    }
    if(channel==='terminal:configuration'){
      if(!local)throw new Error('LOCAL_ONLY_COMMAND');
      const operation=configurationOperation(args[0]),value=args[0] as Record<string,unknown>;
      if(value.deviceId!==undefined){
        if(typeof value.deviceId!=='string'||!value.deviceId)throw new Error('INVALID_DEVICE');
        await this.protectedInput!.saveRemoteConfiguration(value.deviceId,operation,value.input);
      }else await this.configuration!.save(operation,value.input,context);
      return {saved:true};
    }
    if(channel==='terminal:plugin-secret'){
      if(!local)throw new Error('LOCAL_ONLY_COMMAND');
      const input=parsePluginSecretForm(args[0]);
      if(input.deviceId)await this.protectedInput!.saveRemotePluginSecret(input.deviceId,input.pluginId,input.key,input.approval,input.value);
      else await this.plugins!.saveSecret(input.pluginId,input.key,input.value,input.approval,context.assertCurrent);
      return {saved:true};
    }
    if(channel==='terminal:plugin-authorizations'){
      if(!local)throw new Error('LOCAL_ONLY_COMMAND');
      for(const [id,item] of this.pluginAuthorizations)if(item.expiresAt<=Date.now())this.pluginAuthorizations.delete(id);
      return [...this.pluginAuthorizations].map(([id,value])=>({id,...value}));
    }
    if(channel==='terminal:plugin-assist'){
      if(!local)throw new Error('LOCAL_ONLY_COMMAND');
      const id=randomUUID(),owner=this.ownerGeneration;
      const current=()=>{if(owner!==this.ownerGeneration||this.ownerSuspended)throw new Error('OWNER_CHANGED');};
      const present=(value:{url:string;userCode?:string;expiresAt:number})=>{current();this.pluginAuthorizations.set(id,value);this.transport.publish('terminal:plugin-authorization',[]);};
      try{return await this.protectedInput!.assistPlugin(args[0],{
        openExternal:async url=>{present({...this.pluginAuthorizations.get(id),url,expiresAt:this.pluginAuthorizations.get(id)?.expiresAt??Date.now()+15*60_000});},
        presentDeviceCode:prompt=>{present({url:prompt.authorizeUrl,userCode:prompt.userCode,expiresAt:prompt.expiresAt});return ()=>{this.pluginAuthorizations.delete(id);this.transport.publish('terminal:plugin-authorization',[]);};},
      });}finally{this.pluginAuthorizations.delete(id);this.transport.publish('terminal:plugin-authorization',[]);}
    }
    if (channel === PLUGIN_OAUTH_CHANNEL) {
      if (local || !context.deviceId || context.sharedTask) throw new Error('OWNER_REQUIRED');
      return this.protectedInput!.request(context.deviceId, args[0]);
    }
    if (channel === INPUT_HANDOFF_LOCAL_CHANNEL || channel === INPUT_HANDOFF_REMOTE_LOCAL_CHANNEL) {
      if (!local) throw new Error('LOCAL_ONLY_COMMAND');
      const value=object(args[0]);
      if (channel === INPUT_HANDOFF_LOCAL_CHANNEL) return {accepted:await this.protectedInput!.handoff.submit(valueString(value.requestId),value.submission)};
      return this.protectedInput!.submitRemote(valueString(value.deviceId),value.presentation,value.submission);
    }
    if(channel===REMOTE_TERMINAL_CHANNEL){
      if(context.sharedTask)throw new Error('OWNER_REQUIRED');
      return this.terminals.invoke(args[0],{controller:context.deviceId??'local',assertCurrent:()=>context.assertCurrent?.()});
    }
    if(channel.startsWith('terminal:')&&!local)throw new Error('LOCAL_ONLY_COMMAND');
    if(channel==='terminal:desktop'){
      if(args[0]==='status')return {available:Boolean(this.desktop),enabled:this.settings.deviceLink.readDeviceLinkSettings().remoteDesktopEnabled};
      if(!this.desktop)throw new Error('DESKTOP_PLATFORM_REQUIRED');
      if(args[0]==='permissions'&&(args[1]==='check'||args[1]==='guide'))return this.desktop.permissions(args[1]);
      if(args[0]==='enable'&&typeof args[1]==='boolean'){
        await this.settings.deviceLink.writeDeviceLinkSetting('remoteDesktopEnabled',args[1]);
        if(!args[1])await this.desktop.reset();
        return {available:true,enabled:args[1]};
      }
      if(args[0]==='stop'){await this.desktop.reset();return {stopped:true};}
      throw new Error('INVALID_DESKTOP_OPERATION');
    }
    if(channel==='terminal:status')return {
      version:VERSION,platform:process.platform,desktopAvailable:Boolean(this.desktop),busy:this.tasks.isBusy(),startedAt:this.startedAt,deviceId:this.settings.deviceId,deviceName:this.settings.snapshot().effective.deviceName,
      settings:this.settings.snapshot().effective,vault:this.secrets.status(),auth:this.auth.snapshot(),connection:this.remote.getStatus(),installation:await this.manager.status(),
    };
    if(channel==='terminal:native-claude') {
      if (!local || context.sharedTask) throw new Error('LOCAL_ONLY_COMMAND');
      await this.ownerChange; context.assertCurrent?.();
      if (this.ownerSuspended) throw new Error('ACCOUNT_CHANGE_IN_PROGRESS');
      const auth = this.tasks.models.nativeClaude!;
      if (args[0] === 'begin') return auth.begin();
      if (args[0] === 'finish' && typeof args[1] === 'string') return auth.finish(args[1]);
      if (args[0] === 'disconnect') { this.providerLogin?.cancelProvider('anthropic'); return auth.disconnect(); }
      if (args[0] === 'status') return auth.state();
      throw new Error('INVALID_ARGUMENT');
    }
    if(channel==='terminal:engines:list')return this.engines.allStatus();
    if(channel==='terminal:engines:refresh'){const statuses=await this.engines.allStatus();await this.tasks.refreshBinaries(Object.fromEntries(statuses.filter(status=>status.binary).map(status=>[status.kind,status.binary!])));return statuses;}
    if(['terminal:engines:install','terminal:engines:update','terminal:engines:repair'].includes(channel)){
      const kind=valueString(args[0]);if(!['claude-code','codex','pi'].includes(kind))throw new Error('INVALID_ENGINE');
      const result=channel.endsWith(':update')?await this.engines.update(kind as EngineKind,context.signal):channel.endsWith(':repair')?await this.engines.repair(kind as EngineKind,context.signal):await this.engines.install(kind as EngineKind,{signal:context.signal});
      await this.tasks.refreshBinaries({[kind]:result.binary??undefined});return result;
    }
    if(channel.startsWith('terminal:ssh:'))return this.ssh.invoke(channel.slice('terminal:ssh:'.length),args,context);
    if(channel==='maker:remote-ssh:list-codex-models') {
      if(context.sharedTask || (!local && (!context.ownerId || !context.deviceId || !context.assertCurrent)))throw new Error('OWNER_REQUIRED');
      return this.ssh.invoke('list-codex-models',args,context);
    }
    if(channel==='terminal:settings:get')return this.settings.snapshot();
    if(channel==='terminal:settings:update'){const result=await this.settings.update(args[0]);this.deviceManagement.enforceSettings();return result;}
    if(channel==='terminal:settings:reset'){const result=await this.settings.reset(args[0] as string[]);this.deviceManagement.enforceSettings();return result;}
    if(channel==='terminal:vault:initialize'){
      await this.secrets.initialize(valueString(args[0]) as 'machine'|'passphrase',args[1]===undefined?undefined:valueString(args[1]));
      await this.auth.initialize();await this.ownerChange;await this.activateOwner();return this.secrets.status();
    }
    if(channel==='terminal:vault:unlock'){await this.secrets.unlock(valueString(args[0]));await this.auth.initialize();await this.ownerChange;await this.activateOwner();return this.secrets.status();}
    if(channel==='terminal:auth:status')return this.auth.snapshot();
    if(channel==='terminal:auth:authorization')return this.authorization;
    if(channel==='terminal:auth:begin')return this.auth.beginLogin();
    if(channel==='terminal:auth:email')return this.auth.discoverEmail(valueString(args[0]));
    if(channel==='terminal:auth:organization')return this.auth.discoverOrganization(valueString(args[0]));
    if(channel==='terminal:auth:realm')return this.auth.confirmRealm(args[0]===true);
    if(channel==='terminal:auth:request-code')return this.auth.requestCode(valueString(args[0]) as 'email'|'phone',valueString(args[1]));
    if(channel==='terminal:auth:captcha-start')return this.auth.startCaptcha(valueString(args[0]) as 'email'|'phone',valueString(args[1]),{lang:this.settings.snapshot().effective.language});
    if(channel==='terminal:auth:captcha-complete')return this.auth.completeCaptcha(valueString(args[0]),valueString(args[1]));
    if(channel==='terminal:auth:memberships')return this.auth.memberships();
    if(channel==='terminal:auth:switch-membership' || channel==='terminal:auth:membership')return this.auth.switchMembership(valueString(args[0]));
    if(channel==='terminal:auth:verify')return this.auth.verifyCode(valueString(args[0]));
    if(channel==='terminal:auth:select')return this.auth.selectAccount(valueString(args[0]));
    if(channel==='terminal:auth:binding-code')return this.auth.requestBindingCode(valueString(args[0]));
    if(channel==='terminal:auth:binding-verify')return this.auth.verifyBinding(valueString(args[0]));
    if(channel==='terminal:auth:sso-code')return this.auth.requestSsoVerificationCode();
    if(channel==='terminal:auth:sso-verify')return this.auth.verifySsoVerification(valueString(args[0]));
    if(channel==='terminal:auth:cancel'){this.authorization=null;return this.auth.cancel();}
    if(channel==='terminal:auth:refresh')return this.auth.refresh();
    if(channel==='terminal:auth:logout' || channel==='terminal:auth:switch') {
      if(this.tasks.isBusy())throw new Error('STOP_RUNNING_TASKS_BEFORE_ACCOUNT_CHANGE');
      return channel==='terminal:auth:logout'?this.auth.logout({all:args[0]===true}):this.auth.switchAccount(valueString(args[0]));
    }
    if(channel==='terminal:auth:authorize'){
      const kind=valueString(args[0]);if(kind!=='sso'&&kind!=='social')throw new Error('INVALID_AUTH_ACTION');
      void this.auth.authorize(kind,valueString(args[1])).catch(()=>logger.warn('AUTHORIZATION_FAILED'));
      return {started:true};
    }
    if(channel==='terminal:devices:list')return this.auth.snapshot().session ? this.remote.listDevices() : [];
    if(channel.startsWith('terminal:devices:') && !['terminal:devices:watch','terminal:devices:unwatch'].includes(channel))
      return this.deviceManagement.invoke(channel.slice('terminal:devices:'.length), args);
    if(channel==='terminal:devices:watch'){
      const id=randomUUID();const peer=valueString(args[0]);const task=args[1]===undefined?undefined:valueString(args[1]);
      const scoped=parseSharedTaskPeer(peer);
      if(scoped&&!task)throw new Error('SHARED_TASK_SESSION_REQUIRED');
      const dispose=await this.remote.subscribe(peer,scoped?[`session:${task}`]:task?['sessions',`session:${task}`]:['sessions']);
      this.subscriptions.set(id,dispose);return {id};
    }
    if(channel==='terminal:devices:unwatch'){const id=valueString(args[0]);this.subscriptions.get(id)?.();this.subscriptions.delete(id);return null;}
    if(channel==='maker:provider:list')return this.groups.decorate(await this.agents.views());
    if (channel.startsWith('model-access:')) {
      if (context.source !== 'local') throw new Error('LOCAL_CONFIGURATION_REQUIRED');
      if (!this.gateway) throw new Error('MODEL_ACCESS_UNAVAILABLE');
      if (channel === 'model-access:get-status') return this.gateway.status();
      if (channel === 'model-access:retry') { await this.gateway.refresh(); return this.gateway.status(); }
      if (channel === 'model-access:rotate') return this.gateway.rotate();
      throw new Error('UNSUPPORTED_CHANNEL');
    }
    if(channel==='terminal:models:add'){
      const value=object(args[0]);const name=valueString(value.name);const model=valueString(value.model);const baseUrl=valueString(value.baseUrl);
      const id=`custom-${randomUUID()}`;
      await this.tasks.models.saveProvider({id,name,auth:{method:value.apiKey?'apiKey':'none'},runtimes:{pi:{baseUrl,wireProtocol:'openai-chat',models:[{id:model,name:model}]}}},{pi:value.apiKey?valueString(value.apiKey):''},true);
      await this.tasks.models.setDefault({agentKind:'pi',providerId:id,model});return {id};
    }
    if(channel==='terminal:models:default'){await this.tasks.models.setDefault(args[0]);return this.tasks.models.snapshot();}
    if(channel==='terminal:models:target-default'){
      const peer=valueString(args[0]);const targets=this.settings.snapshot().overrides.targetModels??{};
      if(args.length<2)return targets[peer]??null;
      const selection=object(args[1]);
      await this.settings.update({targetModels:{...targets,[peer]:selection}});return selection;
    }
    if(channel==='terminal:service:stop'){if((this.tasks.isBusy())&&(!args[0]||object(args[0]).stopTasks!==true))throw new Error('STOP_RUNNING_TASKS_BEFORE_SERVICE_STOP');setImmediate(()=>void this.close());return {stopping:true};}
    if(channel==='terminal:service:inspect')return this.manager.inspect();
    if(channel==='terminal:service:install')return this.manager.install();
    if(channel==='terminal:service:uninstall')return this.manager.uninstall();
    await this.ownerChange;
    if(this.ownerSuspended)throw new Error('ACCOUNT_CHANGE_IN_PROGRESS');
    context.assertCurrent?.();
    if (this.im?.accepts(channel)) {
      if (!local || context.sharedTask) throw new Error('LOCAL_CONFIGURATION_REQUIRED');
      return this.im.invoke(channel, args[0]);
    }
    if(channel==='terminal:files:download'){
      const owner=this.ownerKey,generation=this.ownerGeneration;
      return downloadRemoteFile({files:this.files,media:this.media,invokeRemote:(peer,channel,args)=>this.remote.invoke(peer,channel,args)},args,{...context,assertCurrent:()=>{
        context.assertCurrent?.();if(this.ownerSuspended||this.ownerKey!==owner||this.ownerGeneration!==generation||this.closing)throw new Error('OWNER_CHANGED');
      }});
    }
    if(channel.startsWith('maker:companion-cloud:')){if(!this.companionCloud)throw new Error('COMPANION_CLOUD_NOT_ENABLED');return this.companionCloud.invoke(channel,args);}
    if(channel==='maker:resolve-interaction'&&typeof args[0]==='string'&&this.companions?.hasInteraction(args[0]))return this.companions.resolveInteraction(args[0],args[1],context);
    const companionSession=channel==='local-db:history:messages'&&args[0]&&typeof args[0]==='object'?(args[0] as {sessionId?:unknown}).sessionId:args[0];
    const companionHost=this.companions;
    if(companionHost&&typeof companionSession==='string'&&await companionHost.owns(companionSession))return companionHost.invoke(channel,args,context);
    const result=channel==='device-link:media:fetch'?await fetchMedia(this.browser,this.media,args[0],context,async(url,file,sessionId)=>{
      if(url.startsWith('cindy-media:')){await this.tasks.resolveManaged(url,sessionId);return;}
      const task=await this.tasks.storage.get(sessionId);if(!task)throw new Error('TASK_NOT_FOUND');
      const {realpath}=await import('node:fs/promises');const base=await realpath(task.workDir);
      if(file!==base&&!file.startsWith(base+path.sep))throw new Error('SHARED_TASK_MEDIA_SCOPE_REQUIRED');
    })
      :channel==='terminal:attachments:upload'?await this.media.uploadPath(valueString(args[0]),context)
      :this.scheduler.channels.includes(channel)?await this.scheduler.invoke(channel,args,context)
      :channel.startsWith('maker:file-browser:')||channel.startsWith('fs:')||channel==='file-browser:remote-op'?await this.browser.invoke(channel,args,context)
      :channel.startsWith('maker:remote-resources:')?await this.resources.invoke(channel,args,context):await this.tasks.invoke(channel,args,context);
    context.assertCurrent?.();
    return result;
  }

  close(): Promise<void> {
    if(this.closing)return this.closing;
    // Publish the closing state before cancellation can emit another owner
    // transition. An individual cleanup error must not strand later listeners.
    this.closing=Promise.resolve().then(async()=>{
      this.taskNotifications?.close(); this.taskNotifications = undefined;
      const errors:unknown[]=[];
      const cleanup=async(action:()=>unknown)=>{try{await action();}catch(error){errors.push(error);}};
      await cleanup(()=>this.ownerActivation);
      clearInterval(this.refreshTimer);
      setClaudeRateLimitInfoListener(null);
      await cleanup(() => this.deviceManagement?.close());
      await cleanup(()=>this.desktop?.close());
      await cleanup(()=>this.runtimePaths.directRuntime?.suspend?.());
      await cleanup(()=>this.engineResources?.close());
      await cleanup(()=>this.localModels?.close());
      await cleanup(()=>this.im?.close());
      await cleanup(()=>this.gateway?.close());
      await cleanup(()=>this.providerLogin?.close());
      await cleanup(()=>this.terminals.close());await cleanup(()=>this.remote?.stop());
      await cleanup(()=>this.files?.stop());await cleanup(()=>this.browser?.stop());await cleanup(()=>this.resources?.close());await cleanup(()=>this.membership?.close());
      await cleanup(()=>this.sharedTasks?.close());await cleanup(()=>this.crossShares?.close());await cleanup(()=>this.groupReshare?.stop());await cleanup(()=>this.reshares?.close());
      await cleanup(()=>this.guestRoutes?.close());await cleanup(()=>this.modelGrants?.close());await cleanup(()=>this.agents?.stop());await cleanup(()=>this.groups?.close());await cleanup(()=>this.ssh?.close());
      await cleanup(()=>this.auth?.cancel());await cleanup(()=>this.ownerChange);
      for(const dispose of this.subscriptions.values())await cleanup(dispose);this.subscriptions.clear();
      await cleanup(()=>this.pluginTasks?.close());await cleanup(()=>this.pluginMarket?.close());await cleanup(()=>this.pluginAccount?.close());this.pluginAuthorizations.clear();
      await cleanup(()=>this.plugins?.close());await cleanup(()=>this.routines?.close());await cleanup(()=>this.protectedInput?.close());await cleanup(()=>this.companionCloud?.close());await cleanup(()=>this.companions?.close());
      await cleanup(()=>this.scheduler?.close());await cleanup(()=>this.tasks?.close());await cleanup(()=>this.knowledge?.close());await cleanup(()=>this.projects?.close());await cleanup(()=>this.pluginBrowser.close());
      await cleanup(()=>this.database?.close());this.database=undefined;
      await cleanup(()=>this.secrets.flush());this.secrets.lock();await cleanup(()=>this.transport.close());this.stopWait();
      if(errors.length)throw new AggregateError(errors,'SERVICE_CLOSE_FAILED');
    });
    return this.closing;
  }
}
