import type { RemoteActionDescriptor, RemoteCollectionDescriptor, RemoteResource } from '@cindy/device-link';
import { parseRemoteActionInvokeRequest } from '@cindy/device-link';
import type { TerminalClient } from './contracts.js';
import type { Locale } from './ui/i18n.js';
import { submitPluginSecret } from './plugins/secret-form.js';
import { submitConfiguration } from './configuration.js';
import { unwrap } from './client-operations.js';

/** All terminal entry points share the protected handling of sensitive forms. */
export async function invokeResourceAction(client:TerminalClient,raw:Omit<import('@cindy/device-link').RemoteActionInvokeRequest,'input'>&{input?:unknown},device?:string):Promise<import('@cindy/device-link').RemoteActionInvokeResponse>{
  const request=parseRemoteActionInvokeRequest(raw);if(!request)throw new Error('INVALID_RESOURCE_ACTION');
  if(request.collectionId==='plugins'&&request.resourceRef&&request.actionId==='credentials')return submitPluginSecret(client,request.resourceRef.id,request.input,device);
  if(request.collectionId==='mcp'&&(request.actionId==='create'||request.actionId==='edit'))return submitConfiguration(client,{collectionId:'mcp',actionId:request.actionId,...(request.resourceRef?{resourceId:request.resourceRef.id}:{})},request.input,device);
  if(request.collectionId==='channels'&&request.actionId==='edit'&&request.resourceRef)return submitConfiguration(client,{collectionId:'channels',actionId:'edit',resourceId:request.resourceRef.id},request.input,device);
  if(request.collectionId==='channels'&&request.actionId==='connect'&&request.resourceRef?.id==='feishu'){
    const input=request.input as {service?:unknown}|undefined;
    return {effects:[],result:await client.invoke('terminal:channel-registration',[{command:'begin',service:input?.service,...(device?{deviceId:device}:{})}])};
  }
  return unwrap(await client.invoke('maker:remote-resources:invoke',[request],device)) as import('@cindy/device-link').RemoteActionInvokeResponse;
}

export const resourceCollections:Record<string,string>={
  "local-models": "local-models",
  'auxiliary-models': 'auxiliary-models',
  'teammate-models': 'teammate-models',
  worktrees:'worktrees',teammates:'teammates',routines:'routines',schedules:'schedules',projects:'projects',plugins:'plugins','plugin-market':'plugin-market',libraries:'plugin-libraries',skills:'skills',
  mcp:'mcp',channels:'channels',memory:'memory',contacts:'contacts',shares:'provider-shares','provider-groups':'provider-groups',
};

/** Named commands consume the same advertised actions as TUI/GUI. Resource
 * kinds and operation IDs come from the target host, including older hosts. */
export async function runResourceCommand(client:TerminalClient,options:{collection:string;operation:string;id?:string;input?:unknown;device?:string;locale:Locale;cursor?:string;limit?:number;query?:string}){
  const descriptor={protocolVersion:1,primitives:['text','actions','session-controls'],locale:options.locale};
  const call=async <T>(name:string,args:Record<string,unknown>)=>unwrap(await client.invoke(`maker:remote-resources:${name}`,[{client:descriptor,...args}],options.device)) as T;
  const manifest=await call<{collections:RemoteCollectionDescriptor[]}>('manifest',{});
  const collection=manifest.collections.find(item=>item.id===options.collection);
  if(!collection)throw new Error('CAPABILITY_NOT_AVAILABLE_ON_TARGET');
  if(options.operation==='list'||options.operation==='search')return call('list',{collectionId:collection.id,limit:options.limit??100,...(options.cursor?{cursor:options.cursor}:{}),...(options.query?{query:options.query}:{})});
  let resource:RemoteResource|undefined;
  if(options.id){
    // Child resources (plugin pages, background tasks and model details) are
    // reachable by links without appearing in the root collection. The host's
    // advertised kind and authenticated get handler define their identity.
    resource=await call<RemoteResource>('get',{ref:{collectionId:collection.id,kind:collection.resourceKind,id:options.id}});
  }
  if(options.operation==='get'||options.operation==='show'){
    if(!resource)throw new Error('RESOURCE_ID_REQUIRED');return resource;
  }
  const actions:RemoteActionDescriptor[]=resource?.actions??collection.actions??[];
  const versioned=actions.filter(item=>item.id.startsWith(options.operation+':'));
  const action=actions.find(item=>item.id===options.operation)??(versioned.length===1?versioned[0]:undefined);
  if(!action)throw new Error('ACTION_NOT_AVAILABLE_ON_TARGET');
  if(action.disabled)throw new Error('RESOURCE_ACTION_DISABLED');
  const forms=resource?.blocks?.filter(block=>block.primitive==='form').map(block=>block.data).filter((data):data is Record<string,unknown>=>!!data&&typeof data==='object'&&!Array.isArray(data));
  const defaults=forms?.find(data=>data.actionId===action.id)?.values;
  const input=defaults&&typeof defaults==='object'&&!Array.isArray(defaults)&&(!options.input||typeof options.input==='object'&&!Array.isArray(options.input))?{...defaults,...options.input as object}:options.input??{};
  return invokeResourceAction(client,{client:descriptor,collectionId:collection.id,actionId:action.id,...(resource?{resourceRef:resource.ref}:{}),input},options.device);
}
