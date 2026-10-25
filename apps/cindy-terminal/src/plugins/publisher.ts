import { PluginPublisherOrchestrator, type PluginPublisherOrchestratorDeps } from '@cindy/plugin-runtime/publisher/orchestrator';
import { createForgePackStagingController } from '@cindy/plugin-runtime/forgePackStaging';
import { consumeForgePackForPublish } from '@cindy/plugin-runtime/forgePackPublishConsume';
import type { PluginOwner } from '@cindy/plugin-runtime/owner';
import type { InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import type { CindyForgePublishResult, CindyForgePublishStatusResult } from 'cindy-tools';
import type { TerminalPluginAccount } from './account.js';
import type { TerminalPlugins } from './host.js';

/** Native adapter around the shared publisher. A one-use ticket binds the exact
 * packaged bytes and owner; author workdir paths never become upload sources. */
export class TerminalPluginPublisher {
  readonly transfers: PluginPublisherOrchestrator;
  private readonly staging: ReturnType<typeof createForgePackStagingController>;
  private closed=false;
  constructor(private readonly options:{
    stagingDirectory:string;host:TerminalPlugins;account:TerminalPluginAccount;
    owner():PluginOwner;assertCurrent():void;
    onProgress?:PluginPublisherOrchestratorDeps['onProgress'];
  }){
    this.staging=createForgePackStagingController({getTempDir:()=>options.stagingDirectory});
    this.transfers=new PluginPublisherOrchestrator({api:options.account.publisher,owner:options.owner,
      identity:()=>{this.guard();return options.account.publisherIdentity();},
      inspectPackage:async file=>{this.guard();const result=await options.host.native.manager.inspect(file);this.guard();if('rejection' in result)throw new Error('PLUGIN_PACKAGE_REJECTED');return {ghostId:result.manifest.id,name:result.manifest.name,version:result.manifest.version};},
      confirm:async()=>false,onProgress:options.onProgress,
    });
  }
  private guard(){if(this.closed)throw new Error('PLUGIN_PUBLISHER_CLOSED');this.options.assertCurrent();}
  stage(buf:Buffer,manifestId:string,installed:InstalledGhost[]){
    this.guard();return this.staging.stage({buf,manifestId,owner:this.options.owner(),operationKind:installed.some(ghost=>ghost.manifest.id===manifestId)?'update':'install'}).ticket;
  }
  async publish(token:string,confirm:PluginPublisherOrchestratorDeps['confirm']):Promise<CindyForgePublishResult>{
    this.guard();const consumed=consumeForgePackForPublish(this.staging,{token,currentOwner:this.options.owner(),boundaryPending:false});
    if(consumed.kind==='rejected')return {ok:false,errorCode:consumed.reason==='owner-mismatch'?'PUBLISH_TOKEN_OWNER_MISMATCH':'PUBLISH_TOKEN_INVALID',message:'Publish ticket expired or was already used. Pack the source again with intent=publish.'};
    const {ticket}=consumed;
    try{
      const identity=await this.options.account.publisherIdentity();this.guard();
      if(!identity){this.staging.releaseStaging(ticket.stagingPath);return {ok:false,errorCode:'NOT_ORG_MEMBER',message:'An organization membership is required to publish plugins.'};}
      const started=this.transfers.start(ticket.stagingPath,{confirm:async(facts,signal)=>{this.guard();const approved=await confirm(facts,signal);this.guard();return approved;},sourceBinding:{manifestId:ticket.manifestId,packageSha256:ticket.packageSha256,onTerminal:()=>this.staging.releaseStaging(ticket.stagingPath)}});
      return {ok:true,...started,note:'Waiting for confirmation. Query ghost_forge_publish_status for upload and review progress.'};
    }catch(error){this.staging.releaseStaging(ticket.stagingPath);throw error;}
  }
  async status(transferId:string):Promise<CindyForgePublishStatusResult>{
    this.guard();if(!this.transfers.snapshotForOwner(transferId,this.options.owner()))return {ok:false,errorCode:'NOT_FOUND',message:'Publish transfer not found.'};
    const progress=await this.transfers.refreshReviewStatus(transferId);this.guard();
    return progress?{ok:true,...progress}:{ok:false,errorCode:'NOT_FOUND',message:'Publish transfer not found.'};
  }
  close(){if(this.closed)return;this.closed=true;this.transfers.abortAll();this.staging.invalidateAll();}
}
