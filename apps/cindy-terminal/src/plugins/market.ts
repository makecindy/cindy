import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { fetchWithSsrFGuard, type GuardedFetchOptions, type GuardedFetchResult } from '@cindy/browser-control-runtime/ssrf-runtime';
import { MAX_NODE_CINDY_FILE_BYTES } from '@cindy/plugin-runtime/store/ghostManager';
import { downloadIdentityMatchesPlugin, installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import type { PluginMarketInstallationRecord } from '@cindy/plugin-runtime/market/ledger';
import { buildGhostInstallConsentInteraction, type HostPermissionRequester } from '@cindy/plugin-runtime/ghostInstallConsentInteraction';
import type { CindyGhostsMcpDeps } from 'cindy-tools';
import type { RemoteResourceRegistry, RemoteLocalizedText } from '@cindy/device-link';
import type { TerminalPlugins } from './host.js';
import type { TerminalPluginAccount } from './account.js';
import type { PluginTaskContext } from './permissions.js';
import { privateDirectory } from '../platform.js';
import { ghostInstallApprovalToken, validateNormalizedGhostManifest } from '@cindy/plugin-runtime/shared/ghost';
import type { PluginMarketItem, PluginMarketSnapshot, PluginMarketDetail, PluginMarketInstallOptions } from '@cindy/plugin-runtime/shared/pluginMarket';
import type { GhostInstallConsentPrompt } from '@cindy/plugin-runtime/ghostInstallConsent';
import { readInstalledGhostManifestSnapshot } from '@cindy/plugin-runtime/store/installedGhostManifest';
import { installedMarketManifestIdentity } from '@cindy/plugin-runtime/market/installedManifestIdentity';
import { verifyInstalledMarketManifest } from '@cindy/plugin-runtime/market/installedManifestIdentity';

const words={title:['Plugin market','插件市场','外掛市場','プラグインマーケット','플러그인 마켓'],install:['Install','安装','安裝','インストール','설치'],update:['Update','更新','更新','更新','업데이트']} as const;
const label=(key:keyof typeof words):RemoteLocalizedText=>{const [en,cn,tw,ja,ko]=words[key];return {fallback:en,translations:{en,'zh-CN':cn,'zh-TW':tw,ja,ko}};};
const ref=(id:string)=>({collectionId:'plugin-market',kind:'market-plugin',id});

/** The signed-in catalog is metadata only. Every install rechecks the actual
 * archive, exact release, delivery namespace and permission receipt. */
export class TerminalPluginMarket {
  private readonly abort=new AbortController();
  private readonly directory:string;
  private readonly files=new Map<string,{file:string;expiresAt:number}>();
  constructor(private readonly options:{root:string;host:TerminalPlugins;account:TerminalPluginAccount;assertCurrent():void;download?:(options:GuardedFetchOptions)=>Promise<GuardedFetchResult>}){
    this.directory=path.join(options.root,'plugin-market','downloads');
  }
  private guard(){this.abort.signal.throwIfAborted();this.options.assertCurrent();}
  async list(query?:string){this.guard();const catalog=await this.options.account.catalog(query);this.guard();return catalog;}
  private item(plugin:Awaited<ReturnType<TerminalPluginAccount['catalog']>>['plugins'][number]):PluginMarketItem {
    const ghost=this.options.host.native.list().find(item=>item.manifest.id===plugin.ghostId&&(item.namespace??null)===(plugin.namespace??null));
    const record=ghost?this.options.host.identity.record(ghost):null;
    const snapshot=ghost?readInstalledGhostManifestSnapshot(ghost.dir,512*1024):null;
    const matches=!!record?.installed&&(record.source==='market'||record.source==='legacy-adopted')&&record.pluginId===plugin.id&&record.ghostId===plugin.ghostId&&record.scope===plugin.scope&&record.organizationId===plugin.organizationId&&(record.namespace??null)===(plugin.namespace??null)&&!!snapshot?.ok&&verifyInstalledMarketManifest(record,installedMarketManifestIdentity(snapshot.snapshot),{allowLegacyRecordWithoutDigest:true});
    return {pluginId:plugin.id,ghostId:plugin.ghostId,namespace:plugin.namespace??null,name:plugin.name,description:plugin.description,author:plugin.author,scope:plugin.scope,organizationId:plugin.organizationId,defaultInstall:plugin.defaultInstall,releaseId:plugin.currentRelease.id,version:plugin.currentRelease.version,publishedAt:plugin.currentRelease.publishedAt,icon:plugin.currentRelease.icon,installState:ghost&&!matches?'conflict':!matches?'not-installed':record?.releaseId===plugin.currentRelease.id?'installed':'update-available',enabled:matches?ghost?.enabled??null:null,sourceType:'server',sourceMarketName:null,...(plugin.usageStatistics?{usageStatistics:plugin.usageStatistics}:{}),...(plugin.downloadStatistics?{downloadStatistics:plugin.downloadStatistics}:{})};
  }
  async snapshot():Promise<PluginMarketSnapshot>{
    try{const catalog=await this.list();return {items:catalog.plugins.map(plugin=>this.item(plugin)),unavailableReason:null,customSourceNames:[],unavailableCustomSourceNames:[],organizationAccessError:catalog.organizationAccessError?.code??null};}
    catch{this.guard();return {items:[],unavailableReason:this.options.account.membership()?'PLUGIN_API_ERROR':'not-configured',customSourceNames:[],unavailableCustomSourceNames:[]};}
  }
  async detail(id:string):Promise<PluginMarketDetail>{this.guard();const plugin=await this.options.account.market.detail(id);this.guard();const parsed=validateNormalizedGhostManifest(plugin.currentRelease.manifest);if(!parsed.ok)throw Object.assign(new Error('GHOST_FILE_INVALID'),{code:'GHOST_FILE_INVALID'});return {...this.item(plugin),manifest:parsed.manifest};}
  async install(id:string,options:PluginMarketInstallOptions,prompt:GhostInstallConsentPrompt,current:()=>void,scope:()=>void){
    const controller=`management:${randomUUID()}`;let pending:string|undefined;
    try{
      current();const prepared=await this.prepare(id,options.expectedReleaseId,controller);pending=prepared.id;current();
      const entry=this.options.host.pendingInstall(prepared.id,controller);
      const receiver=entry.receiver?this.options.host.installed(entry.receiver):null;
      if((receiver?ghostInstallApprovalToken(receiver.approval):undefined)!==options.expectedInstalledApproval||entry.sourceChanged&&!options.allowSourceReplacement)throw new Error('PLUGIN_CHANGED');
      if(!await prompt({facts:prepared.facts,initiator:'user',origin:'market',target:prepared.target}))throw Object.assign(new Error('MUTATION_CANCELLED'),{code:'MUTATION_CANCELLED'});
      current();await this.options.host.confirmInstall(prepared.id,controller,scope);
    }finally{if(pending)await this.discard(pending,controller);}
  }
  private async prune(){
    await privateDirectory(this.directory);this.guard();
    for(const name of await readdir(this.directory)){
      if(!/^[a-f0-9-]{36}\.cindy$/.test(name))continue;
      const file=path.join(this.directory,name);const info=await stat(file);this.guard();
      if(info.mtimeMs<Date.now()-30*60_000)await rm(file,{force:true});
    }
    for(const [id,entry] of this.files)if(entry.expiresAt<Date.now()){await rm(entry.file,{force:true});this.files.delete(id);}
  }
  async prepare(pluginId:string,releaseId:string|undefined,controller:string,signal?:AbortSignal){
    this.guard();await this.prune();
    const catalog=await this.list();this.guard();signal?.throwIfAborted();
    const listed=catalog.plugins.find(item=>item.id===pluginId);if(!listed)throw new Error('PLUGIN_MARKET_NOT_FOUND');
    const plugin=await this.options.account.market.detail(pluginId);this.guard();signal?.throwIfAborted();
    const release=plugin.currentRelease;
    if(plugin.id!==listed.id||plugin.ghostId!==listed.ghostId||plugin.scope!==listed.scope||plugin.namespace!==listed.namespace||plugin.organizationId!==listed.organizationId||release.id!==listed.currentRelease.id||release.sha256!==listed.currentRelease.sha256||(releaseId!==undefined&&release.id!==releaseId))throw new Error('PLUGIN_MARKET_RELEASE_CHANGED');
    if(plugin.scope==='organization'&&(plugin.organizationId!==this.options.account.membership()?.orgId||!plugin.namespace||plugin.namespace!==catalog.currentOrganization?.orgSlug))throw new Error('PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE');
    const delivery=await this.options.account.market.download(plugin.id,release.id);this.guard();signal?.throwIfAborted();
    if(delivery.sha256!==release.sha256||delivery.sizeBytes!==release.sizeBytes||delivery.sizeBytes>MAX_NODE_CINDY_FILE_BYTES||Date.parse(delivery.expiresAt)<=Date.now()||!downloadIdentityMatchesPlugin(delivery,plugin)||(delivery.releaseId!==undefined&&delivery.releaseId!==release.id))throw new Error('PLUGIN_MARKET_DOWNLOAD_CHANGED');
    const file=path.join(this.directory,`${randomUUID()}.cindy`);
    const combined=AbortSignal.any([this.abort.signal,AbortSignal.timeout(120_000),...(signal?[signal]:[])]);
    const check=()=>{combined.throwIfAborted();this.guard();};
    let prepared:string|undefined;
    try{
      const {response,release:releaseConnection}=await (this.options.download??fetchWithSsrFGuard)({url:delivery.url,requireHttps:true,maxRedirects:5,signal:combined,beforeDispatch:check});
      try{
        check();if(!response.ok||!response.body)throw new Error('PLUGIN_MARKET_DOWNLOAD_FAILED');
        const length=response.headers.get('content-length');if(length!==null&&Number(length)!==delivery.sizeBytes)throw new Error('PLUGIN_MARKET_PACKAGE_MISMATCH');
        const handle=await open(file,'wx',0o600),reader=response.body.getReader(),hash=createHash('sha256');let size=0;
        try{
          for(;;){check();const part=await reader.read();check();if(part.done)break;size+=part.value.length;if(size>delivery.sizeBytes)throw new Error('PLUGIN_MARKET_PACKAGE_MISMATCH');hash.update(part.value);await handle.writeFile(part.value);}
          if(size!==delivery.sizeBytes||hash.digest('hex')!==delivery.sha256)throw new Error('PLUGIN_MARKET_PACKAGE_MISMATCH');await handle.sync();
        }finally{await reader.cancel().catch(()=>{});reader.releaseLock();await handle.close();}
      }finally{await releaseConnection();}
      check();
      const record:PluginMarketInstallationRecord={pluginId:plugin.id,ghostId:plugin.ghostId,releaseId:release.id,version:release.version,sha256:release.sha256,scope:plugin.scope,organizationId:plugin.organizationId,namespace:plugin.namespace??null,source:'market',installed:true,updatedAt:new Date().toISOString(),serverRoot:this.options.account.serverRoot()};
      const pending=await this.options.host.prepareInstall(file,controller,{namespace:record.namespace},catalog.currentOrganization?.orgSlug??null,record);prepared=pending.id;check();
      this.files.set(pending.id,{file,expiresAt:pending.expiresAt});return pending;
    }catch(error){if(prepared)try{this.options.host.cancelInstall(prepared,controller);}catch{/* Already consumed or owner changed. */}await rm(file,{force:true});throw error;}
  }
  async discard(id:string,controller:string){
    try{this.options.host.cancelInstall(id,controller);}catch{/* A completed install already consumed the prompt. */}
    const item=this.files.get(id);if(item){this.files.delete(id);await rm(item.file,{force:true});}
  }
  task(context:PluginTaskContext,requestPermission:HostPermissionRequester,translate:(key:string)=>string):Pick<CindyGhostsMcpDeps,'searchMarket'|'installMarket'>{
    return {searchMarket:async query=>{context.assertCurrent();const catalog=await this.list(query);context.assertCurrent();return {ok:true,plugins:catalog.plugins.map(plugin=>({pluginId:plugin.id,id:plugin.ghostId,name:plugin.name,description:plugin.description,namespace:plugin.namespace??null,scope:plugin.scope,version:plugin.currentRelease.version,releaseId:plugin.currentRelease.id})),...(catalog.organizationAccessError?{organizationAccessError:catalog.organizationAccessError}:{})};},
      installMarket:async(request,signal)=>{
        // Factories are composed before Maker creates the native session. Bind
        // the confirmation to its incarnation only when an install is invoked.
        context.assertCurrent();const controller=`task:${context.sessionId}:${context.instanceId()}`;
        let pending:string|undefined;
        try{
          context.assertCurrent();const prepared=await this.prepare(request.pluginId,request.releaseId,controller,signal);pending=prepared.id;context.assertCurrent();
          const decision=await requestPermission(context.sessionId,context.instanceId(),buildGhostInstallConsentInteraction(randomUUID(),{facts:prepared.facts,initiator:'agent',origin:'market',target:prepared.target},translate),signal??this.abort.signal);context.assertCurrent();
          if(decision?.kind!=='permission'||decision.behavior!=='allow')return {ok:false,errorCode:'MUTATION_CANCELLED'};
          const ghost=await this.options.host.confirmInstall(prepared.id,controller,()=>{context.assertCurrent();signal?.throwIfAborted();});
          return {ok:true,instanceId:installedGhostStoragePart(ghost),id:ghost.manifest.id,name:ghost.manifest.name,namespace:ghost.namespace??null,version:ghost.manifest.version,enabled:ghost.enabled};
        }finally{if(pending)await this.discard(pending,controller);}
      }};
  }
  register(registry:RemoteResourceRegistry){
    const project=(plugin:Awaited<ReturnType<TerminalPluginAccount['catalog']>>['plugins'][number])=>{
      const installed=this.options.host.native.list().find(item=>item.manifest.id===plugin.ghostId&&(item.namespace??null)===(plugin.namespace??null));
      const record=installed?this.options.host.identity.record(installed):null;
      return {ref:ref(plugin.id),revision:plugin.currentRelease.id,display:{title:plugin.name,subtitle:[plugin.namespace,plugin.currentRelease.version].filter(Boolean).join(' · ')},links:[],
        blocks:[{id:'description',primitive:'text' as const,fallbackMarkdown:plugin.description??''}],actions:record?.installed&&record.releaseId===plugin.currentRelease.id?[]:[{id:`install:${plugin.currentRelease.id}`,label:label(installed?'update':'install')}]};
    };
    registry.register({collection:{id:'plugin-market',resourceKind:'market-plugin',title:label('title'),placement:'settings',actions:[]},
      list:async(_context,request)=>{const catalog=await this.list(request.query);const offset=request.cursor===undefined?0:Number(request.cursor),limit=Math.min(request.limit??100,200);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw new Error('INVALID_CURSOR');return {collectionId:'plugin-market',revision:catalog.plugins.map(p=>p.currentRelease.id).join(','),items:catalog.plugins.slice(offset,offset+limit).map(project),...(offset+limit<catalog.plugins.length?{nextCursor:String(offset+limit)}:{})};},
      get:async(_context,request)=>{const catalog=await this.list();const plugin=catalog.plugins.find(item=>item.id===request.ref.id);if(!plugin)throw new Error('PLUGIN_MARKET_NOT_FOUND');return project(plugin);},
      invoke:async(context,request)=>{context.assertCurrent?.();if(!request.actionId.startsWith('install:')||!request.resourceRef)throw new Error('INVALID_ACTION');const prepared=await this.prepare(request.resourceRef.id,request.actionId.slice(8),context.controllerDeviceId);context.assertCurrent?.();return {effects:[{kind:'navigate',target:{kind:'resource',ref:{collectionId:'plugins',kind:'plugin',id:`install:${prepared.id}`}}}]};},
    });
  }
  async close(){this.abort.abort();await Promise.allSettled([...this.files.values()].map(item=>rm(item.file,{force:true})));this.files.clear();}
}
