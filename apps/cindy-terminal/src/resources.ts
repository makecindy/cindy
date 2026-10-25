import {
  RemoteResourceRegistry, RemoteResourceRegistryError, parseRemoteActionInvokeRequest, parseRemoteCollectionListRequest,
  parseRemoteResourceGetRequest, parseRemoteResourceManifestRequest,
  type RemoteCollectionItem, type RemoteResource,
} from '@cindy/device-link';
import type { InvocationContext } from './contracts.js';
import type { TerminalTaskHost } from './tasks/index.js';
import { TerminalRemoteError } from './remote/types.js';
import { modelResourceId } from './client-operations.js';

/** Existing remote resource protocol, also used by the local TUI. */
export class TerminalResources {
  readonly registry = new RemoteResourceRegistry();
  private active=true;
  private selections=new Map<string,{providerId:string;agentKind:string;model:string}>();
  constructor(private tasks: TerminalTaskHost) {
    this.registry.register({
      collection: {id:'models',resourceKind:'model',title:{fallback:'Models',translations:{'zh-CN':'模型','zh-TW':'模型',ja:'モデル',ko:'모델'}},placement:'settings'},
      list: async (_context,request)=>{
        const models=await this.models();
        const start=request.cursor?Number(request.cursor):0;
        if(!Number.isInteger(start)||start<0||start>models.length)throw new Error('INVALID_CURSOR');
        const limit=Math.max(1,Math.min(request.limit??100,100));
        const items=models.slice(start,start+limit);
        return {collectionId:'models',revision:JSON.stringify(this.tasks.models.snapshot().defaultSelection??null),items,...(start+limit<models.length?{nextCursor:String(start+limit)}:{})};
      },
      get: async (_context,request)=>{
        const model=(await this.models()).find(item=>item.ref.id===request.ref.id);
        if(!model)throw new Error('MODEL_ROUTE_UNAVAILABLE');
        return {...model,blocks:[{id:'model',primitive:'text',fallbackMarkdown:String(model.display.subtitle??'')}]} satisfies RemoteResource;
      },
      invoke: async (context,request)=>{
        if(request.actionId!=='use-default'||!request.resourceRef)throw new Error('INVALID_ACTION');
        const model=(await this.models()).find(item=>item.ref.id===request.resourceRef!.id);
        if(!model)throw new Error('MODEL_ROUTE_UNAVAILABLE');
        const selected=this.selections.get(model.ref.id);
        context.assertCurrent?.();
        await this.tasks.models.setDefault(selected,context.assertCurrent);
        return {effects:[{kind:'refresh-collection',collectionId:'models'},{kind:'refresh-resource',ref:model.ref}]};
      },
    });
  }
  private async models():Promise<RemoteCollectionItem[]> {
    const providers=await this.tasks.models.views();
    const selected=this.tasks.models.snapshot().defaultSelection;
    const items:RemoteCollectionItem[]=[];
    this.selections.clear();
    for(const provider of providers){
      for(const [agentKind,models] of Object.entries(provider.models)){
        for(const model of models??[]){
          if(model.disabled)continue;
          const selection={providerId:provider.id,agentKind,model:model.id};
          const id=modelResourceId(selection);
          this.selections.set(id,selection);
          const current=selected?.providerId===provider.id&&selected?.agentKind===agentKind&&selected?.model===model.id;
          items.push({ref:{collectionId:'models',kind:'model',id},links:[],revision:current?'default':'available',display:{title:model.name,subtitle:`${provider.name} · ${agentKind}`,
            ...(current?{status:{label:{fallback:'Default',translations:{'zh-CN':'默认','zh-TW':'預設',ja:'既定',ko:'기본'}},tone:'positive'}}:{})},
            actions:[{id:'use-default',label:{fallback:'Use as default',translations:{'zh-CN':'设为默认','zh-TW':'設為預設',ja:'既定に設定',ko:'기본으로 설정'}},disabled:current}]});
        }
      }
    }
    return items;
  }
  async invoke(channel:string,args:unknown[],context:InvocationContext){
    context.assertCurrent?.();
    const host={controllerDeviceId:context.deviceId??'local',assertCurrent:()=>{
      if(!this.active)throw new Error('OWNER_CHANGED');
      context.assertCurrent?.();
    }};
    const raw=args[0];
    try { switch(channel){
      case 'maker:remote-resources:manifest':{const request=parseRemoteResourceManifestRequest(raw);if(!request)throw new Error('INVALID_PARAMS');return await this.registry.manifest(host,request);}
      case 'maker:remote-resources:list':{const request=parseRemoteCollectionListRequest(raw);if(!request)throw new Error('INVALID_PARAMS');return await this.registry.list(host,request);}
      case 'maker:remote-resources:get':{const request=parseRemoteResourceGetRequest(raw);if(!request)throw new Error('INVALID_PARAMS');return await this.registry.get(host,request);}
      case 'maker:remote-resources:invoke':{const request=parseRemoteActionInvokeRequest(raw);if(!request)throw new Error('INVALID_PARAMS');return await this.registry.invoke(host,request);}
      default:throw new Error('CHANNEL_NOT_ALLOWED');
    }}catch(error){
      // Forward declared protocol failures only; never filesystem paths, native
      // exception messages or arbitrary plugin text through the remote channel.
      if(error instanceof RemoteResourceRegistryError)throw new TerminalRemoteError(error.code,error.code);
      const code=error instanceof Error?error.message:'';
      if(['PLUGIN_SETTINGS_CHANGED','PLUGIN_SETTINGS_INVALID','PLUGIN_CHANGED','INVALID_PARAMS'].includes(code))throw new TerminalRemoteError(code,code);
      throw error;
    }
  }
  close(){this.active=false;this.selections.clear();}
}
