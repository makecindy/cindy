import { terminalNodeExecutable } from '../version.js';
import { TerminalPluginEvents, type TerminalPluginEventHost } from './events.js';
import type { TerminalPluginSessions } from './sessions.js';
import path from 'node:path';
import fs from 'node:fs';
import { classifyGhostLocalUpdateSource } from '@cindy/plugin-runtime/ghostLocalUpdateSource';
import { allocateArchiveInstanceKey } from '@cindy/plugin-runtime/store/pluginInstanceRegistry';
import { normalizeGhostWorkdirPrefs } from '@cindy/plugin-runtime/ghostWorkdirPrefs';
import { resolveForgeInstallTarget, ghostInstallTargetContext } from '@cindy/plugin-runtime/ghostInstallTarget';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { NativePluginHost, type NativePluginHostOptions } from '@cindy/plugin-runtime';
import { GhostNetworkSlot, type NetworkSlotDeps } from '@cindy/plugin-runtime/networkSlot';
import { GhostFsSlot, type FsSlotDeps } from '@cindy/plugin-runtime/fsSlot';
import { GhostCardService, withCardToken, type GhostCardServiceDeps } from '@cindy/plugin-runtime/cardService';
import { sanitizeGhostCardHtml } from '@cindy/plugin-runtime/cardSanitizer';
import { createGhostKvStore } from '@cindy/plugin-runtime/ghostKvStore';
import { handleGhostKvRequest, readBoundedBodyText } from '@cindy/plugin-runtime/ghostKvEndpoint';
import { assertGhostInstallConsent, confirmedTaskCapability, type GhostInstallConsentDecision } from '@cindy/plugin-runtime/ghostInstallConsent';
import { evaluateGhostInstallConsent, ghostInstallConsentKey, ghostInstallConsentReceiverIdentity, type GhostInstallConsentFacts } from '@cindy/plugin-runtime/shared/ghostInstallConsent';
import { isValidPluginStoragePart, installedGhostStoragePart, installedGhostPhysicalRelId, findInstalledGhostForDeliveryTarget } from '@cindy/plugin-runtime/shared/pluginIdentity';
import { GHOST_SECRET_VALUE_MAX_CHARS, ghostInstallApprovalToken, type InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import type { TerminalDurableSecrets } from '../contracts.js';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import { TerminalPluginCredentials, type TerminalPluginCredentialOptions } from './credentials.js';
import { GhostSetupChangeBus } from '@cindy/plugin-runtime/ghostSetupChangeBus';
import { evaluateGhostSetupAssessment } from '@cindy/plugin-runtime/ghostSetupStatus';
import { TerminalPluginIdentity } from './identity.js';
import type { TerminalPluginAccount } from './account.js';
import { TerminalPluginLibrary } from './library.js';
import { PluginDownloadSlot, type PluginDownloadDeps } from '@cindy/plugin-runtime/downloadSlot';
import { createDownloader } from '@cindy/plugin-runtime/download/index';
import { fetchSingleHopWithSsrFGuard } from '@cindy/browser-control-runtime/ssrf-runtime';
import { ghostManifestDigest, type PluginMarketInstallationRecord } from '@cindy/plugin-runtime/market/ledger';
import { TerminalPluginModels } from './models.js';
import { ensurePluginTaskApproval } from '@cindy/plugin-runtime/taskCapability';
import type { TerminalModelConfig } from '../models/config.js';
import type { TerminalUtilityModels } from '../models/utility.js';

type Inspected = Exclude<Awaited<ReturnType<NativePluginHost['manager']['inspect']>>, {rejection:unknown}>;
type PendingInstall = {facts:GhostInstallConsentFacts;file:string; inspected:Inspected; decision:GhostInstallConsentDecision; controller:string; expiresAt:number; namespace:string|null; receiver:string|null; installOrigin:'manual'|'agent-forge'; sourceChanged:boolean; record?:PluginMarketInstallationRecord; target:ReturnType<typeof ghostInstallTargetContext>};
export interface TerminalPluginOptions {
  root:string;
  deferStart?:boolean;
  runtimeDirectory:string;
  executablePath:NonNullable<NativePluginHostOptions['web']>['executablePath'];
  secrets:TerminalDurableSecrets;
  assertCurrent():void;
  locale():string;
  changed():void;
  onClose?():void;
  archiveUserState?(from:string,to:string):Promise<void>;
  receive(instance:string,payload:unknown):Promise<unknown>;
  cards:Pick<GhostCardServiceDeps,'persist'|'broadcast'>;
  fs:Pick<FsSlotDeps,'getSessionSnapshot'|'requestWriteConfirm'|'writeSaveDeposit'>;
  network?:Omit<NetworkSlotDeps,'getGhost'|'captureRequestGuard'|'readSecret'>;
  downloadRequest?: PluginDownloadDeps['guardedFetch'];
  credentials?:Partial<TerminalPluginCredentialOptions>;
  account?:TerminalPluginAccount;
  events?: TerminalPluginEventHost;
  models?:{models:TerminalModelConfig;utility:TerminalUtilityModels};
  broker?:NativePluginHostOptions['broker'];
  log?:NativePluginHostOptions['manager']['log'];
}

/** Account-scoped product host. Consent pins the exact package and receiver;
 * the shared manager still owns approval journals, snapshots and atomic updates. */
export class TerminalPlugins {
  readonly native:NativePluginHost;
  readonly events?: TerminalPluginEvents;
  readonly kv:ReturnType<typeof createGhostKvStore>;
  readonly network?:GhostNetworkSlot;
  readonly cards:GhostCardService;
  readonly fs:GhostFsSlot;
  readonly credentials:TerminalPluginCredentials;
  readonly identity:TerminalPluginIdentity;
  readonly library:TerminalPluginLibrary;
  readonly downloads:PluginDownloadSlot;
  readonly models?:TerminalPluginModels;
  private taskSessions?: Pick<TerminalPluginSessions,'receive'|'withUninstall'|'relocate'|'models'>;
  configureTaskSessions(service: Pick<TerminalPluginSessions,'receive'|'withUninstall'|'relocate'|'models'>) { this.guard();this.taskSessions=service; }
  private targets?: Pick<import('./targets.js').TerminalPluginTargets, 'receive'>;
  configureTargets(service: NonNullable<TerminalPlugins['targets']>) { this.guard(); this.targets = service; }
  /** Invoked only by the owner resource action after its permission confirmation. */
  async approveTaskCapability(id: string, revision: string, capability: 'tasks' | 'targets', current: () => void) {
    return this.mutate(async () => {
      const ghost = await this.get(id);
      const active = () => {
        try { this.guard(); current(); const now = this.installed(id); return now?.dir === ghost.dir &&
          now?.approval.state === 'approved' && now.approval.revision === revision; } catch { return false; }
      };
      if (!active()) throw new Error('PLUGIN_CHANGED');
      const approved = await ensurePluginTaskApproval(id, {
        getGhost: key => this.installed(key), isCurrent: active, confirm: async () => active(),
        approve: (key, expected, valid) => this.native.manager.approveTaskCapability(key, expected, valid, capability),
      }, capability);
      if (!approved) throw new Error('PERMISSION_DENIED');
      await this.native.refresh();
    });
  }
  async start(){await this.ready;this.guard();await this.native.start();this.guard();}
  readonly setupChanges=new GhostSetupChangeBus();
  private readonly pending = new Map<string,PendingInstall>();
  private readonly removing=new Set<string>();
  private readonly cleanup = new Map<string,string[]>();
  private closed=false;
  private revision=0;
  private mutations:Promise<unknown>=Promise.resolve();
  readonly ready:Promise<void>;
  constructor(private readonly options:TerminalPluginOptions) {
    this.identity=new TerminalPluginIdentity(options.root,()=>this,options.account,()=>this.guard());
    this.credentials=new TerminalPluginCredentials(this,{
      fetchImpl:fetch,openExternal:async()=>{throw new Error('PLUGIN_AUTHORIZATION_CONTROLLER_REQUIRED');},
      confirmAddHost:async()=>false,getLoginEmail:()=>null,...options.credentials,
      broker:options.account?.broker,resolveBrokerPublicUrl:route=>options.account?.brokerPublicUrl(route)??null,
      isTokenBrokerAuthorized:id=>this.identity.brokerAllowed(id),isHostPrimitiveAuthorized:id=>this.identity.hostAllowed(id),
    });
    this.kv=createGhostKvStore({getRootDir:()=>path.join(options.root,'plugin-kv'),log:options.log});
    const getGhost=(id:string)=>{this.guard();return this.native.list().find(ghost=>installedGhostStoragePart(ghost)===id)??null;};
    if(options.models)this.models=new TerminalPluginModels({...options.models,root:options.root,installed:getGhost,taskModels:()=>this.taskSessions?.models()??Promise.resolve([]),guard:()=>this.guard(),changed:()=>{this.revision++;options.changed();}});
    this.library=new TerminalPluginLibrary({root:options.root,runtimeDirectory:options.runtimeDirectory,getGhost,current:()=>this.current(),log:options.log});
    this.downloads=new PluginDownloadSlot({getGhost,root:id=>path.join(options.root,'plugin-downloads',id),
      scope:()=>{this.guard();return options.root;},send:(id,event)=>{if(this.current())this.native.web?.send(id,event);},
      download:createDownloader(),guardedFetch:options.downloadRequest??((url,init,beforeDispatch)=>
        fetchSingleHopWithSsrFGuard({url,init,signal:init.signal??undefined,requireHttps:true,beforeDispatch})),
    });
    this.cards=new GhostCardService({...options.cards,sanitize:sanitizeGhostCardHtml,
      hasCardSlot:id=>{const ghost=getGhost(id);return !!ghost?.enabled&&ghost.approval?.state==='approved'&&ghost.manifest.card!==undefined;},
      log:{debug:(message,meta)=>options.log?.info(message,meta),warn:(message,meta)=>options.log?.warn(message,meta)},
    });
    this.fs=new GhostFsSlot({...options.fs,getGhost,dataRootDir:()=>path.join(options.root,'plugin-fs'),
      callInfo:id=>this.cards.callInfoOf(id),inFlightCallInfo:id=>this.cards.inFlightCallInfoOf(id),log:options.log});
    if(options.network)this.network=new GhostNetworkSlot({...options.network,
      ...(options.account?{connectionTokens:{resolve:(id:string)=>this.identity.connection(id),getToken:(input:{membershipId:string;audience:string})=>options.account!.tokens.getToken(input),invalidate:(input:{membershipId:string;audience:string})=>options.account!.tokens.invalidate(input)}}:{}),
      oauthTokens:this.credentials.oauth,
      connections:{hostsFor:id=>this.credentials.hostsFor(id),tokenFor:(id,host)=>this.credentials.tokenFor(id,host)},
      getGhost,inFlightCallInfo:id=>this.cards.inFlightCallInfoOf(id),
      readSecret:(id,key)=>this.readSecret(id,key),
      captureRequestGuard:id=>{
        this.guard();const previous=this.native.list().find(ghost=>installedGhostStoragePart(ghost)===id);
        const approval=ghostInstallApprovalToken(previous?.approval);
        return ()=>{this.guard();const current=this.native.list().find(ghost=>installedGhostStoragePart(ghost)===id);if(!current?.enabled||current.approval?.state!=='approved'||current.dir!==previous?.dir||ghostInstallApprovalToken(current.approval)!==approval)throw new Error('PLUGIN_CHANGED');};
      }});
    this.native=new NativePluginHost({
      deferStart:options.deferStart,
      manager:{getRootDir:()=>path.join(options.root,'plugins'),getStateDir:()=>path.join(options.root,'plugin-approvals'),
        onArchiveSourceState:(from,to)=>this.archiveSourceState(from,to),
        getOwnerContextKey:()=>{this.guard();return options.root;},getLocale:options.locale,log:options.log,
        onChanged:ghosts=>{this.events?.reconcile(ghosts);this.revision++;for(const ghost of ghosts)this.setupChanges.emit(installedGhostStoragePart(ghost),{source:'manifest'});options.changed();}},
      node:{nodePath:terminalNodeExecutable(),workerPath:path.join(options.runtimeDirectory,'plugin-node-worker.cjs'),snapshotWorkerPath:path.join(options.runtimeDirectory,'plugin-snapshot-worker.cjs')},
      withNodeRequest:(id,payload,run)=>payload&&typeof payload==='object'&&!Array.isArray(payload)
        ?this.downloads.withNodeDownloads(id,payload as Record<string,unknown>,run,()=>this.current()):run(payload),
      broker:{...options.broker,log:options.log,ownerScope:{capture:()=>{this.guard();return this;},isCurrent:value=>value===this&&this.current(),isStable:()=>this.current()},
        resolveOauthSecret:(id,key,account)=>this.credentials.resolveOauthSecret(id,key,account),
        readSecret:(id,key)=>this.readSecret(id,key),secretSaved:async(id,key)=>(await this.readSecret(id,key))!==null},
      web:{executablePath:options.executablePath,mailRuntimeSource:()=>readFile(path.join(options.runtimeDirectory,'plugin-mail-runtime.js'),'utf8'),
        receive:(id,payload)=>this.receive(id,payload),
        request:(id,request,current)=>this.settingsRequest(id,request,current)},
    });
    if(options.events)this.events=new TerminalPluginEvents(this.native,options.events);
    this.ready=this.open();
  }
  /** Only the native sandbox supplies the bound instance, never payload JSON. */
  async settingsRequest(id:string,request:Request,current:()=>boolean,confirmConnection?:(label:string,host:string)=>Promise<boolean>):Promise<Response|null>{
    this.guard();
    if(new URL(request.url).pathname!=='/kv')return this.credentials.request(id,request,()=>this.current()&&current(),confirmConnection);
    const outcome=await handleGhostKvRequest({method:request.method,readBodyText:()=>readBoundedBodyText(request),store:this.kv,ghostId:id,isCurrent:()=>this.current()&&current(),log:this.options.log});
    if(request.method!=='GET'&&outcome.status<300)this.credentialsChanged(id,'kv');
    return new Response(outcome.body??null,{status:outcome.status,headers:{'Content-Type':'application/json'}});
  }
  async receive(id:string,payload:unknown):Promise<unknown>{
    this.guard();const type=(payload as {type?:unknown}|null)?.type;
    if(type==='event-verdict'&&this.events){this.events.gateway.handleVerdict(id,payload);return {ok:true};}
    if(type==='tasks-request'&&this.taskSessions)return this.taskSessions.receive(id,payload);
    if(type==='targets-request'&&this.targets)return this.targets.receive(id,payload);
    if(type==='fetch-request'&&this.network)return this.network.handleFetchRequest(id,payload);
    if(type==='fs-request')return this.fs.handleFsRequest(id,payload);
    if(type==='library-request')return this.library.slot.handleLibraryRequest(id,payload);
    if(type==='download-request')return this.downloads.handle(id,payload,()=>this.current());
    if(type==='card-update'){this.cards.handleCardUpdate(id,payload);return {ok:true};}
    if((type==='cindy-request'||type==='model-request')&&(payload as {kind?:unknown}).kind==='oneshot_text'&&this.models)return this.models.receive(id,payload);
    return this.options.receive(id,payload);
  }
  private async open() {
    for(const directory of ['plugins','plugin-approvals','plugin-kv','plugin-fs'])await privateDirectory(path.join(this.options.root,directory));
    this.guard();await this.native.open(()=>{
      this.guard();this.identity.recover();
      for(const ghost of this.native.list())this.credentials.reconcile(installedGhostStoragePart(ghost),ghost.manifest);
    });this.guard();this.events?.reconcile();
    const pending=await readPrivateFile(path.join(this.options.root,'plugin-cleanup.json'));this.guard();
    if(pending){
      const rows:unknown=JSON.parse(pending.toString());
      if(!Array.isArray(rows)||rows.some(row=>!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!isValidPluginStoragePart(row[0])||!Array.isArray(row[1])||row[1].some((key:unknown)=>typeof key!=='string'||key.length>512)))throw new Error('PLUGIN_CLEANUP_INVALID');
      for(const [id,keys] of rows)this.cleanup.set(id,keys);
      // A crash before package removal must not erase a still-installed plugin.
      for(const ghost of this.native.list())this.cleanup.delete(installedGhostStoragePart(ghost));
      await this.persistCleanup();
      await this.retryCleanup().catch(()=>optionsCleanupPending(this.options));
    }
  }
  private current(){try{this.guard();return true;}catch{return false;}}
  private guard(){if(this.closed)throw new Error('PLUGIN_HOST_CLOSED');this.options.assertCurrent();}
  version(){return String(this.revision);}
  installed(id:string){this.guard();return this.native.list().find(ghost=>installedGhostStoragePart(ghost)===id)??null;}
  credentialsChanged(id?:string,source:'secret'|'kv'='secret'){
    this.guard();this.revision++;
    for(const instance of id?[id]:this.native.list().map(installedGhostStoragePart))this.setupChanges.emit(instance,{source});
    this.options.changed();
  }
  assessment(id:string){
    const ghost=this.installed(id);if(!ghost)throw new Error('PLUGIN_NOT_FOUND');
    const values=this.kv.readStrict(id);
    return evaluateGhostSetupAssessment(ghost.manifest,{
      secretSaved:key=>this.readSecretSync(id,key)!==null,
      oauthStatus:key=>{const decl=ghost.manifest.network?.secrets?.find(secret=>secret.key===key)?.oauth;const accounts=this.credentials.oauth.listAccounts(id,key,decl);return {clientConfigured:this.credentials.oauth.clientConfigured(id,key,decl),connected:accounts.filter(account=>account.status==='connected').length,expired:accounts.filter(account=>account.status==='expired').length};},
      connectionCount:key=>this.credentials.connections.list(id,key).length,
      kvValue:key=>values[key],
    },{revision:this.setupChanges.currentRevision(id)});
  }
  withCredentialMutation<T>(id:string,action:()=>Promise<T>|T):Promise<T>{
    return this.mutate(async()=>{if(this.removing.has(id)||!this.installed(id))throw new Error('PLUGIN_CHANGED');return action();});
  }
  setModel(id:string,pin:unknown,current?:()=>void){
    return this.mutate(async()=>{
      const ghost=this.installed(id);
      if(!ghost||this.removing.has(id))throw new Error('PLUGIN_CHANGED');
      if(!this.models||!(ghost.manifest.agent?.tasks||ghost.manifest.cindy?.text?.includes('oneshot')))throw new Error('INVALID_ACTION');
      await this.models.setModel(id,pin,current);
    });
  }
  taskSettings(id:string,revision:string,input?:Record<string,unknown>,current:()=>void=()=>{}){
    const run=()=>{
      this.guard();current();const ghost=this.installed(id);
      if(!ghost||this.removing.has(id)||!this.models)throw new Error('PLUGIN_CHANGED');
      const identity=JSON.stringify([ghost.dir,ghostInstallApprovalToken(ghost.approval)]);
      return this.models.taskSettings(id,revision,input,()=>{
        this.guard();current();const next=this.installed(id);
        if(!next||this.removing.has(id)||JSON.stringify([next.dir,ghostInstallApprovalToken(next.approval)])!==identity)throw new Error('PLUGIN_CHANGED');
      });
    };
    return input===undefined?run():this.mutate(run);
  }
  preferences(id:string,ghost:InstalledGhost,sidebar:import('./preferences.js').TerminalPluginPreferences,input?:Record<string,unknown>,current:()=>void=()=>{}){
    const run=()=>{
      const check=()=>{this.guard();current();const next=this.installed(id);if(!next||this.removing.has(id)||next.dir!==ghost.dir||ghostInstallApprovalToken(next.approval)!==ghostInstallApprovalToken(ghost.approval))throw new Error('PLUGIN_CHANGED');};
      check();if(!this.models)throw new Error('PLUGIN_CHANGED');
      return this.models.preferences(id,ghost,sidebar,input,check);
    };
    return input===undefined?run():this.mutate(run);
  }
  setWorkdirDisabled(preferences:import('./preferences.js').TerminalPluginPreferences,workdir:string,id:string,disabled:boolean,current:()=>void){
    return this.mutate(async()=>{current();await preferences.set(workdir,id,disabled,current);});
  }
  setTaskPermission(id:string,mode:unknown,current:()=>void=()=>{}){
    return this.mutate(async()=>{
      const ghost=this.installed(id);
      if(!ghost||this.removing.has(id))throw new Error('PLUGIN_CHANGED');
      if(!this.models||!ghost.manifest.agent?.tasks)throw new Error('INVALID_ACTION');
      await this.models.setPermissionPreference(id,mode,current);
    });
  }
  async list(){await this.ready;this.guard();await this.native.refresh();this.guard();return this.native.list();}
  async get(id:string){const ghost=(await this.list()).find(item=>installedGhostStoragePart(item)===id);if(!ghost)throw new Error('PLUGIN_NOT_FOUND');return ghost;}
  async callTool(id:string,request:{tool:string;args:Record<string,unknown>;signal?:AbortSignal;agentToolUseId?:string},context:{sessionId:string;sessionInstanceId:string;remoteHostId:string|null;assertCurrent():void}){
    await this.get(id);context.assertCurrent();this.guard();
    const callId=randomUUID();
    this.cards.registerCall(callId,{ghostId:id,sessionId:context.sessionId,sessionInstanceId:context.sessionInstanceId,remoteHostId:context.remoteHostId,toolUseId:request.agentToolUseId??null});
    try {
      const result=await this.native.dispatcher!.callGhostTool({ghostId:id,tool:request.tool,args:request.args,signal:request.signal,callId,sessionId:context.sessionId});
      context.assertCurrent();this.guard();
      return withCardToken(result,this.cards.hasCard(callId),callId);
    }finally{this.cards.finalizeCall(callId);}
  }
  private key(id:string,key:string){return `plugin:${id}:${key}`;}
  private async readSecret(id:string,key:string){
    return this.readSecretSync(id,key);
  }
  readSecretSync(id:string,key:string){this.guard();return this.options.secrets.getSync(this.key(id,key));}
  secretTailSync(id:string,key:string){
    this.guard();const tailKey=`plugin-tail:${id}:${key}`;
    const tail=this.options.secrets.getSync(tailKey);if(tail!==null)return tail;
    const value=this.readSecretSync(id,key);if(!value||value.length<4)return null;
    const migrated=value.slice(-4);this.options.secrets.setSync(tailKey,migrated);return migrated;
  }
  async saveSecret(id:string,key:string,value:string,expectedApproval?:string,assertCurrent:()=>void=()=>{}){
    if(typeof value!=='string'||value.length>GHOST_SECRET_VALUE_MAX_CHARS)throw new Error('PLUGIN_SECRET_INVALID');
    await this.mutate(async()=>{
      const ghost=await this.get(id);
      assertCurrent();
      if(expectedApproval!==undefined&&ghostInstallApprovalToken(ghost.approval)!==expectedApproval)throw new Error('PLUGIN_CHANGED');
      const declared=ghost.manifest.node?.secretBindings?.some(binding=>binding.key===key&&!binding.oauthSecret)||ghost.manifest.network?.secrets?.some(secret=>secret.key===key&&['user','gh-cli'].includes(secret.source??'user'));
      if(!declared)throw new Error('PLUGIN_SECRET_NOT_DECLARED');
      this.guard();
      await this.writeSecret(id,key,value);
      this.credentialsChanged(id);
    });
  }
  async prepareInstall(file:string,controller:string,targetOptions:Parameters<typeof resolveForgeInstallTarget>[3]&{installOrigin?:'agent-forge'}={},currentNamespace:string|null=null,record?:PluginMarketInstallationRecord) {
    await this.ready;this.guard();
    if(!path.isAbsolute(file))throw new Error('PLUGIN_PACKAGE_PATH_REQUIRED');
    for(const [id,pending] of this.pending)if(pending.expiresAt<Date.now())this.pending.delete(id);
    if(this.pending.size>=32)throw new Error('PLUGIN_CONFIRMATION_LIMIT');
    const inspected=await this.native.manager.inspect(file);this.guard();
    if('rejection' in inspected)throw new Error('PLUGIN_PACKAGE_REJECTED',{cause:inspected.rejection});
    const ghosts=await this.list();
    const {installed,namespace}=resolveForgeInstallTarget(ghosts,inspected.manifest.id,currentNamespace,targetOptions);
    const installOrigin:'manual'|'agent-forge'=targetOptions.installOrigin??'manual';
    if(record){
      if(record.ghostId!==inspected.manifest.id||record.namespace!==namespace||record.sha256!==inspected.packageSha256||record.version!==inspected.manifest.version)throw new Error('PLUGIN_MARKET_PACKAGE_MISMATCH');
      record={...record,manifestDigest:ghostManifestDigest(inspected.releasedLegacyDigestFormat),rawManifestSha256:inspected.rawManifestSha256};
    }
    this.identity.assertInstall({manifest:inspected.manifest,packageSha256:inspected.packageSha256,namespace,installOrigin,record});
    const sourceChanged=installed?this.sourceChanged(installed,inspected,installOrigin,record):false;
    const target=ghostInstallTargetContext(ghosts,inspected.manifest.id,namespace,installed,sourceChanged);
    const facts=evaluateGhostInstallConsent(installed,inspected.manifest,true)!;
    const decision:GhostInstallConsentDecision={mode:'confirmed',forced:true,key:ghostInstallConsentKey(facts,inspected.packageSha256,ghostInstallConsentReceiverIdentity(installed))};
    const id=randomUUID();const pending={facts,file,inspected,decision,controller,expiresAt:Date.now()+15*60_000,namespace,installOrigin,sourceChanged,record,receiver:installed?installedGhostStoragePart(installed):null,target};
    this.pending.set(id,pending);
    return {id,facts,target,packageSha256:inspected.packageSha256,expiresAt:pending.expiresAt};
  }
  private sourceChanged(installed:InstalledGhost,inspected:Inspected,origin:'manual'|'agent-forge',record?:PluginMarketInstallationRecord){
    const previous=installed.approval?.state==='approved'?this.native.manager.readApprovedInstallReceipt(installedGhostStoragePart(installed),installed.approval.revision):null;
    const existing=this.identity.record(installed);
    if(record)return !existing?.installed||existing.pluginId!==record.pluginId||existing.source!==record.source||existing.serverRoot!==record.serverRoot;
    return classifyGhostLocalUpdateSource({existingSourceChanged:existing?.installed===true||(previous?.installOrigin??'manual')!==origin,previousApprovedReceipt:previous,inspectedPackage:{ghostId:inspected.manifest.id,namespace:installed.namespace??null,packageSha256:inspected.packageSha256,trust:inspected.trust}}).sourceChanged;
  }
  /** The manager's durable package journal retries this idempotent move after a
   * crash, and invokes it in reverse if the new receipt cannot be committed. */
  private async archiveSourceState(from:string,to:string){
    this.guard();this.credentials.oauth.invalidateGhost(from);this.credentials.oauth.invalidateGhost(to);
    await this.downloads.cancelPlugin(from);await this.downloads.cancelPlugin(to);
    await this.library.slot.invalidateGhost(from);await this.library.slot.invalidateGhost(to);
    const moves=['plugin-kv','plugin-fs','libraries','library-staging','plugin-downloads'].map(dir=>({from:path.join(this.options.root,dir,from+(dir==='plugin-kv'?'.json':'')),to:path.join(this.options.root,dir,to+(dir==='plugin-kv'?'.json':''))}));
    for(const move of moves)if(fs.existsSync(move.from)&&fs.existsSync(move.to))throw new Error('PLUGIN_ARCHIVE_COLLISION');
    for(const move of moves){this.guard();if(!fs.existsSync(move.from))continue;fs.mkdirSync(path.dirname(move.to),{recursive:true});fs.renameSync(move.from,move.to);}
    await this.library.archive(from,to,()=>this.guard());
    const keys=this.storedSecretKeys(from);
    if(keys.length){
      if(this.storedSecretKeys(to).length)throw new Error('PLUGIN_ARCHIVE_COLLISION');
      const entries:Record<string,string|null>=Object.create(null);
      for(const key of keys)for(const [source,target] of [[this.key(from,key),this.key(to,key)],[`plugin-tail:${from}:${key}`,`plugin-tail:${to}:${key}`]]){entries[target]=this.options.secrets.getSync(source);entries[source]=null;}
      entries[this.secretIndex(to)]=JSON.stringify(keys);entries[this.secretIndex(from)]=null;
      this.options.secrets.setManySync(entries);
    }
    const file=path.join(this.options.root,'ghost-workdir-prefs.json'),bytes=await readPrivateFile(file);this.guard();
    if(bytes){const prefs=normalizeGhostWorkdirPrefs(JSON.parse(bytes.toString()));for(const key of Object.keys(prefs.disabledByWorkdir))prefs.disabledByWorkdir[key]=[...new Set(prefs.disabledByWorkdir[key].map(id=>id===from?to:id))];await atomicPrivateWrite(file,JSON.stringify(prefs));}
    const sidebarFile=path.join(this.options.root,'ghost-sidebar-prefs.json'),sidebar=await readPrivateFile(sidebarFile);this.guard();
    if(sidebar){const hidden:unknown=JSON.parse(sidebar.toString());if(!Array.isArray(hidden)||hidden.some(id=>typeof id!=='string'))throw new Error('PLUGIN_PREFERENCES_INVALID');await atomicPrivateWrite(sidebarFile,JSON.stringify([...new Set(hidden.map(id=>id===from?to:id))]));}
    this.guard();await this.cards.relocateGhost(from,to);this.guard();await this.models?.relocate(from,to);this.guard();await this.taskSessions?.relocate(from,to);this.guard();await this.options.archiveUserState?.(from,to);this.guard();
  }
  pendingFor(controller:string){this.guard();return [...this.pending].filter(([,p])=>p.controller===controller&&p.expiresAt>=Date.now()).map(([id,p])=>({id,facts:p.facts}));}
  pendingInstall(id:string,controller:string){
    this.guard();const pending=this.pending.get(id);
    if(!pending||pending.controller!==controller||pending.expiresAt<Date.now())throw new Error('PLUGIN_CONFIRMATION_EXPIRED');
    return pending;
  }
  async confirmInstall(id:string,controller:string,assertCurrent:()=>void=()=>{}) {
    const pending=this.pendingInstall(id,controller);this.pending.delete(id);
    return this.mutate(async()=>{
      const {inspected,decision}=pending;
      await this.retryCleanup();
      this.identity.recover();
      const installed=findInstalledGhostForDeliveryTarget(await this.native.manager.listAsync(),{ghostId:inspected.manifest.id,namespace:pending.namespace});
      const check=()=>{this.guard();assertCurrent();const receiver=findInstalledGhostForDeliveryTarget(this.native.manager.list(),{ghostId:inspected.manifest.id,namespace:pending.namespace});if((receiver?installedGhostStoragePart(receiver):null)!==pending.receiver||Boolean(receiver&&this.sourceChanged(receiver,inspected,pending.installOrigin,pending.record))!==pending.sourceChanged)throw new Error('PLUGIN_CHANGED');assertGhostInstallConsent(decision,receiver,inspected.manifest,inspected.packageSha256);this.identity.assertInstall({manifest:inspected.manifest,packageSha256:inspected.packageSha256,namespace:pending.namespace,installOrigin:pending.installOrigin,record:pending.record});};
      check();
      const approvals={taskCapabilityApproved:confirmedTaskCapability(decision,installed,inspected.manifest),targetCapabilityApproved:confirmedTaskCapability(decision,installed,inspected.manifest,'targets')};
      if(installed){const instance=installedGhostStoragePart(installed);this.native.runtime?.stop(instance);await this.native.node.stopAndWait(instance);await this.downloads.cancelPlugin(instance);await this.library.slot.invalidateGhost(instance);check();}
      this.identity.begin(inspected.manifest.id,pending.namespace,inspected.packageSha256,installed??null,pending.record);
      const result=installed
        // The manager pins the previous receipt and package hash under its
        // mutation lock. This callback runs after swapping directories, when
        // reading the installed list no longer describes the old receiver.
        ? await this.native.manager.update(pending.file,{...approvals,namespace:pending.namespace,installOrigin:pending.installOrigin,...(pending.sourceChanged?{sourceStateArchiveId:allocateArchiveInstanceKey()}:{}),expectedPackageSha256:inspected.packageSha256,expectedInstalledApproval:ghostInstallApprovalToken(installed.approval),beforePackageCommit:()=>{this.guard();assertCurrent();if(!pending.sourceChanged)return this.credentials.prepareUpdate(installedGhostStoragePart(installed),installed.manifest,inspected.canonicalManifest);}})
        : await this.native.manager.install(pending.file,{...approvals,namespace:pending.namespace,installOrigin:pending.installOrigin,...(pending.record?{registrySource:pending.record.source==='market'?'market' as const:'manual' as const,pluginId:pending.record.pluginId}:{}),expectedPackageSha256:inspected.packageSha256,beforePackagePlacement:check});
      if('rejection' in result)throw new Error('PLUGIN_INSTALL_REJECTED',{cause:result.rejection});
      this.identity.recover();
      await this.native.refresh();return result.ghost;
    });
  }
  cancelInstall(id:string,controller:string){this.pendingInstall(id,controller);this.pending.delete(id);}
  async changeLibrary(id:string,revision:string,operation:'relocate'|'default'|'trash',candidate?:string,assertCurrent:()=>void=()=>{}){
    return this.mutate(async()=>{
      const current=await this.library.overview(id);assertCurrent();
      if(current.revision!==revision)throw new Error('PLUGIN_LIBRARY_CHANGED');
      this.native.runtime?.stop(id);await this.native.node.stopAndWait(id);this.guard();assertCurrent();
      try{await this.library.change(id,operation,candidate,()=>{this.guard();assertCurrent();});}
      finally{await this.native.refresh();}
    });
  }
  async setEnabled(id:string,enabled:boolean,approval?:string,current:()=>void=()=>{}) {
    return this.mutate(async()=>{const ghost=await this.get(id);current();const result=await this.native.manager.setEnabled(installedGhostPhysicalRelId(ghost),enabled,approval??ghostInstallApprovalToken(ghost.approval),()=>{this.guard();current();});if('rejection' in result)throw new Error('PLUGIN_CHANGE_REJECTED');if(!enabled){await this.downloads.cancelPlugin(id);await this.library.slot.invalidateGhost(id);}await this.native.refresh();});
  }
  private secretIndex(id:string){return `plugin-key-index:${id}`;}
  private storedSecretKeys(id:string):string[] {
    this.guard();const raw=this.options.secrets.getSync(this.secretIndex(id));
    if(!raw)return [];
    const keys:unknown=JSON.parse(raw);
    if(!Array.isArray(keys)||keys.some(key=>typeof key!=='string'||key.length>512))throw new Error('PLUGIN_SECRET_INDEX_INVALID');
    return keys;
  }
  /** Host-owned credential adapters also use this entry for derived OAuth keys. */
  async writeSecret(id:string,key:string,value:string|null):Promise<void>{
    this.writeSecretSync(id,key,value);
  }
  writeSecretSync(id:string,key:string,value:string|null){
    const current=()=>{this.guard();if(this.removing.has(id)||this.cleanup.has(id)||!this.native.list().some(ghost=>installedGhostStoragePart(ghost)===id))throw new Error('PLUGIN_CHANGED');};
    current();if(!isValidPluginStoragePart(id)||!key||key.length>512)throw new Error('PLUGIN_SECRET_INVALID');
    const keys=new Set(this.storedSecretKeys(id));
    if(value!==null){
      keys.add(key);this.options.secrets.setSync(this.secretIndex(id),JSON.stringify([...keys]));current();
      this.options.secrets.setSync(this.key(id,key),value);
      if(value.length>=4)this.options.secrets.setSync(`plugin-tail:${id}:${key}`,value.slice(-4));
      else this.options.secrets.deleteSync(`plugin-tail:${id}:${key}`);
    }else{
      this.options.secrets.deleteSync(this.key(id,key));this.guard();keys.delete(key);
      this.options.secrets.deleteSync(`plugin-tail:${id}:${key}`);
      this.options.secrets.setSync(this.secretIndex(id),JSON.stringify([...keys]));
    }
    this.guard();
  }
  private persistCleanup(){return atomicPrivateWrite(path.join(this.options.root,'plugin-cleanup.json'),JSON.stringify([...this.cleanup]));}
  private async retryCleanup(){
    for(const [id,keys] of this.cleanup){
      this.guard();
      if(!this.native.list().some(ghost=>installedGhostStoragePart(ghost)===id)){
        this.identity.finishRemoval(id);
        const removed=await Promise.allSettled([Promise.resolve().then(()=>this.kv.remove(id)),rm(path.join(this.options.root,'plugin-fs',id),{recursive:true,force:true}),...keys.flatMap(key=>[this.options.secrets.delete(this.key(id,key)),this.options.secrets.delete(`plugin-tail:${id}:${key}`)])]);
        if(removed.some(result=>result.status==='rejected'))throw new Error('PLUGIN_REMOVE_CLEANUP_FAILED');
        this.guard();await this.options.secrets.delete(this.secretIndex(id));this.guard();
      }
      this.cleanup.delete(id);
      try{await this.persistCleanup();}catch(error){this.cleanup.set(id,keys);throw error;}
    }
  }
  async uninstall(id:string,current:()=>void=()=>{}) {
    if(this.taskSessions)return this.taskSessions.withUninstall(id,async()=>{current();await this.removeInstalled(id,current);});
    return this.removeInstalled(id,current);
  }
  private async removeInstalled(id:string,current:()=>void) {
    return this.mutate(async()=>{
      const ghost=await this.get(id);current();this.removing.add(id);
      this.credentials.oauth.invalidateGhost(id);
      try{
      this.native.runtime?.stop(id);await this.native.node.stopAndWait(id);this.guard();
      await this.library.slot.invalidateGhost(id);
      const keys=new Set([...this.storedSecretKeys(id),...(ghost.manifest.node?.secretBindings??[]).map(binding=>binding.key),...(ghost.manifest.network?.secrets??[]).map(secret=>secret.key)]);
      this.cleanup.set(id,[...keys]);await this.persistCleanup();this.guard();
      let result:Awaited<ReturnType<typeof this.native.manager.uninstall>>;
      try{result=await this.native.manager.uninstall(installedGhostPhysicalRelId(ghost),{assertCurrent:()=>{this.guard();current();}});}
      catch(error){this.cleanup.delete(id);await this.persistCleanup();await this.native.refresh();throw error;}
      if('rejection' in result){this.cleanup.delete(id);await this.persistCleanup();throw new Error('PLUGIN_REMOVE_REJECTED');}
      await this.downloads.removePlugin(id);
      try{await this.library.orphan(id,ghost.manifest.name);}catch{this.options.log?.warn('Plugin library orphan marker remains unchanged');}
      this.identity.removed(ghost);
      await this.native.refresh();
      try{await this.retryCleanup();}catch{throw new Error('PLUGIN_REMOVE_CLEANUP_FAILED');}
      }finally{this.removing.delete(id);}
    });
  }
  private async mutate<T>(action:()=>Promise<T>):Promise<T> {
    await this.ready;const next=this.mutations.then(async()=>{this.guard();const value=await action();this.guard();this.revision++;this.options.changed();return value;});this.mutations=next.catch(()=>{});return next;
  }
  private closing?:Promise<void>;
  close(){
    if(this.closing)return this.closing;
    this.events?.close();this.credentials.close();this.closed=true;this.downloads.abortAll();this.options.onClose?.();this.pending.clear();
    return this.closing=(async()=>{await this.models?.close();await this.ready.catch(()=>{});await this.mutations;try{await this.native.close();}finally{await this.downloads.stopAndWait();await this.library.close();await this.cards.flushWrites();}})();
  }
}

function optionsCleanupPending(options:TerminalPluginOptions){options.log?.warn('Plugin removal cleanup remains pending');}
